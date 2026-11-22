import type { MediaRequest } from '@media-ingest/contracts';
import { assertSelectedProvider } from './shared.js';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type ChunkOutput,
  type MediaInputFormat,
  type MediaInspection,
  type ProviderAdapter,
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

  /**
   * Runs provider work under the job signal and this provider's deadline. Missing the deadline
   * becomes `provider_timeout`; cancellation by the worker (shutdown, lost lease) propagates.
   */
  protected async withDeadline<T>(
    context: AdapterContext,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.timeoutMs ?? 10 * 60_000;
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      return await run(AbortSignal.any([context.signal, deadline]));
    } catch (error) {
      if (deadline.aborted && !context.signal.aborted)
        throw new MediaError(
          'provider_timeout',
          `${this.id} did not finish within ${Math.round(timeoutMs / 1000)} s`,
          true,
          { provider: this.id, timeoutMs },
        );
      throw error;
    }
  }

  async translate(text: string, request: MediaRequest, context: AdapterContext): Promise<string> {
    assertSelectedProvider(request, this.id);
    if (!request.targetLanguage) return text;
    const prompt = `Translate accurately to ${request.targetLanguage}, preserving speaker markers. Return JSON {"translatedText":string}.\n\n${text}`;
    return this.withDeadline(context, (signal) => this.translatePrompt(prompt, signal));
  }
}
