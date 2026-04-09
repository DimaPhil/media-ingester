import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      all: false,
      excludeAfterRemap: true,
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80
      },
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.d.ts',
        '**/dist/**',
        '**/coverage/**',
        'eslint.config.mjs',
        'vitest.config.ts',
        '**/index.ts',
        '**/main.ts',
        '**/drizzle/**',
        '**/providers.ts',
        '**/sources.ts',
        '**/app.module.ts',
        '**/lifecycle.service.ts',
        'packages/media-ingest-core/src/config.ts',
        'packages/media-ingest-core/src/db.ts',
        'packages/media-ingest-core/src/media.ts',
        'packages/media-ingest-cli/src/config.ts'
      ]
    }
  }
});
