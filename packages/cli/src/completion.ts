import { operationIds } from '@media-ingest/contracts';

export const commandNames = [
  ...operationIds,
  'transcribe',
  'understand',
  'setup',
  'schema',
  'completion',
  'skill',
];
export function complete(words: string[]): string[] {
  const prefix = words.at(-1) ?? '';
  const preceding = words.slice(0, -1);
  const candidates =
    preceding.length === 0
      ? commandNames
      : preceding[0] === 'completion'
        ? ['bash', 'zsh', 'fish']
        : preceding[0] === 'skill'
          ? ['install']
          : preceding[0] === 'schema'
            ? operationIds
            : ['--input', '--file', '--help'];
  return [...candidates].filter((value) => value.startsWith(prefix)).sort();
}
export function completionScript(shell: string): string {
  if (shell === 'bash')
    return '# media completion\n_media_complete() { local IFS=$\'\\n\'; COMPREPLY=( $(media __complete -- "${COMP_WORDS[@]:1:$COMP_CWORD}") ); }\ncomplete -F _media_complete media\n';
  if (shell === 'zsh')
    return '#compdef media\n_media_complete() { local -a candidates; candidates=("${(@f)$(media __complete -- "${words[@]:1:$((CURRENT-1))}")}"); compadd -- "${candidates[@]}"; }\ncompdef _media_complete media\n';
  if (shell === 'fish')
    return 'function __media_complete\n  set -l words (commandline -opc)\n  set -e words[1]\n  media __complete -- $words (commandline -ct)\nend\ncomplete -c media -f -a "(__media_complete)"\n';
  throw new Error('Supported shells: bash, zsh, fish');
}
