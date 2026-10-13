import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = new URL('.', import.meta.url).pathname;
const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
const read = (file: string): string => readFileSync(join(here, file), 'utf8');

describe('helios boundaries', () => {
  it('has no database driver or database package', () => {
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@apeiron/iris', '@apeiron/logos', 'prom-client', 'zod']);
  });

  it('knows nothing about orders: no order state, order subjects or execution traffic', () => {
    for (const file of sources) {
      const text = read(file);
      expect(text, file).not.toMatch(/from '(mongodb|@apeiron\/mnemosyne)'/);
      expect(text, file).not.toMatch(/\bBUCKETS\b|ORDER_STATE|orderState|\bOrder\b|OrderStateRecord|parseOrder|ExecReport|VenueInstruction/);
      expect(text, file).not.toMatch(/SUBJECTS\.(orders\w*|exec\w*)|'orders\.|'exec\./);
    }
  });

  it('asks the order service for one thing only, the reference mids', () => {
    const requests = sources.flatMap((file) => [...read(file).matchAll(/\.request\(\s*([^,]+),/g)].map((m) => m[1]?.trim()));
    expect(requests).toEqual(['SUBJECTS.refMids']);
  });
});
