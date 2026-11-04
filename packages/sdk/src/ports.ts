import type {
  JobView,
  MediaRequest,
  MediaResult,
  ResolvedSource,
  Source,
} from '@media-ingest/contracts';

export interface Chunk {
  index: number;
  startMs: number;
  endMs: number;
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
/** Every mutation below must be atomic. Fenced writes reject expired or replaced tokens. */
export interface JobRepository {
  enqueue(job: JobRecord): Promise<JobRecord>;
  get(ownerId: string, id: string): Promise<JobRecord | null>;
  list(ownerId: string, input: ListJobs): Promise<JobRecord[]>;
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
  complete(id: string, token: string, result: MediaResult, now: number): Promise<void>;
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
  /** Canonical requested clip duration, excluding container/codec padding. */
  durationMs?: number;
}
export interface SourceAdapter {
  resolve(source: Source, context: AdapterContext): Promise<ResolvedSource>;
  materialize(source: ResolvedSource, context: AdapterContext): Promise<Artifact>;
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
  cleanup(context: AdapterContext): Promise<void>;
}
export interface ProviderAdapter {
  resolveModel(request: MediaRequest): string;
  chunkDurationMs(request: MediaRequest): number;
  /** Select the representation supplied to this provider. Omission preserves request-kind behavior. */
  inputFormat?(request: MediaRequest, inspection: MediaInspection): MediaInputFormat;
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
