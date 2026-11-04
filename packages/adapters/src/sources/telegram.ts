import { MediaError, type AdapterContext } from '@media-ingest/sdk';
import type { Source, ResolvedSource } from '@media-ingest/contracts';
import { safeName } from '../files.js';
import { sourceUrl, checkedFetch, saveResponse } from './service-http.js';
import { DownloadSource, type DownloadOptions, type DownloadTarget } from './download.js';

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

interface TelegramMediaItem {
  media_id: string;
  message_id: string;
  kind: string;
  file_name?: string;
  mime_type?: string;
}

const mediaMime = /^(audio|video|image)\/[\w.+-]+$/i;
const defaultMime: Record<string, string | undefined> = {
  voice: 'audio/ogg',
  photo: 'image/jpeg',
  video_note: 'video/mp4',
};

function matchesMediaId(id: unknown, message: number): id is string {
  return typeof id === 'string' && new RegExp(`^${message}:[0-9]+$`).test(id);
}

function selectMedia(items: TelegramMediaItem[] | undefined, message: number): TelegramMediaItem {
  const matches = Array.isArray(items)
    ? items.filter(
        (item) =>
          item?.message_id === String(message) &&
          matchesMediaId(item.media_id, message) &&
          (['voice', 'audio', 'video', 'video_note', 'gif', 'photo'].includes(item.kind) ||
            (item.kind === 'document' && mediaMime.test(item.mime_type ?? ''))),
      )
    : [];
  if (matches.length !== 1)
    throw new Error('Telegram post must contain exactly one supported media item');
  return matches[0]!;
}

export class TelegramSource extends DownloadSource {
  readonly kind = 'telegram';
  constructor(
    options: DownloadOptions,
    private readonly baseUrl?: string,
    private readonly token?: string,
  ) {
    super(options);
  }
  private telegramUrl(path: string): string {
    if (!this.baseUrl) throw new Error('Telegram source requires TELEGRAM_PROXY_URL');
    const base = new URL(this.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
      throw new Error('Invalid Telegram proxy configuration');
    return `${base.href.replace(/\/$/, '')}${path}`;
  }
  private telegramHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }
  protected async resolveSource(source: Source, { signal }: AdapterContext) {
    const { chat, message } = telegramReference(source.uri);
    const headers = this.telegramHeaders();
    let chatId = chat;
    if (chat.startsWith('@')) {
      const response = await checkedFetch(
        this.telegramUrl(`/resolve?value=${encodeURIComponent(chat)}`),
        { signal, headers },
      );
      const data = await response.json();
      chatId = data?.data?.peer?.id;
    }
    if (typeof chatId !== 'string' || !/^-?[1-9]\d*$/.test(chatId))
      throw new Error('Telegram chat was not resolved');
    const manifest = await checkedFetch(
      this.telegramUrl(`/chats/${chatId}/messages/${message}/media?include_album=false`),
      { signal, headers },
    );
    const media = (await manifest.json()) as { data?: TelegramMediaItem[] };
    const item = selectMedia(media.data, message);
    const mimeType = mediaMime.test(item.mime_type ?? '') ? item.mime_type : defaultMime[item.kind];
    return {
      source,
      fileName: safeName(item.file_name || `telegram-${item.kind}`),
      ...(mimeType ? { mimeType } : {}),
      metadata: { chatId, message, mediaId: item.media_id },
    };
  }
  protected async download(
    resolved: ResolvedSource,
    { signal }: AdapterContext,
    target: DownloadTarget,
  ) {
    const { chatId, message, mediaId } = resolved.metadata;
    if (
      typeof chatId !== 'string' ||
      !/^-?[1-9]\d*$/.test(chatId) ||
      typeof message !== 'number' ||
      !Number.isSafeInteger(message) ||
      message <= 0 ||
      !matchesMediaId(mediaId, message)
    )
      throw new Error('Invalid resolved Telegram media reference');
    const response = await checkedFetch(
      this.telegramUrl(`/chats/${chatId}/messages/${message}/media/${encodeURIComponent(mediaId)}`),
      { signal, headers: this.telegramHeaders() },
    );
    return saveResponse(response, target, signal);
  }
}
