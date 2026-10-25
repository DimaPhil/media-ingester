import { spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RTCPeerConnection, MediaStreamTrack } from 'werift';
import {
  MediaError,
  type AdapterContext,
  type Artifact,
  type ChunkOutput,
} from '@media-ingest/sdk';
import {
  withCredentialLock,
  subscriptionEnvironment,
  runSubscriptionProcess,
} from './subscription-runtime.js';

export interface CodexAudioOptions {
  codexHome: string;
  codexPath?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
}

const inputPolicy = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,flac,ogg,aac,avi,mpeg,mpegts,asf,aiff',
];
const maxOutputBytes = 4 * 1024 * 1024;

/** Only finalized input transcription events are authoritative; assistant deltas are ignored. */
export class CodexTranscript {
  private readonly items = new Map<string, { startMs: number; endMs: number; text: string }>();
  constructor(private readonly durationMs: number) {}
  add(event: unknown): boolean {
    const value = event as {
      type?: string;
      start_ms?: number;
      end_ms?: number;
      item?: { id?: string; text?: string };
    };
    if (value?.type !== 'input_transcript.added') return false;
    const { start_ms: startMs, end_ms: endMs, item } = value;
    if (
      !item?.id ||
      typeof item.text !== 'string' ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs! < 0 ||
      endMs! < startMs! ||
      endMs! > this.durationMs
    )
      throw new Error('Codex returned invalid or out-of-bounds transcript timestamps');
    const next = { startMs: startMs!, endMs: endMs!, text: item.text };
    const prior = this.items.get(item.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(next))
      throw new Error('Codex returned conflicting transcript item');
    this.items.set(item.id, next);
    return !prior;
  }
  result(): ChunkOutput {
    const segments = [...this.items.values()].sort(
      (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
    );
    const text = segments
      .map((s) => s.text)
      .join('')
      .trim();
    if (!text) throw new Error('Codex returned an empty audio transcript');
    return { text, segments, timeRanges: [], detectedLanguage: null };
  }
}

export async function transcribeCodexAudio(
  artifact: Artifact,
  context: AdapterContext,
  options: CodexAudioOptions,
): Promise<ChunkOutput> {
  context = {
    ...context,
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]),
  };
  if (!isAbsolute(artifact.uri) || !isAbsolute(options.codexHome))
    throw new MediaError(
      'subscription_configuration',
      'Codex audio requires absolute local media and dedicated credential home paths',
    );
  return withCredentialLock(options.codexHome, context.signal, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'media-codex-audio-'));
    try {
      const env = subscriptionEnvironment('codex', options.codexHome, workspace);
      const codex = options.codexPath ?? 'codex';
      const version = await runSubscriptionProcess(codex, ['--version'], {
        cwd: workspace,
        env,
        signal: context.signal,
        timeoutMs: 10_000,
      });
      if (version.stdout.trim() !== 'codex-cli 0.163.0')
        throw new MediaError(
          'subscription_configuration',
          'Experimental audio requires codex-cli 0.163.0',
        );
      const probe = await runSubscriptionProcess(
        options.ffprobePath ?? 'ffprobe',
        [
          '-v',
          'error',
          ...inputPolicy,
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          artifact.uri,
        ],
        { cwd: workspace, env, signal: context.signal, timeoutMs: 10_000 },
      );
      const durationMs = Math.ceil(Number(JSON.parse(probe.stdout).format?.duration) * 1000);
      if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000)
        throw new MediaError(
          'invalid_media',
          'Codex audio requires a clip between 1 and 60000 milliseconds',
        );
      return await streamAudio(artifact, context, options, workspace, env, durationMs);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

async function streamAudio(
  artifact: Artifact,
  context: AdapterContext,
  options: CodexAudioOptions,
  workspace: string,
  env: NodeJS.ProcessEnv,
  durationMs: number,
): Promise<ChunkOutput> {
  const peer = new RTCPeerConnection({ iceServers: [] });
  const track = new MediaStreamTrack({ kind: 'audio' });
  peer.addTrack(track);
  const channel = peer.createDataChannel('oai-events');
  const socket = createSocket('udp4');
  const transcript = new CodexTranscript(durationMs);
  let server: ChildProcess | undefined;
  let encoder: ChildProcess | undefined;
  let settled = false;
  let sent = false;
  let lastTranscript = Date.now();
  let outputBytes = 0;
  let completionTimer: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectResult: (error: Error) => void = () => {};
  let resolveResult: (output: ChunkOutput) => void = () => {};
  const result = new Promise<ChunkOutput>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Attach a rejection handler while asynchronous WebRTC setup is in flight.
  void result.catch(() => {});
  const fail = (error: unknown) => {
    if (!settled) {
      settled = true;
      rejectResult(error instanceof Error ? error : new Error('Codex audio failed'));
    }
  };
  const abort = () => fail(new MediaError('subscription_aborted', 'Codex audio aborted', true));
  const countOutput = (bytes: number) => {
    outputBytes += bytes;
    if (outputBytes > maxOutputBytes) throw new Error('Codex audio output limit exceeded');
  };
  const send = (value: unknown) => {
    if (!settled) server?.stdin?.write(JSON.stringify(value) + '\n');
  };
  try {
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    timeout = setTimeout(
      () => fail(new MediaError('subscription_timeout', 'Codex audio timed out', true)),
      options.timeoutMs ?? 120_000,
    );
    socket.on('error', fail);
    socket.on('message', (packet) => {
      if (!settled) {
        try {
          track.writeRtp(packet);
        } catch (error) {
          fail(error);
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    channel.onMessage.subscribe((raw) => {
      if (settled) return;
      try {
        const text = raw.toString();
        countOutput(Buffer.byteLength(text));
        const event = JSON.parse(text);
        if (event.type === 'error') throw new Error('Codex realtime transcription error');
        if (transcript.add(event)) lastTranscript = Date.now();
      } catch (error) {
        fail(error);
      }
    });
    peer.connectionStateChange.subscribe((state) => {
      if (settled) return;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        fail(new Error('Codex audio connection lost'));
        return;
      }
      if (state !== 'connected' || encoder) return;
      const address = socket.address();
      if (typeof address === 'string') {
        fail(new Error('Invalid local audio socket'));
        return;
      }
      encoder = spawn(
        options.ffmpegPath ?? 'ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          ...inputPolicy,
          '-i',
          artifact.uri,
          '-vn',
          '-af',
          'apad=pad_dur=3',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-c:a',
          'libopus',
          '-payload_type',
          '96',
          '-f',
          'rtp',
          `rtp://127.0.0.1:${address.port}`,
        ],
        { cwd: workspace, env, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      encoder.on('error', () => fail(new Error('Audio encoder could not start')));
      encoder.stderr?.on('data', (data: Buffer) => {
        try {
          countOutput(data.length);
        } catch (error) {
          fail(error);
        }
      });
      encoder.on('exit', (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error('Audio encoder failed'));
          return;
        }
        sent = true;
        const finishedAt = Date.now();
        completionTimer = setInterval(() => {
          if (settled || !sent) return;
          // Trailing silence flushes VAD. Wait for a quiet transcript window after all audio is sent.
          if (Date.now() - finishedAt >= 5000 && Date.now() - lastTranscript >= 3000) {
            try {
              const output = transcript.result();
              settled = true;
              resolveResult(output);
            } catch (error) {
              fail(error);
            }
          }
        }, 100);
      });
    });
    await Promise.race([
      (async () => peer.setLocalDescription(await peer.createOffer()))(),
      result,
    ]);
    if (settled) return await result;
    server = spawn(
      options.codexPath ?? 'codex',
      [
        'app-server',
        '-c',
        'model_provider="openai"',
        '-c',
        'forced_login_method="chatgpt"',
        '-c',
        'cli_auth_credentials_store="file"',
        '-c',
        'features.shell_tool=false',
        '-c',
        'features.unified_exec=false',
        '-c',
        'features.hooks=false',
        '-c',
        'features.multi_agent=false',
        '-c',
        'mcp_servers={}',
        '-c',
        'project_doc_max_bytes=0',
      ],
      { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    server.on('error', () => fail(new Error('Codex app-server could not start')));
    server.on('exit', () =>
      fail(new Error('Codex app-server exited before transcription completed')),
    );
    server.stdin?.on('error', () => fail(new Error('Codex app-server input closed')));
    server.stderr?.on('data', (data: Buffer) => {
      try {
        countOutput(data.length);
      } catch (error) {
        fail(error);
      }
    });
    let pending = '';
    const decoder = new StringDecoder('utf8');
    server.stdout?.on('data', (data: Buffer) => {
      if (settled) return;
      try {
        countOutput(data.length);
        pending += decoder.write(data);
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method && msg.id !== undefined) {
            send({ id: msg.id, error: { code: -32601, message: 'Tools disabled' } });
            continue;
          }
          if (msg.error) throw new Error('Codex app-server request failed');
          if (msg.id === 0) {
            send({ method: 'initialized', params: {} });
            send({ method: 'account/read', id: 1, params: { refreshToken: false } });
          }
          if (msg.id === 1) {
            if (msg.result?.account?.type !== 'chatgpt')
              throw new MediaError(
                'subscription_auth_required',
                'Codex audio requires native ChatGPT subscription login',
              );
            send({
              method: 'thread/start',
              id: 2,
              params: {
                ephemeral: true,
                cwd: workspace,
                sandbox: 'read-only',
                approvalPolicy: 'never',
                config: { mcp_servers: {}, project_doc_max_bytes: 0 },
              },
            });
          }
          if (msg.id === 2) {
            if (typeof msg.result?.thread?.id !== 'string')
              throw new Error('Codex app-server returned no thread');
            send({
              method: 'thread/realtime/start',
              id: 3,
              params: {
                threadId: msg.result.thread.id,
                version: 'v3',
                outputModality: 'audio',
                transport: { type: 'webrtc', sdp: peer.localDescription!.sdp },
                includeStartupContext: false,
                clientManagedHandoffs: true,
                prompt: 'Transcribe the incoming recording verbatim. Do not use tools.',
              },
            });
          }
          if (msg.method?.includes('/realtime/')) {
            if (msg.method.endsWith('/error') || msg.method.endsWith('/closed'))
              throw new Error('Codex realtime session terminated');
            if (msg.params?.sdp)
              void peer.setRemoteDescription({ type: 'answer', sdp: msg.params.sdp }).catch(fail);
          }
        }
      } catch (error) {
        fail(error);
      }
    });
    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: { name: 'media_ingest_audio', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
    return await result;
  } finally {
    settled = true;
    context.signal.removeEventListener('abort', abort);
    clearTimeout(timeout);
    clearInterval(completionTimer);
    try {
      socket.close();
    } catch {
      /* Socket may already be closed after setup failure. */
    }
    await Promise.all([stopProcess(encoder), stopProcess(server), closePeer(peer)]);
  }
}

async function closePeer(peer: RTCPeerConnection): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      peer.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // If graceful SCTP shutdown stalls, stop its underlying socket transports too.
          for (const transport of [...peer.dtlsTransports, ...peer.iceTransports]) {
            void transport.stop().catch(() => {});
          }
          reject(new Error('Codex audio peer cleanup timed out'));
        }, 2000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
    return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    child.once('close', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
