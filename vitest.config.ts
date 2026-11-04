import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'packages/{contracts,sdk,adapters,client,cli}/test/**/*.test.ts',
      'apps/api/test/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/{contracts,sdk,adapters,client,cli}/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: [
        'packages/sdk/src/index.ts',
        'packages/adapters/src/index.ts',
        'apps/api/src/main.ts',
        'apps/api/src/migrate.ts',
      ],
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 },
    },
  },
});
