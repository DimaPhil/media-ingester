import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { transcribeCodexAudio } from '../src/codex-audio.js';

it('skips only exactly silent PCM and sends even a single nonzero sample to Codex', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-silent-')));
  const uri = join(dir, 'sample.wav');
  const artifact = { uri, fileName: 'sample.wav', fingerprint: 'fixture' };
  const context = {
    ownerId: 'owner',
    jobId: 'job',
    attempt: 1,
    signal: new AbortController().signal,
  };
  const options = { codexHome: join(dir, 'credentials'), codexPath: join(dir, 'missing-codex') };
  try {
    const generate = (source: string) =>
      promisify(execFile)('ffmpeg', [
        '-y',
        '-nostdin',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        source,
        '-c:a',
        'pcm_s16le',
        uri,
      ]);
    await generate('aevalsrc=0:s=16000:d=0.5');
    expect(await transcribeCodexAudio(artifact, context, options)).toEqual({
      text: '',
      segments: [],
      timeRanges: [],
      detectedLanguage: null,
    });
    await generate("aevalsrc='if(eq(n,5000),1/32768,0)':s=16000:d=0.5");
    await expect(transcribeCodexAudio(artifact, context, options)).rejects.toThrow(
      'CLI could not be started',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
