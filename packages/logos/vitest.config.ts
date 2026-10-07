import { defineConfig } from 'vitest/config';

// CI runs the packages' tests in parallel on a small machine; a few generator-based specs need headroom.
export default defineConfig({ test: { include: ['src/**/*.spec.ts'], testTimeout: 30_000 } });
