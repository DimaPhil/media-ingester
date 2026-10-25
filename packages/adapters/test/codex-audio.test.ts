import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  spawn: vi.fn(),
  peer: undefined as any,
  socket: undefined as any,
}));
vi.mock('../src/subscription-runtime.js', () => ({
  withCredentialLock: async (_home: string, _signal: AbortSignal, fn: () => Promise<unknown>) =>
    fn(),
  subscriptionEnvironment: () => ({ PATH: '/bin' }),
  runSubscriptionProcess: mocks.run,
}));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:dgram', () => ({
  createSocket: () => {
    const socket = new EventEmitter() as any;
    socket.bind = (_p: number, _a: string, cb: () => void) => cb();
    socket.address = () => ({ port: 12345 });
    socket.close = vi.fn();
    mocks.socket = socket;
    return socket;
  },
}));
vi.mock('werift', () => ({
  MediaStreamTrack: class {
    writeRtp = vi.fn();
  },
  RTCPeerConnection: class {
    localDescription = { sdp: 'offer' };
    connected: ((state: string) => void) | undefined;
    receive: ((raw: Buffer) => void) | undefined;
    connectionStateChange = {
      subscribe: (fn: (state: string) => void) => {
        this.connected = fn;
      },
    };
    addTrack() {}
    constructor() {
      mocks.peer = this;
    }
    createDataChannel() {
      return {
        onMessage: {
          subscribe: (fn: (raw: Buffer) => void) => {
            this.receive = fn;
          },
        },
      };
    }
    async createOffer() {
      return { type: 'offer', sdp: 'offer' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {
      this.connected?.('connected');
    }
    close = vi.fn(async () => {});
  },
}));

import { CodexTranscript, transcribeCodexAudio } from '../src/codex-audio.js';
const event = (id: string, text: string, start_ms = 0, end_ms = 100) => ({
  type: 'input_transcript.added',
  start_ms,
  end_ms,
  item: { id, text },
});
const artifact = { uri: '/tmp/clip.wav', fileName: 'clip.wav', fingerprint: 'a' };
const options = { codexHome: '/tmp/dedicated-codex' };
function fixture(account = 'chatgpt') {
  mocks.run.mockImplementation(async (_path: string, args: string[]) => ({
    stdout: args[0] === '--version' ? 'codex-cli 0.163.0' : '{"format":{"duration":"1"}}',
    stderr: '',
  }));
  const children: any[] = [];
  mocks.spawn.mockImplementation((_path: string, args: string[]) => {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 123;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      child.signalCode = 'SIGTERM';
      child.emit('close');
      return true;
    });
    children.push(child);
    if (args[0] === 'app-server')
      child.stdin.on('data', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 0) child.stdout.write('{"id":0,"result":{}}\n');
        if (msg.id === 1)
          child.stdout.write(
            JSON.stringify({ id: 1, result: { account: { type: account } } }) + '\n',
          );
        if (msg.id === 2) child.stdout.write('{"id":2,"result":{"thread":{"id":"thread"}}}\n');
        if (msg.id === 3)
          child.stdout.write('{"method":"thread/realtime/started","params":{"sdp":"answer"}}\n');
      });
    return child;
  });
  return children;
}
async function started(children: any[], count = 2) {
  await vi.waitFor(() => expect(children).toHaveLength(count));
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe('Codex transcript normalization', () => {
  it('sorts reordered final items, deduplicates, and ignores deltas', () => {
    const result = new CodexTranscript(1000);
    result.add(event('b', ' world', 300, 500));
    result.add(event('a', 'Hello', 0, 200));
    expect(result.add(event('a', 'Hello', 0, 200))).toBe(false);
    result.add({ type: 'turn.delta', text: 'DUPLICATE' });
    expect(result.result().text).toBe('Hello world');
    expect(result.result().segments.map((s) => s.startMs)).toEqual([0, 300]);
  });
  it('rejects empty, conflicting, malformed and out-of-bounds transcripts', () => {
    const result = new CodexTranscript(1000);
    expect(() => result.result()).toThrow('empty');
    result.add(event('a', 'Hi'));
    expect(() => result.add(event('a', 'Bye'))).toThrow('conflicting');
    expect(() => result.add(event('b', 'x', 100, 1001))).toThrow('timestamps');
    expect(() => result.add(event('c', 'x', -1, 100))).toThrow('timestamps');
    expect(() => result.add({ type: 'input_transcript.added' })).toThrow('timestamps');
  });
});
describe('Codex realtime lifecycle', () => {
  it('checks native account and fails closed before starting encoder', async () => {
    const children = fixture('apiKey');
    await expect(
      transcribeCodexAudio(artifact, { signal: new AbortController().signal } as any, options),
    ).rejects.toThrow('subscription login');
    expect(children).toHaveLength(1);
    expect(children[0].kill).toHaveBeenCalled();
    expect(mocks.peer.close).toHaveBeenCalled();
    expect(mocks.socket.close).toHaveBeenCalled();
  });
  it('aborts stream and kills encoder, server and peer', async () => {
    const children = fixture();
    const controller = new AbortController();
    const pending = transcribeCodexAudio(artifact, { signal: controller.signal } as any, options);
    const assertion = expect(pending).rejects.toThrow('aborted');
    await started(children);
    controller.abort();
    await assertion;
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
    expect(mocks.peer.close).toHaveBeenCalled();
    expect(mocks.socket.close).toHaveBeenCalled();
  });
  it('rejects encoder failure even after receiving a partial transcript', async () => {
    const children = fixture();
    const pending = transcribeCodexAudio(
      artifact,
      { signal: new AbortController().signal } as any,
      options,
    );
    const assertion = expect(pending).rejects.toThrow('encoder failed');
    await started(children);
    mocks.peer.receive(Buffer.from(JSON.stringify(event('a', 'partial'))));
    children[1].emit('exit', 1);
    await assertion;
  });
  it('rejects realtime failure and oversized output without returning partial text', async () => {
    const children = fixture();
    const pending = transcribeCodexAudio(
      artifact,
      { signal: new AbortController().signal } as any,
      options,
    );
    const assertion = expect(pending).rejects.toThrow('terminated');
    await started(children);
    mocks.peer.receive(Buffer.from(JSON.stringify(event('a', 'partial'))));
    children[0].stdout.write('{"method":"thread/realtime/error","params":{}}\n');
    await assertion;
    const next = fixture();
    const overflow = transcribeCodexAudio(
      artifact,
      { signal: new AbortController().signal } as any,
      options,
    );
    const rejected = expect(overflow).rejects.toThrow('output limit');
    await started(next);
    next[0].stdout.write(Buffer.alloc(4 * 1024 * 1024));
    await rejected;
  });
  it('returns settled final input transcript after successful audio flush', async () => {
    const children = fixture();
    const pending = transcribeCodexAudio(
      artifact,
      { signal: new AbortController().signal } as any,
      options,
    );
    await started(children);
    vi.useFakeTimers();
    mocks.peer.receive(Buffer.from(JSON.stringify(event('a', 'Hello'))));
    children[1].emit('exit', 0);
    await vi.advanceTimersByTimeAsync(5100);
    vi.useRealTimers();
    expect((await pending).text).toBe('Hello');
    expect(children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
  });
  it('rejects incompatible versions and oversized clips before network setup', async () => {
    fixture();
    mocks.run.mockResolvedValueOnce({ stdout: 'codex-cli 9.0.0', stderr: '' });
    await expect(
      transcribeCodexAudio(artifact, { signal: new AbortController().signal } as any, options),
    ).rejects.toThrow('0.163.0');
    expect(mocks.spawn).not.toHaveBeenCalled();
    mocks.run
      .mockResolvedValueOnce({ stdout: 'codex-cli 0.163.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: '{"format":{"duration":"61"}}', stderr: '' });
    await expect(
      transcribeCodexAudio(artifact, { signal: new AbortController().signal } as any, options),
    ).rejects.toThrow('60000');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
