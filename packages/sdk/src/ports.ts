import type {
  JobView,
  MediaRequest,
  MediaResult,
  ResolvedSource,
  Source,
  ProcessedMedia,
  ProcessedMediaDetails,
  ListHistory,
  HistoryPage,
} from '@media-ingest/contracts';

/**
 * `startMs`/`endMs` is the extracted media range. When a boundary has no pause, neighboring
 * chunks overlap and `keepStartMs`/`keepEndMs` mark the part each chunk owns in the result.
 */
export interface Chunk {
  index: number;
  startMs: number;
  endMs: number;
  keepStartMs?: number;
  keepEndMs?: number;
}
/** Audio power per fixed frame in dBFS; `-Infinity` marks digital silence. */
export interface LoudnessProfile {
  frameMs: number;
  levels: ArrayLike<number>;
}
export interface ChunkOutput {
  text: string;
  segments: MediaResult['segments'];
  timeRanges: MediaResult['timeRanges'];
  detectedLanguage: string | null;
  provenance?: MediaResult['provenance'];
}
export interface JobRecord extends JobView {
  ownerId: string;
  idempotencyKey?: string;
  requestHash: string;
  plan: Chunk[] | null;
  sourceFingerprint: string | null;
  chunks: Record<string, ChunkOutput>;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
}
export interface Lease {
  job: JobRecord;
  token: string;
}
export interface ListJobs {
  limit: number;
  status?: JobView['status'];
}
/** Owner-scoped retained-result lookup by site media ID or by content fingerprint. */
export type ResultLookup = { mediaId: string } | { fingerprint: string };
/** Every mutation below must be atomic. Fenced writes reject expired or replaced tokens. */
export interface JobRepository {
  enqueue(job: JobRecord): Promise<JobRecord>;
  get(ownerId: string, id: string): Promise<JobRecord | null>;
  list(ownerId: string, input: ListJobs): Promise<JobRecord[]>;
  history?(ownerId: string, input: ListHistory): Promise<HistoryPage>;
  getResult?(ownerId: string, id: string): Promise<ProcessedMedia | null>;
  claim(now: number, leaseMs: number): Promise<Lease | null>;
  heartbeat(id: string, token: string, now: number, leaseMs: number): Promise<void>;
  savePlan(
    id: string,
    token: string,
    plan: Chunk[],
    sourceFingerprint: string,
    now: number,
  ): Promise<void>;
  saveChunk(
    id: string,
    token: string,
    index: number,
    output: ChunkOutput,
    now: number,
  ): Promise<void>;
  complete(
    id: string,
    token: string,
    result: MediaResult,
    now: number,
    media?: ProcessedMediaDetails,
  ): Promise<void>;
  /** Retained results for this owner and identity, newest first. Enables result reuse. */
  findResults?(ownerId: string, lookup: ResultLookup, limit: number): Promise<ProcessedMedia[]>;
  /** Fenced completion with a retained result. Adds no history record. */
  completeFromCache?(id: string, token: string, cached: ProcessedMedia, now: number): Promise<void>;
  fail(id: string, token: string, error: NonNullable<JobView['error']>, now: number): Promise<void>;
  retry(ownerId: string, id: string, now: number): Promise<JobRecord>;
}
export interface AdapterContext {
  ownerId: string;
  jobId: string;
  attempt: number;
  signal: AbortSignal;
}
/** Artifacts are opaque to the SDK. Node adapters commonly return local file paths. */
export interface Artifact {
  uri: string;
  fileName: string;
  fingerprint: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Canonical requested clip duration, excluding container/codec padding. */
  durationMs?: number;
}
export interface MaterializeOptions {
  /** The provider needs only the audio stream; sources may fetch less data. */
  audioOnly?: boolean;
}
export interface SourceAdapter {
  resolve(source: Source, context: AdapterContext): Promise<ResolvedSource>;
  materialize(
    source: ResolvedSource,
    context: AdapterContext,
    options?: MaterializeOptions,
  ): Promise<Artifact>;
}
export interface MediaInspection {
  durationMs: number;
  hasAudio: boolean;
  hasVideo: boolean;
}
export type MediaInputFormat = 'audio' | 'audio_pcm' | 'video';
/** Request kinds remain accepted for existing adapters and embedding providers. */
export type MediaChunkKind = MediaRequest['kind'] | MediaInputFormat;
export interface MediaAdapter {
  inspect(artifact: Artifact, context: AdapterContext): Promise<MediaInspection>;
  chunk(
    artifact: Artifact,
    chunk: Chunk,
    kind: MediaChunkKind,
    context: AdapterContext,
  ): Promise<Artifact>;
  /** Measures audio power so chunk boundaries can fall in pauses instead of inside words. */
  loudness?(artifact: Artifact, context: AdapterContext): Promise<LoudnessProfile>;
  cleanup(context: AdapterContext): Promise<void>;
}
export interface ProviderAdapter {
  resolveModel(request: MediaRequest): string;
  chunkDurationMs(request: MediaRequest): number;
  /** Select the representation supplied to this provider. Omission preserves request-kind behavior. */
  inputFormat?(request: MediaRequest, inspection: MediaInspection): MediaInputFormat;
  /** Streams this provider reads from the source. `audio` lets sources skip video bytes. */
  sourceMedia?(request: MediaRequest): 'audio' | 'video';
  process(artifact: Artifact, request: MediaRequest, context: AdapterContext): Promise<ChunkOutput>;
  translate?(text: string, request: MediaRequest, context: AdapterContext): Promise<string>;
}
export interface SdkOptions {
  repository?: JobRepository;
  sources: SourceAdapter;
  media: MediaAdapter;
  provider: ProviderAdapter;
  chunkConcurrency?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  maxChunks?: number;
  clock?: () => number;
  onCleanupError?: (error: unknown) => void;
  onProcessingError?: (jobId: string, error: unknown) => void;
}
