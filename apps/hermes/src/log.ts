import type { LogLevel } from './config.js';

export type Logger = {
  error(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  debug(fields: Record<string, unknown>, msg: string): void;
};

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const serialise = (value: unknown): unknown => (value instanceof Error ? { name: value.name, message: value.message } : value);

/** One JSON object per line on stdout (stderr for errors), like pino's default shape. */
export function createLogger(level: LogLevel, write: (line: string, stream: 'out' | 'err') => void = defaultWrite): Logger {
  const emit = (name: LogLevel, fields: Record<string, unknown>, msg: string): void => {
    if (RANK[name] > RANK[level]) return;
    const entry: Record<string, unknown> = { level: name, time: Date.now(), name: 'hermes', msg };
    for (const [k, v] of Object.entries(fields)) entry[k] = serialise(v);
    write(JSON.stringify(entry), name === 'error' ? 'err' : 'out');
  };
  return {
    error: (f, m) => emit('error', f, m),
    warn: (f, m) => emit('warn', f, m),
    info: (f, m) => emit('info', f, m),
    debug: (f, m) => emit('debug', f, m),
  };
}

function defaultWrite(line: string, stream: 'out' | 'err'): void {
  (stream === 'err' ? process.stderr : process.stdout).write(`${line}\n`);
}
