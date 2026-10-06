import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    benchmark: { include: ['bench/**/*.bench.ts'] },
  },
});
