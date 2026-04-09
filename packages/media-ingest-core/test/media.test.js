"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const media_1 = require("../src/media");
(0, vitest_1.describe)('planChunks', () => {
    (0, vitest_1.it)('returns a single chunk when media fits provider capability', () => {
        (0, vitest_1.expect)((0, media_1.planChunks)({
            path: '/tmp/file.mp3',
            formatName: 'mp3',
            durationMs: 10_000,
            sizeBytes: 1_000,
            hasAudio: true,
            hasVideo: false,
        }, {
            maxWholeFileDurationMs: 60_000,
            chunkDurationMs: 30_000,
            overlapMs: 2_000,
        })).toEqual([{ index: 0, startMs: 0, endMs: 10_000 }]);
    });
    (0, vitest_1.it)('splits long media into overlapping chunks', () => {
        (0, vitest_1.expect)((0, media_1.planChunks)({
            path: '/tmp/file.mp3',
            formatName: 'mp3',
            durationMs: 65_000,
            sizeBytes: 1_000,
            hasAudio: true,
            hasVideo: false,
        }, {
            maxWholeFileDurationMs: 20_000,
            chunkDurationMs: 30_000,
            overlapMs: 2_000,
        })).toEqual([
            { index: 0, startMs: 0, endMs: 30_000 },
            { index: 1, startMs: 28_000, endMs: 60_000 },
            { index: 2, startMs: 58_000, endMs: 65_000 },
        ]);
    });
});
//# sourceMappingURL=media.test.js.map