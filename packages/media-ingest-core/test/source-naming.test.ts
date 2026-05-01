import { describe, expect, it } from 'vitest';

import { buildStorageFileName, buildTelegramSourceNaming } from '../src/source-naming';

describe('buildTelegramSourceNaming', () => {
  it('prefers the first message line for user-facing naming', () => {
    const naming = buildTelegramSourceNaming({
      chatId: '2108353345',
      messageId: 3442,
      mediaId: '3442:0',
      messageText:
        'Урок №19. Прогрессивный ребаланс цен. FVG, iFVG, BPR, VI, Implied FVG, GAP\n\n00:00 Что такое ребаланс цен',
      originFileName: '18 Разновидности FVG.mp4',
      extension: '.mp4',
    });

    expect(naming.displayName).toBe('Урок №19. Прогрессивный ребаланс цен. FVG, iFVG, BPR, VI, Implied FVG, GAP');
    expect(naming.fileName).toBe('Урок №19. Прогрессивный ребаланс цен. FVG, iFVG, BPR, VI, Implied FVG, GAP.mp4');
    expect(naming.storageFileName).toBe('telegram-2108353345-3442-3442-0.mp4');
    expect(naming.originFileName).toBe('18 Разновидности FVG.mp4');
  });

  it('falls back to the upstream file name when message text is absent', () => {
    const naming = buildTelegramSourceNaming({
      chatId: '1',
      messageId: 2,
      mediaId: '2:0',
      originFileName: 'clip.mp4',
      extension: '.mp4',
    });

    expect(naming.displayName).toBe('clip');
    expect(naming.fileName).toBe('clip.mp4');
    expect(naming.storageFileName).toBe('telegram-1-2-2-0.mp4');
  });

  it('falls back to a deterministic id-based name when no title metadata exists', () => {
    const naming = buildTelegramSourceNaming({
      chatId: '1',
      messageId: 2,
      mediaId: '2:0',
      extension: '.mp4',
    });

    expect(naming.displayName).toBe('telegram-1-2-2-0');
    expect(naming.fileName).toBe('telegram-1-2-2-0.mp4');
    expect(naming.storageFileName).toBe('telegram-1-2-2-0.mp4');
  });
});

describe('buildStorageFileName', () => {
  it('preserves unicode while removing path-unsafe characters for storage', () => {
    expect(buildStorageFileName('Урок №19: Прогрессивный/ребаланс?.mp4')).toBe(
      'Урок_№19_Прогрессивный_ребаланс.mp4',
    );
  });
});
