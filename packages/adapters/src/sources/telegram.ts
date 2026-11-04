import { MediaError } from '@media-ingest/sdk';
import { safeName } from '../files.js';
import { sourceUrl, checkedFetch, saveResponse } from './service-http.js';
import type { SourceDriver } from './download.js';

export function telegramReference(uri: string): { chat: string; message: number } {
  const url = sourceUrl(uri);
  if (url.protocol === 'tg:') {
    const ref = /^tg:\/\/chat\/(-?[1-9]\d*)\/([1-9]\d*)\/?$/.exec(uri);
    if (!ref || !Number.isSafeInteger(Number(ref[2])))
      throw new MediaError('invalid_input', 'Expected tg://chat/<chat-id>/<message-id>');
    return { chat: ref[1]!, message: Number(ref[2]) };
  }
  if (
    url.protocol !== 'https:' ||
    !['t.me', 'telegram.me'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new MediaError('invalid_input', 'Invalid Telegram URL');
  const post = /^\/(?:(?:c\/(\d+))|([\w]+))(?:\/[1-9]\d*)?\/([1-9]\d*)\/?$/.exec(url.pathname);
  const message = Number(post?.[3]);
  if (!post || post[2] === 'c' || !Number.isSafeInteger(message) || url.searchParams.has('comment'))
    throw new MediaError('invalid_input', 'Expected a single Telegram post');
  const chat = post[1] ? `-100${post[1]}` : `@${post[2]}`;
  return { chat, message };
}

export function telegramSource(baseUrl?: string, token?: string): SourceDriver {
  function telegramUrl(path: string): string {
    if (!baseUrl) throw new Error('Telegram source requires TELEGRAM_PROXY_URL');
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
      throw new Error('Invalid Telegram proxy configuration');
    return `${base.href.replace(/\/$/, '')}${path}`;
  }
  function telegramHeaders(): Record<string, string> {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  return {
    async resolve(source, { signal }) {
      const { chat, message } = telegramReference(source.uri);
      const headers = telegramHeaders();
      let chatId = chat;
      if (chat.startsWith('@')) {
        const response = await checkedFetch(
          telegramUrl(`/resolve?value=${encodeURIComponent(chat)}`),
          { signal, headers },
        );
        const data = await response.json();
        chatId = data?.data?.peer?.id;
      }
      if (typeof chatId !== 'string' || !/^-?[1-9]\d*$/.test(chatId))
        throw new Error('Telegram chat was not resolved');
      const manifest = await checkedFetch(
        telegramUrl(`/chats/${chatId}/messages/${message}/media?include_album=false`),
        { signal, headers },
      );
      const media = (await manifest.json()) as {
        data?: Array<{
          media_id: string;
          message_id: string;
          kind: string;
          file_name?: string;
          mime_type?: string;
        }>;
      };
      const items = Array.isArray(media.data)
        ? media.data.filter(
            (item) =>
              item?.message_id === String(message) &&
              typeof item.media_id === 'string' &&
              new RegExp(`^${message}:[0-9]+$`).test(item.media_id) &&
              (['voice', 'audio', 'video', 'video_note', 'gif', 'photo'].includes(item.kind) ||
                (item.kind === 'document' &&
                  /^(audio|video|image)\/[\w.+-]+$/i.test(item.mime_type ?? ''))),
          )
        : [];
      if (items.length !== 1)
        throw new Error('Telegram post must contain exactly one supported media item');
      const item = items[0]!;
      const mimeType = /^(audio|video|image)\/[\w.+-]+$/i.test(item.mime_type ?? '')
        ? item.mime_type
        : (
            { voice: 'audio/ogg', photo: 'image/jpeg', video_note: 'video/mp4' } as Record<
              string,
              string
            >
          )[item.kind];
      return {
        source,
        fileName: safeName(item.file_name || `telegram-${item.kind}`),
        ...(mimeType ? { mimeType } : {}),
        metadata: { chatId, message, mediaId: item.media_id },
      };
    },
    async download(resolved, { signal }, target) {
      const { chatId, message, mediaId } = resolved.metadata;
      if (
        typeof chatId !== 'string' ||
        !/^-?[1-9]\d*$/.test(chatId) ||
        typeof message !== 'number' ||
        !Number.isSafeInteger(message) ||
        message <= 0 ||
        typeof mediaId !== 'string' ||
        !new RegExp(`^${message}:[0-9]+$`).test(mediaId)
      )
        throw new Error('Invalid resolved Telegram media reference');
      const response = await checkedFetch(
        telegramUrl(
          `/chats/${encodeURIComponent(String(chatId))}/messages/${encodeURIComponent(String(message))}/media/${encodeURIComponent(String(mediaId))}`,
        ),
        { signal, headers: telegramHeaders() },
      );
      return saveResponse(response, target, signal);
    },
  };
}
