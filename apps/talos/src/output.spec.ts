import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRoot, stamp, writeResults } from './output.js';
import { RunRecorder } from './recorder.js';
import { buildReport } from './report.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'talos-'));
  dirs.push(d);
  return d;
};

describe('stamp', () => {
  it('is a sortable UTC timestamp for file names', () => {
    expect(stamp(new Date('2026-10-07T06:05:07.699Z'))).toBe('20261007-060507');
  });
});

describe('findRepoRoot', () => {
  it('walks up to the directory with pnpm-workspace.yaml, else stays put', async () => {
    const root = await tmp();
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    const deep = join(root, 'apps', 'talos');
    await mkdir(deep, { recursive: true });
    expect(findRepoRoot(deep)).toBe(root);
    const lone = await tmp();
    expect(findRepoRoot(lone)).toBe(lone);
  });
});

describe('writeResults', () => {
  it('writes <timestamp>-<codec>.json and .md, creating the directory', async () => {
    const dir = join(await tmp(), 'nested', 'results');
    const report = buildReport({
      meta: { startedAt: '2026-10-07T06:05:07.000Z', durationS: 10, clients: 1, codec: 'msgpack', url: 'ws://x', metricsUrl: null, seed: 1, options: {} },
      recorder: new RunRecorder(0),
      clientsByCodec: { msgpack: 1 },
      phases: null,
      resources: null,
      first: null,
      last: null,
      lagCumulative: null,
    });
    const files = await writeResults(report, dir);
    expect(files.json).toBe(join(dir, '20261007-060507-msgpack.json'));
    expect(JSON.parse(await readFile(files.json, 'utf8')).meta.codec).toBe('msgpack');
    expect(await readFile(files.markdown, 'utf8')).toContain('### 1 clients, 10s, msgpack');
  });
});
