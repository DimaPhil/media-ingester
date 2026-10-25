import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MediaRequest } from '@media-ingest/contracts';
const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  transcribe: vi.fn(),
  process: vi.fn(),
  auth: vi.fn(),
}));
vi.mock('../src/media.js', () => ({ runCommand: mocks.command }));
vi.mock('../src/codex-audio.js', () => ({
  transcribeCodexAudio: mocks.transcribe,
}));
vi.mock('../src/subscription-runtime.js', () => ({
  withCredentialLock: (_home: string, _signal: AbortSignal, fn: () => Promise<unknown>) => fn(),
  subscriptionEnvironment: () => ({}),
  runSubscriptionProcess: (binary: string, args: string[], options: unknown) =>
    args[0] === 'auth' ? mocks.auth(binary, args, options) : mocks.process(binary, args, options),
}));
import {
  understandSubscription,
  translateSubscription,
} from '../src/subscription-understanding.js';
const context = {
  ownerId: 'owner',
  jobId: 'job',
  attempt: 1,
  signal: new AbortController().signal,
};
const artifact = { uri: '/clip.mp4', fileName: 'clip.mp4', fingerprint: 'hash' };
const request: MediaRequest = {
  kind: 'understanding',
  provider: 'codex',
  model: 'chosen-model',
  prompt: 'Describe evidence',
  source: { kind: 'local_file', uri: '/clip.mp4' },
};
const options = { codexHome: '/credentials/codex', claudeHome: '/credentials/claude' };
const output = { text: 'Evidence summary', segments: [], timeRanges: [], detectedLanguage: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({
    stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }),
    stderr: '',
  });
  mocks.command.mockImplementation(async (_binary, args) => {
    if (args.includes('-show_streams'))
      return JSON.stringify({
        format: { duration: '11' },
        streams: [{ codec_type: 'audio' }, { codec_type: 'video' }],
      });
    await writeFile(args.at(-1), Buffer.from('jpeg'));
    return '';
  });
  mocks.transcribe.mockResolvedValue({
    text: 'Full spoken words',
    segments: [{ startMs: 0, endMs: 1000, text: 'Full spoken words' }],
    timeRanges: [],
    detectedLanguage: 'en',
  });
  mocks.process.mockImplementation(async (_binary, args) => {
    if (args.includes('-o')) await writeFile(args[args.indexOf('-o') + 1], JSON.stringify(output));
    return { stdout: JSON.stringify({ type: 'result', structured_output: output }), stderr: '' };
  });
});
describe('subscription understanding', () => {
  it.each([
    { loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' },
    { loggedIn: false, authMethod: 'claude.ai', apiProvider: 'firstParty' },
  ])('rejects non-subscription Claude auth before reasoning: %j', async (auth) => {
    mocks.auth.mockResolvedValue({ stdout: JSON.stringify(auth), stderr: '' });
    await expect(
      translateSubscription(
        'Text',
        { ...request, provider: 'claude-code', targetLanguage: 'fr' },
        context,
        options,
      ),
    ).rejects.toMatchObject({ code: 'subscription_auth_required' });
    expect(mocks.process).not.toHaveBeenCalled();
  });
  it('attaches the finished transcript and all images in the first Claude message', async () => {
    await understandSubscription(
      artifact,
      { ...request, provider: 'claude-code' },
      context,
      options,
    );
    expect(mocks.transcribe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.process.mock.invocationCallOrder[0]!,
    );
    const message = JSON.parse(mocks.process.mock.calls[0]![2].input);
    expect(message.message.content[0].text).toContain('Full spoken words');
    expect(message.message.content[0].text).toContain('"startMs":0,"endMs":1000');
    expect(
      message.message.content.filter((block: { type: string }) => block.type === 'image'),
    ).toHaveLength(3);
    expect(mocks.process).toHaveBeenCalledTimes(1);
  });
  it('bounds padded video audio to the canonical sixty-second clip', async () => {
    mocks.command.mockImplementation(async (_binary, args) => {
      if (args.includes('-show_streams'))
        return JSON.stringify({
          format: { duration: '60.2' },
          streams: [{ codec_type: 'audio' }, { codec_type: 'video' }],
        });
      await writeFile(args.at(-1), 'media');
      return '';
    });
    await understandSubscription({ ...artifact, durationMs: 60_000 }, request, context, options);
    const extraction = mocks.command.mock.calls.find(([, args]) => args.includes('pcm_s16le'))![1];
    expect(extraction[extraction.indexOf('-t') + 1]).toBe('60');
    expect(mocks.transcribe.mock.calls[0]![0].durationMs).toBe(60_000);
    expect(mocks.process.mock.calls[0]![1].filter((arg: string) => arg === '--image')).toHaveLength(
      12,
    );
  });
  it('rejects model timestamps outside the clip', async () => {
    mocks.process.mockResolvedValue({
      stdout: JSON.stringify({
        type: 'result',
        structured_output: { ...output, timeRanges: [{ startMs: 0, endMs: 11001, label: null }] },
      }),
      stderr: '',
    });
    await expect(
      understandSubscription(artifact, { ...request, provider: 'claude-code' }, context, options),
    ).rejects.toThrow('invalid clip timestamps');
  });
  it('finishes ASR before starting reasoning, with all transcript and timestamped frames initially attached', async () => {
    const result = await understandSubscription(artifact, request, context, options);
    expect(mocks.transcribe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.process.mock.invocationCallOrder[0]!,
    );
    const [, args, invocation] = mocks.process.mock.calls[0]!;
    expect(args.filter((arg: string) => arg === '--image')).toHaveLength(3);
    expect(invocation.input).toContain('Full spoken words');
    expect(invocation.input).toContain('[0,5000,10000]');
    expect(args).toContain('features.shell_tool=false');
    expect(args).toContain('chosen-model');
    expect(result.provenance?.transcription?.model).toBeNull();
  });
  it('skips ASR for silent video and uses native Claude initial image blocks', async () => {
    mocks.command.mockImplementation(async (_binary, args) => {
      if (args.includes('-show_streams'))
        return JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] });
      await writeFile(args.at(-1), 'jpeg');
      return '';
    });
    const result = await understandSubscription(
      artifact,
      { ...request, provider: 'claude-code' },
      context,
      options,
    );
    expect(mocks.transcribe).not.toHaveBeenCalled();
    const [, args, invocation] = mocks.process.mock.calls[0]!;
    expect(args).toContain('--safe-mode');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(JSON.parse(invocation.input).message.content[2].type).toBe('image');
    expect(result.provenance?.transcription).toBeUndefined();
  });
  it('supports audio-only clips with no frame extraction', async () => {
    mocks.command.mockResolvedValue(
      JSON.stringify({ format: { duration: '10' }, streams: [{ codec_type: 'audio' }] }),
    );
    await understandSubscription(artifact, request, context, options);
    expect(mocks.command).toHaveBeenCalledTimes(2);
    expect(mocks.process.mock.calls[0]![1]).not.toContain('--image');
  });
  it('rejects unsuccessful Claude output', async () => {
    mocks.process.mockResolvedValue({ stdout: '{"type":"result","is_error":true}', stderr: '' });
    await expect(
      understandSubscription(artifact, { ...request, provider: 'claude-code' }, context, options),
    ).rejects.toThrow('successful structured output');
  });
  it('translates with the same selected subscription model', async () => {
    mocks.process.mockResolvedValue({
      stdout: '{"type":"result","structured_output":{"text":"Translated"}}',
      stderr: '',
    });
    expect(
      await translateSubscription(
        'Source',
        { ...request, provider: 'claude-code', targetLanguage: 'fr' },
        context,
        options,
      ),
    ).toBe('Translated');
    expect(mocks.process.mock.calls[0]![1]).toContain('chosen-model');
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});
