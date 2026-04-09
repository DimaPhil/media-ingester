"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fingerprint_1 = require("../src/fingerprint");
(0, vitest_1.describe)('createFingerprint', () => {
    (0, vitest_1.it)('is stable regardless of object key order', () => {
        const first = (0, fingerprint_1.createFingerprint)({
            b: 2,
            a: {
                z: 3,
                y: 1,
            },
        });
        const second = (0, fingerprint_1.createFingerprint)({
            a: {
                y: 1,
                z: 3,
            },
            b: 2,
        });
        (0, vitest_1.expect)(first).toBe(second);
    });
    (0, vitest_1.it)('changes when payload changes', () => {
        (0, vitest_1.expect)((0, fingerprint_1.createFingerprint)({ value: 1 })).not.toBe((0, fingerprint_1.createFingerprint)({ value: 2 }));
    });
});
//# sourceMappingURL=fingerprint.test.js.map