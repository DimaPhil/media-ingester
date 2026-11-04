import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { MediaRequest } from '@media-ingest/contracts';
import type { Artifact, ChunkOutput } from '@media-ingest/sdk';
import { checked, key, parseChunk, parseModelJson, parseTranslation } from './shared.js';

interface GeminiFile {
  name: string;
  uri: string;
  mimeType: string;
  state?: string;
}
const geminiRoot = 'https://generativelanguage.googleapis.com';
export async function processGemini(
  artifact: Artifact,
  request: MediaRequest,
  model: string,
  configuredKey: string | undefined,
  signal: AbortSignal,
): Promise<ChunkOutput> {
  const apiKey = key(configuredKey, 'GEMINI_API_KEY');
  const size = (await stat(artifact.uri)).size;
  if (size > 1024 * 1024 * 1024) throw new Error('Gemini chunk exceeds 1 GiB');
  const mimeType =
    artifact.mimeType ?? (request.kind === 'understanding' ? 'video/mp4' : 'audio/mpeg');
  const start = await checked(`${geminiRoot}/upload/v1beta/files`, {
    method: 'POST',
    signal,
    headers: {
      'x-goog-api-key': apiKey,
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(size),
      'x-goog-upload-header-content-type': mimeType,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: artifact.fileName } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl || new URL(uploadUrl).origin !== geminiRoot)
    throw new Error('Invalid Gemini upload URL');
  const upload = await checked(uploadUrl, {
    method: 'POST',
    signal,
    headers: {
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
      'content-type': mimeType,
    },
    body: await readFile(artifact.uri),
  });
  let file = ((await upload.json()) as { file: GeminiFile }).file;
  if (!file?.name || !/^files\/[\w-]+$/.test(file.name))
    throw new Error('Invalid Gemini file response');
  const name = file.name;
  try {
    while (file.state === 'PROCESSING') {
      await delay(1000, undefined, { signal });
      const response = await checked(`${geminiRoot}/v1beta/${name}`, {
        signal,
        headers: { 'x-goog-api-key': apiKey },
      });
      file = (await response.json()) as GeminiFile;
    }
    if (file.state !== 'ACTIVE' || !file.uri) throw new Error('Gemini media processing failed');
    const prompt =
      request.kind === 'transcription'
        ? `Transcribe in the source language. ${request.inputLanguage ? `Expected language: ${request.inputLanguage}.` : ''} Return JSON {"text":string,"detectedLanguage":string|null,"segments":[{"startMs":number,"endMs":number,"text":string,"speaker"?:string}]}. Times are relative to this clip.`
        : `${request.prompt}\nReturn JSON {"text":string,"timeRanges":[{"startMs":number,"endMs":number,"label"?:string}]}. Times are relative to this clip.`;
    return parseChunk(
      parseModelJson(
        await generateGemini(
          model,
          apiKey,
          [{ text: prompt }, { file_data: { mime_type: mimeType, file_uri: file.uri } }],
          signal,
        ),
      ),
    );
  } finally {
    // Cleanup uses its own deadline so cancellation cannot leak uploaded files indefinitely.
    await fetch(`${geminiRoot}/v1beta/${name}`, {
      method: 'DELETE',
      redirect: 'error',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}
export async function translateGemini(
  prompt: string,
  model: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<string> {
  return parseTranslation(await generateGemini(model, apiKey, [{ text: prompt }], signal));
}

async function generateGemini(
  model: string,
  apiKey: string,
  parts: unknown[],
  signal: AbortSignal,
): Promise<string> {
  const response = await checked(
    `${geminiRoot}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    },
  );
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('');
  if (!text) throw new Error('Gemini returned no text');
  return text;
}
