import { defineConfig } from 'vitest/config';

// Several specs generate a deterministic order dataset first; give CI runners (which run packages in parallel) room.
export default defineConfig({ test: { include: ['src/**/*.spec.ts'], testTimeout: 60_000, hookTimeout: 60_000 } });
