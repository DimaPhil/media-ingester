import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { MediaError } from '@media-ingest/sdk';

/** Owns app-server JSON-RPC framing, native-account verification and SDP negotiation. */
export function startCodexAppServer(
  executable: string,
  workspace: string,
  env: NodeJS.ProcessEnv,
  offer: string,
  {
    acceptAnswer,
    finished,
    fail,
    countOutput,
  }: {
    acceptAnswer: (sdp: string) => Promise<void>;
    finished: () => boolean;
    fail: (error: unknown) => void;
    countOutput: (bytes: number) => void;
  },
) {
  const server = spawn(
    executable,
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
  server.stdin.on('error', () => fail(new Error('Codex app-server input closed')));
  server.stderr.on('data', (data: Buffer) => {
    try {
      countOutput(data.length);
    } catch (error) {
      fail(error);
    }
  });
  const send = (value: unknown) => {
    if (!finished()) server.stdin.write(JSON.stringify(value) + '\n');
  };
  let pending = '';
  const decoder = new StringDecoder('utf8');
  server.stdout.on('data', (data: Buffer) => {
    if (finished()) return;
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
              transport: { type: 'webrtc', sdp: offer },
              includeStartupContext: false,
              clientManagedHandoffs: true,
              prompt: 'Transcribe the incoming recording verbatim. Do not use tools.',
            },
          });
        }
        if (msg.method?.includes('/realtime/')) {
          if (msg.method.endsWith('/error') || msg.method.endsWith('/closed'))
            throw new Error('Codex realtime session terminated');
          if (msg.params?.sdp) void acceptAnswer(msg.params.sdp).catch(fail);
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  try {
    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: { name: 'media_ingest_audio', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
  } catch (error) {
    // Return the child to the session owner even if the first write fails.
    fail(error);
  }
  return server;
}
