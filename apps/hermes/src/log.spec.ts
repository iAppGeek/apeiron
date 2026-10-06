import { describe, expect, it } from 'vitest';
import { createLogger } from './log.js';

describe('createLogger', () => {
  it('writes one JSON line per entry with the fields merged in', () => {
    const lines: [string, string][] = [];
    const log = createLogger('info', (line, stream) => lines.push([line, stream]));
    log.info({ rows: 3 }, 'hello');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]?.[0] ?? '{}')).toMatchObject({ level: 'info', name: 'hermes', msg: 'hello', rows: 3 });
    expect(lines[0]?.[1]).toBe('out');
  });

  it('filters by level and sends errors to stderr, serialising Error objects', () => {
    const lines: [string, string][] = [];
    const log = createLogger('warn', (line, stream) => lines.push([line, stream]));
    log.debug({}, 'no');
    log.info({}, 'no');
    log.warn({}, 'yes');
    log.error({ err: new Error('boom') }, 'bad');
    expect(lines.map((l) => JSON.parse(l[0]).msg)).toEqual(['yes', 'bad']);
    expect(lines[1]?.[1]).toBe('err');
    expect(JSON.parse(lines[1]?.[0] ?? '{}').err).toEqual({ name: 'Error', message: 'boom' });
  });
});
