import { describe, expect, it } from 'vitest';
import { parseOptions } from './args.js';

describe('parseOptions', () => {
  it('has the plan defaults', () => {
    expect(parseOptions([])).toMatchObject({
      clients: 50,
      duration: 300,
      codec: 'json',
      url: 'ws://127.0.0.1:4000/ws',
      metrics: 'http://127.0.0.1:4000/metrics',
      stressFor: 60,
      switchEvery: 20,
      scrollRate: 2,
      commandRate: 0.1,
      noSpecial: false,
    });
  });

  it('parses flags and ignores the leading -- that pnpm passes through', () => {
    const o = parseOptions(['--', '--clients', '8', '--duration', '30', '--codec', 'both', '--url', 'ws://x/ws', '--no-special', '--seed', '7']);
    expect(o).toMatchObject({ clients: 8, duration: 30, codec: 'both', url: 'ws://x/ws', noSpecial: true, seed: 7 });
  });

  it('puts the slow consumer 20% into the run, at least 10s in', () => {
    expect(parseOptions(['--duration', '300']).slowAt).toBe(60);
    expect(parseOptions(['--duration', '20']).slowAt).toBe(10);
    expect(parseOptions(['--slow-at', '5']).slowAt).toBe(5);
  });

  it('rejects bad values and unknown flags', () => {
    expect(() => parseOptions(['--codec', 'xml'])).toThrow(/codec/);
    expect(() => parseOptions(['--clients', '0'])).toThrow(/clients/);
    expect(() => parseOptions(['--clients', '2.5'])).toThrow(/whole/);
    expect(() => parseOptions(['--duration', 'abc'])).toThrow(/duration/);
    expect(() => parseOptions(['--nope'])).toThrow();
  });

  it('can leave out the slow consumer or the codec switcher alone', () => {
    expect(parseOptions(['--no-slow'])).toMatchObject({ noSlow: true, noSwitcher: false, noSpecial: false });
    expect(parseOptions(['--no-switcher'])).toMatchObject({ noSlow: false, noSwitcher: true });
  });

  it('reads help', () => {
    expect(parseOptions(['-h']).help).toBe(true);
  });
});
