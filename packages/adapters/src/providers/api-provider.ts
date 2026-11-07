import type { MediaRequest } from '@media-ingest/contracts';
import { assertSelectedProvider } from './shared.js';
import type {
  AdapterContext,
  Artifact,
  ChunkOutput,
  MediaInputFormat,
  MediaInspection,
  ProviderAdapter,
} from '@media-ingest/sdk';

export type ApiTranslation = (prompt: string, signal: AbortSignal) => Promise<string>;

export abstract class ApiProvider implements ProviderAdapter {
  constructor(
    protected readonly id: MediaRequest['provider'],
    private readonly timeoutMs: number | undefined,
    private readonly translatePrompt: ApiTranslation,
  ) {}

  protected abstract defaultModel(request: MediaRequest): string;

  resolveModel(request: MediaRequest): string {
    assertSelectedProvider(request, this.id);
    return request.model ?? this.defaultModel(request);
  }
  abstract process(
    artifact: Artifact,
    request: MediaRequest,
    context: AdapterContext,
  ): Promise<ChunkOutput>;

  chunkDurationMs(): number {
    return 10 * 60_000;
  }

  inputFormat(_request: MediaRequest, _inspection: MediaInspection): MediaInputFormat {
    return 'audio';
  }

  sourceMedia(request: MediaRequest): 'audio' | 'video' {
    return request.kind === 'understanding' ? 'video' : 'audio';
  }

  protected signal(context: AdapterContext): AbortSignal {
    return AbortSignal.any([context.signal, AbortSignal.timeout(this.timeoutMs ?? 10 * 60_000)]);
  }

  async translate(text: string, request: MediaRequest, context: AdapterContext): Promise<string> {
    assertSelectedProvider(request, this.id);
    if (!request.targetLanguage) return text;
    const prompt = `Translate accurately to ${request.targetLanguage}, preserving speaker markers. Return JSON {"translatedText":string}.\n\n${text}`;
    return this.translatePrompt(prompt, this.signal(context));
  }
}
