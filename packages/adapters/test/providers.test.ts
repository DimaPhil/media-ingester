import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeProviders, parseChunk, parseModelJson, parseOpenAi } from '../src/providers.js';
import type { MediaRequest } from '@media-ingest/contracts';

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return 'google-token';
    }
  },
}));

const request: MediaRequest = {
  kind: 'transcription',
  source: { kind: 'http', uri: 'https://example.com/a' },
  provider: 'openai',
};
const context = {
  ownerId: 'owner',
  jobId: 'job',
  attempt: 1,
  signal: new AbortController().signal,
};
const roots: string[] = [];
async function artifact() {
  const root = await mkdtemp(join(tmpdir(), 'provider-'));
  roots.push(root);
  const uri = join(root, 'audio.mp3');
  await writeFile(uri, 'fake audio');
  return { uri, fileName: 'audio.mp3', mimeType: 'audio/mpeg', fingerprint: 'hash' };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('provider normalization', () => {
  it('selects native video for Gemini and audio for audio-only providers and sources', () => {
    const provider = new NodeProviders();
    const video = { durationMs: 1000, hasAudio: true, hasVideo: true };
    const audio = { ...video, hasVideo: false };
    for (const kind of ['transcription', 'understanding'] as const) {
      const geminiRequest = { ...request, provider: 'google-gemini' as const, kind };
      expect(provider.inputFormat(geminiRequest, video)).toBe('video');
      expect(provider.inputFormat(geminiRequest, audio)).toBe('audio');
    }
    expect(provider.inputFormat(request, video)).toBe('audio');
    expect(provider.inputFormat({ ...request, provider: 'google-speech' }, video)).toBe('audio');
  });

  it('sends the video MIME type through Gemini upload and transcription generation', async () => {
    const file = { ...(await artifact()), fileName: 'clip.mp4', mimeType: 'video/mp4' };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          file: {
            name: 'files/video',
            uri: 'gs://video',
            mimeType: 'video/mp4',
            state: 'ACTIVE',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '{"text":"spoken words","detectedLanguage":"en","segments":[]}',
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetcher);
    const output = await new NodeProviders({ geminiApiKey: 'test' }).process(
      file,
      { ...request, provider: 'google-gemini' },
      context,
    );
    expect(output.text).toBe('spoken words');
    expect(fetcher.mock.calls[0]![1].headers['x-goog-upload-header-content-type']).toBe(
      'video/mp4',
    );
    expect(fetcher.mock.calls[1]![1].headers['content-type']).toBe('video/mp4');
    const generated = JSON.parse(fetcher.mock.calls[2]![1].body);
    expect(generated.contents[0].parts[0].text).toContain('Transcribe in the source language');
    expect(generated.contents[0].parts[1].file_data).toEqual({
      mime_type: 'video/mp4',
      file_uri: 'gs://video',
    });
    expect(fetcher.mock.calls[3]![1].method).toBe('DELETE');
  });

  it('uses Google Speech v2 regional endpoint and normalizes fractional timestamps', async () => {
    const file = await artifact();
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        results: [
          {
            languageCode: 'en',
            alternatives: [
              { transcript: 'hello', words: [{ startOffset: '0.125s', endOffset: '1.250s' }] },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const provider = new NodeProviders({
      googleRecognizer: 'projects/test/locations/us/recognizers/_',
    });
    const output = await provider.process(
      file,
      { ...request, provider: 'google-speech', inputLanguage: 'en-US' },
      context,
    );
    expect(output.segments[0]).toEqual({ startMs: 125, endMs: 1250, text: 'hello' });
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://us-speech.googleapis.com/v2/projects/test/locations/us/recognizers/_:recognize',
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1].body).config.languageCodes).toEqual(['en-US']);
    await expect(
      new NodeProviders({ googleRecognizer: '../secret' }).process(
        file,
        { ...request, provider: 'google-speech' },
        context,
      ),
    ).rejects.toThrow('recognizer');
  });
  it('waits for Gemini file activation before generating and cleans it afterward', async () => {
    const file = await artifact();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session',
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ file: { name: 'files/abc', state: 'PROCESSING' } }))
      .mockResolvedValueOnce(
        Response.json({ name: 'files/abc', state: 'ACTIVE', uri: 'gs://file' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          candidates: [{ content: { parts: [{ text: '{"text":"scene","timeRanges":[]}' }] } }],
        }),
      )
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetcher);
    expect(
      (
        await new NodeProviders({ geminiApiKey: 'test' }).process(
          file,
          { ...request, provider: 'google-gemini', kind: 'understanding', prompt: 'Describe' },
          context,
        )
      ).text,
    ).toBe('scene');
    expect(fetcher.mock.calls[2]![0]).toContain('/v1beta/files/abc');
  });
  it('validates output and preserves millisecond offsets', () => {
    expect(
      parseOpenAi({
        text: 'hi',
        language: 'en',
        segments: [{ start: 0.1, end: 1.25, text: 'hi', speaker: 'A' }],
      }),
    ).toEqual({
      text: 'hi',
      detectedLanguage: 'en',
      timeRanges: [],
      segments: [{ startMs: 100, endMs: 1250, text: 'hi', speaker: 'A' }],
    });
    expect(parseOpenAi({ text: 'hi' }).segments).toEqual([]);
    expect(() => parseOpenAi({})).toThrow();
    expect(() =>
      parseChunk({ text: 'x', segments: [{ startMs: -1, endMs: 1, text: 'x' }] }),
    ).toThrow();
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('uses per-capability defaults and short synchronous Google Speech chunks', () => {
    const provider = new NodeProviders();
    expect(provider.resolveModel(request)).toBe('gpt-4o-transcribe');
    expect(provider.resolveModel({ ...request, model: 'custom' })).toBe('custom');
    expect(
      provider.resolveModel({ ...request, provider: 'google-gemini', kind: 'understanding' }),
    ).toBe('gemini-2.5-pro');
    expect(provider.resolveModel({ ...request, provider: 'google-gemini' })).toBe(
      'gemini-2.5-flash',
    );
    expect(provider.chunkDurationMs({ ...request, provider: 'google-speech' })).toBe(55000);
    expect(provider.chunkDurationMs(request)).toBe(600000);
  });
  it('sends OpenAI multipart, validates results and rejects missing credentials', async () => {
    const file = await artifact();
    await expect(new NodeProviders().process(file, request, context)).rejects.toThrow(
      'OPENAI_API_KEY',
    );
    const fetcher = vi.fn().mockResolvedValue(Response.json({ text: 'heard' }));
    vi.stubGlobal('fetch', fetcher);
    expect(
      (
        await new NodeProviders({ openaiApiKey: 'test' }).process(
          file,
          { ...request, model: 'whisper-1', inputLanguage: 'en' },
          context,
        )
      ).text,
    ).toBe('heard');
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    const body = init.body as FormData;
    expect(body.get('response_format')).toBe('verbose_json');
    expect(body.get('language')).toBe('en');
    expect(init.redirect).toBe('error');
    fetcher.mockResolvedValue(new Response('', { status: 429 }));
    await expect(
      new NodeProviders({ openaiApiKey: 'test' }).process(file, request, context),
    ).rejects.toThrow('429');
    await expect(
      new NodeProviders().process(file, { ...request, kind: 'understanding' }, context),
    ).rejects.toThrow('Gemini');
  });
  it('cleans Gemini uploads after successful processing and malformed results', async () => {
    const file = await artifact();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          file: { name: 'files/abc', uri: 'gs://file', mimeType: 'audio/mpeg', state: 'ACTIVE' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          candidates: [
            { content: { parts: [{ text: '{"text":"hello","detectedLanguage":"en"}' }] } },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(null));
    vi.stubGlobal('fetch', fetcher);
    expect(
      (
        await new NodeProviders({ geminiApiKey: 'test' }).process(
          file,
          { ...request, provider: 'google-gemini' },
          context,
        )
      ).text,
    ).toBe('hello');
    expect(fetcher.mock.calls[3]![1].method).toBe('DELETE');
    fetcher
      .mockReset()
      .mockResolvedValueOnce(
        new Response(null, {
          headers: {
            'x-goog-upload-url': 'https://generativelanguage.googleapis.com/upload/session',
          },
        }),
      )
      .mockResolvedValueOnce(Response.json({ file: { name: 'files/abc', state: 'FAILED' } }))
      .mockResolvedValueOnce(new Response(null));
    await expect(
      new NodeProviders({ geminiApiKey: 'test' }).process(
        file,
        { ...request, provider: 'google-gemini' },
        context,
      ),
    ).rejects.toThrow('processing failed');
    expect(fetcher.mock.calls[2]![1].method).toBe('DELETE');
  });
  it('rejects upload redirects to unrelated hosts and translates with configured provider', async () => {
    const file = await artifact();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { headers: { 'x-goog-upload-url': 'https://evil.example/upload' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    await expect(
      new NodeProviders({ geminiApiKey: 'test' }).process(
        file,
        { ...request, provider: 'google-gemini' },
        context,
      ),
    ).rejects.toThrow('upload URL');
    fetcher.mockResolvedValue(
      Response.json({
        candidates: [{ content: { parts: [{ text: '{"translatedText":"hola"}' }] } }],
      }),
    );
    expect(
      await new NodeProviders({ geminiApiKey: 'test' }).translate(
        'hello',
        { ...request, targetLanguage: 'es' },
        context,
      ),
    ).toBe('hola');
    fetcher.mockResolvedValue(
      Response.json({ choices: [{ message: { content: '{"translatedText":"bonjour"}' } }] }),
    );
    expect(
      await new NodeProviders({ openaiApiKey: 'test' }).translate(
        'hello',
        { ...request, targetLanguage: 'fr' },
        context,
      ),
    ).toBe('bonjour');
    expect(await new NodeProviders().translate('hello', request, context)).toBe('hello');
  });
});
