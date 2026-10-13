import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEntitlements } from './entitlements.js';
import { testEntitlements } from './testing/users.js';

const write = (text: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'ent-')), 'entitlements.json');
  writeFileSync(path, text);
  return path;
};

describe('loadEntitlements', () => {
  it('reads the shared file', () => {
    const e = loadEntitlements(new URL('../../../infra/config/entitlements.json', import.meta.url).pathname);
    expect(e).toEqual(testEntitlements);
  });

  it('names the file when it is missing, not JSON, or invalid', () => {
    expect(() => loadEntitlements('/nope/entitlements.json')).toThrow('Cannot read the entitlements file /nope/entitlements.json');
    const garbage = write('{');
    expect(() => loadEntitlements(garbage)).toThrow(`The entitlements file ${garbage} is not valid JSON`);
    const empty = write('{"users":[]}');
    expect(() => loadEntitlements(empty)).toThrow(`The entitlements file ${empty} is invalid`);
  });
});
