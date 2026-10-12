import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = new URL('.', import.meta.url).pathname;
const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

describe('themis boundaries', () => {
  it('never subscribes to prices: the market snapshot it stores comes from the venue', () => {
    for (const file of sources) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(text, file).not.toMatch(/prices\.|priceSubject|pricesWildcard|parsePriceTick|STREAMS\.prices/);
    }
  });

  it('depends on the database and the bus, not on the blotter or the web app', () => {
    const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@apeiron/iris', '@apeiron/logos', '@apeiron/mnemosyne', 'prom-client', 'zod']);
    for (const file of sources) {
      expect(readFileSync(join(here, file), 'utf8'), file).not.toMatch(/antikythera|pharos|hermes/);
    }
  });
});
