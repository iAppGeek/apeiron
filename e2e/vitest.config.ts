import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The driver spec generates tens of thousands of orders; a loaded CI runner needs more than the 5 s default.
  test: { include: ['support/**/*.spec.ts'], testTimeout: 30_000 },
});
