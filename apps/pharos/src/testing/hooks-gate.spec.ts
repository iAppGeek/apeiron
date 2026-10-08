// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./hooks-gate-probe.ts', import.meta.url));

async function bundle(testHooks: boolean): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: testHooks ? { 'import.meta.env.VITE_TEST_HOOKS': JSON.stringify('1') } : {},
    build: {
      write: false,
      minify: true,
      lib: { entry: ENTRY, formats: ['es'], fileName: 'probe' },
      rollupOptions: { external: [/^ag-grid/, '@apeiron/logos'] },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return outputs
    .flatMap((o) => o.output)
    .map((chunk) => (chunk.type === 'chunk' ? chunk.code : ''))
    .join('\n');
}

describe('test hooks build guard', () => {
  it('leaves no hooks in a normal build', async () => {
    const code = await bundle(false);
    expect(code).not.toContain('__apeironTest');
    expect(code).not.toContain('forEachNode');
    expect(code).not.toContain('loadedRows');
  }, 60_000);

  it('includes the hooks when VITE_TEST_HOOKS=1', async () => {
    const code = await bundle(true);
    expect(code).toContain('__apeironTest');
    expect(code).toContain('loadedRows');
  }, 60_000);
});
