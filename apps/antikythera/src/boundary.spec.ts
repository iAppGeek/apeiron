import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = new URL('.', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('antikythera boundaries', () => {
  it('has no database driver or database package', () => {
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const deps = Object.keys(pkg.dependencies);
    expect(deps).not.toContain('mongodb');
    expect(deps).not.toContain('@apeiron/mnemosyne');
    expect(deps.filter((d) => /mongo|mnemosyne|oracle|kdb|pg$/i.test(d))).toEqual([]);
  });

  it('imports neither a database package nor the order lifecycle rules that belong to the order service', () => {
    for (const file of sourceFiles(here)) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from '(mongodb|@apeiron\/mnemosyne)'/);
      expect(text, file).not.toMatch(/\b(applyExecReport|applyAmend|validateSubmission|MongoOrderRepository)\b/);
    }
  });
});
