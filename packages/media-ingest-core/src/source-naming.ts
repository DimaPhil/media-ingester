function trimCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeDisplaySegment(value: string): string {
  return value
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32 || '<>:"/\\|?*'.includes(char)) {
        return ' ';
      }
      return char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
}

function sanitizeStorageSegment(value: string): string {
  const sanitized = sanitizeDisplaySegment(value)
    .replace(/\s+/g, '_');
  return sanitized || 'media';
}

function splitExtension(fileName: string | undefined): { stem: string; extension: string } {
  const candidate = trimCandidate(fileName);
  if (!candidate) {
    return { stem: '', extension: '' };
  }

  const lastDot = candidate.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === candidate.length - 1) {
    return { stem: candidate, extension: '' };
  }

  return {
    stem: candidate.slice(0, lastDot),
    extension: candidate.slice(lastDot),
  };
}

function inferExtension(originFileName: string | undefined, fallbackExtension: string | undefined): string {
  const origin = splitExtension(originFileName).extension;
  if (origin) {
    return origin;
  }
  const fallback = trimCandidate(fallbackExtension);
  if (!fallback) {
    return '';
  }
  return fallback.startsWith('.') ? fallback : `.${fallback}`;
}

function truncateSegment(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trim();
}

function firstMeaningfulLine(text: string | undefined): string | undefined {
  const normalized = text
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return normalized ? truncateSegment(normalized, 120) : undefined;
}

export interface TelegramSourceNamingInput {
  chatId: string;
  messageId: number;
  mediaId: string;
  messageText?: string;
  originFileName?: string;
  extension?: string;
}

export interface SourceFileNaming {
  displayName: string;
  fileName: string;
  storageFileName: string;
  originFileName?: string;
}

export function buildTelegramSourceNaming(input: TelegramSourceNamingInput): SourceFileNaming {
  const extension = inferExtension(input.originFileName, input.extension);
  const titleLine = firstMeaningfulLine(input.messageText);
  const originFileName = trimCandidate(input.originFileName);
  const preferredStem = titleLine
    ? sanitizeDisplaySegment(titleLine)
    : sanitizeDisplaySegment(splitExtension(input.originFileName).stem);
  const fallbackStem = `telegram-${input.chatId}-${input.messageId}-${input.mediaId.replace(/[:/\\]/g, '-')}`;
  const fileNameStem = preferredStem || fallbackStem;

  return {
    displayName: titleLine || preferredStem || fallbackStem,
    fileName: `${fileNameStem}${extension}`,
    storageFileName: `${sanitizeStorageSegment(fallbackStem)}${extension}`,
    ...(originFileName ? { originFileName } : {}),
  };
}

export function buildStorageFileName(fileName: string): string {
  const { stem, extension } = splitExtension(fileName);
  const safeStem = sanitizeStorageSegment(stem || fileName);
  return `${safeStem}${extension}`;
}
