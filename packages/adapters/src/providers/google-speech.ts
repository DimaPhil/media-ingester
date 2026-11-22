import { readFile, stat } from 'node:fs/promises';
import type { MediaRequest } from '@media-ingest/contracts';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type ChunkOutput,
} from '@media-ingest/sdk';
import { googleAccessToken } from '../google-auth.js';
import { checked, conform, key, parseChunk, readJson } from './shared.js';
import { ApiProvider, type ApiTranslation } from './api-provider.js';

interface GoogleSpeechOptions {
  googleRecognizer?: string;
  googleProject?: string;
  googleCredentials?: Record<string, unknown>;
  model?: string;
  timeoutMs?: number;
}

export class GoogleSpeechProvider extends ApiProvider {
  static readonly capabilities = {
    transcription: true,
    understanding: false,
    nativeVideo: false,
  } as const;

  constructor(
    private readonly options: GoogleSpeechOptions,
    translator: ApiTranslation,
  ) {
    super('google-speech', options.timeoutMs, translator);
  }

  protected defaultModel(): string {
    return this.options.model ?? 'chirp_3';
  }

  override chunkDurationMs(): number {
    return 55_000;
  }

  async process(
    artifact: Artifact,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput> {
    if (request.kind !== 'transcription')
      throw new MediaError('invalid_request', 'Understanding requires Gemini');
    const model = this.resolveModel(request);
    const options = this.options;
    if ((await stat(artifact.uri)).size > 10 * 1024 * 1024)
      throw new MediaError(
        'media_too_large',
        'Google Speech synchronous chunk exceeds 10 MiB',
        false,
        { provider: 'google-speech' },
      );
    const recognizer =
      options.googleRecognizer ??
      `projects/${key(options.googleProject, 'GOOGLE_CLOUD_PROJECT')}/locations/global/recognizers/_`;
    if (!/^projects\/[\w-]+\/locations\/[\w-]+\/recognizers\/[\w-]+$/.test(recognizer))
      throw new MediaError('invalid_configuration', 'Invalid Google Speech recognizer');
    const location = recognizer.split('/')[3]!;
    const host =
      location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`;
    const token = await googleAccessToken(options.googleCredentials);
    const content = (await readFile(artifact.uri)).toString('base64');
    const payload = (await this.withDeadline(context, async (signal) => {
      const response = await checked(
        `https://${host}/v2/${recognizer}:recognize`,
        {
          method: 'POST',
          signal,
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            config: {
              autoDecodingConfig: {},
              languageCodes: [request.inputLanguage ?? 'auto'],
              model,
              features: { enableWordTimeOffsets: true },
            },
            content,
          }),
        },
        'google-speech',
      );
      return readJson(response, 'google-speech', signal);
    })) as {
      results?: Array<{
        languageCode?: string;
        alternatives?: Array<{
          transcript?: string;
          words?: Array<{
            startOffset?: string;
            endOffset?: string;
            word?: string;
            speakerLabel?: string;
          }>;
        }>;
      }>;
    };
    const results = payload.results ?? [];
    const transcripts: string[] = [];
    const segments = results.flatMap((result) => {
      const alternative = result.alternatives?.[0];
      if (!alternative?.transcript) return [];
      transcripts.push(alternative.transcript);
      const words = alternative.words ?? [];
      const endOffset = words.at(-1)?.endOffset;
      if (!endOffset) return [];
      const startMs = Math.round(parseFloat(words[0]?.startOffset ?? '0') * 1000);
      const endMs = Math.min(
        Math.round(parseFloat(endOffset) * 1000),
        artifact.durationMs ?? Infinity,
      );
      if (!(startMs >= 0 && startMs <= endMs && Number.isFinite(endMs))) return [];
      return [
        {
          startMs,
          endMs,
          text: alternative.transcript,
        },
      ];
    });
    return conform(
      {
        text: transcripts.join(' '),
        segments,
        detectedLanguage: results.find((result) => result.languageCode)?.languageCode ?? null,
      },
      parseChunk,
      'google-speech',
      { model },
    );
  }
}
