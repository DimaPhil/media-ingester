# media

The CLI is an HTTP client for Media Ingest. It never executes media providers, ffmpeg, or database queries locally. Every API operation is exposed as a command from the shared operation catalog; run `media schema` to inspect all request and response schemas.

Release tarballs bundle the HTTP client, contracts, and parser into the executable, so installation does not require unpublished workspace packages. Install the CLI tarball from the same release as the API with `npm install -g ./media-ingest-cli-<version>.tgz` (or `pnpm add -g ./media-ingest-cli-<version>.tgz`).

```sh
export MEDIA_API_URL=https://media.example.com
# Set MEDIA_API_TOKEN through your secret manager, or provide it to setup on stdin.
media setup --url https://media.example.com --token-stdin
media transcribe ./recording.mp3
media understand https://example.com/video.mp4 --prompt 'Describe the demonstration'
media get <job-id>
media list --input '{"limit":10}'
```

`MEDIA_API_URL` and `MEDIA_API_TOKEN` override `~/.config/media/config.json` (`XDG_CONFIG_HOME` is honored). Setup writes mode 0600 and never prints the token. Remote APIs require HTTPS; localhost HTTP works in development. Requests time out after two minutes. Mutations check the server's contract fingerprint first and fail closed on drift. API tokens must have the needed scopes.

`media <operation> --input '<json>'` and `--file request.json` cover every catalog operation. `--file -` reads JSON from stdin. `get` and `retry` also accept a positional job ID; `upload` accepts a local path. Local uploads and inline downloads are limited to 32 MiB. `download` emits base64 in JSON; remote-source processing can handle larger media within server limits. Save the submission's ID and poll `get`; submission does not wait for processing.

## Completion

```sh
# Bash: add to ~/.bashrc
eval "$(media completion bash)"
# Zsh: after compinit in ~/.zshrc
eval "$(media completion zsh)"
# Fish:
media completion fish > ~/.config/fish/completions/media.fish
```

Commands are derived from the catalog, so new API operations appear in completion automatically.

## Agent skill

The npm postinstall hook installs the bundled `media-cli` skill into `~/.agents/skills/media-cli` and creates the relative Claude adapter `~/.claude/skills/media-cli`. Updates only replace an unmodified managed installation. Unmanaged directories, symlinks and local edits are preserved. Use `MEDIA_SKIP_SKILL_INSTALL=1` to opt out. If your package manager disables lifecycle scripts (including pnpm's dependency-script policy), run `media skill install` explicitly after installation. This command can repair a missing adapter but never overwrites your edits; move conflicting files first.

The package ships skill prompts in `evals/evals.json`; command examples and installer behavior are exercised in Vitest. These are functional sanity checks, not a model-quality benchmark or proof of discovery by every agent runtime.
