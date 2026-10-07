import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { markdownSummary } from './format.js';
import type { Report } from './report.js';

/** The nearest parent directory holding `pnpm-workspace.yaml`, or `start` when there is none (inside the container). */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export const stamp = (d: Date): string => d.toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(/[-:]/g, '').replace('T', '-').replace('Z', '');

/** Writes `<dir>/<timestamp>-<codec>.json` and `.md`; returns both paths. */
export async function writeResults(report: Report, dir: string): Promise<{ json: string; markdown: string }> {
  await mkdir(dir, { recursive: true });
  const base = join(dir, `${stamp(new Date(report.meta.startedAt))}-${report.meta.codec}`);
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${base}.md`, markdownSummary(report));
  return { json: `${base}.json`, markdown: `${base}.md` };
}
