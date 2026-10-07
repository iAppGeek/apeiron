import { parseArgs } from 'node:util';

export type CodecChoice = 'json' | 'msgpack' | 'both';

export type Options = {
  clients: number;
  /** Run length in seconds. */
  duration: number;
  codec: CodecChoice;
  url: string;
  metrics: string;
  seed: number;
  out: string | null;
  /** Block requests per second per client. */
  scrollRate: number;
  /** Mean seconds between view changes per client. */
  changeEvery: number;
  /** Commands per second per client. */
  commandRate: number;
  /** Seconds into the run when the stress window opens; null centres it on the run. */
  stressAt: number | null;
  /** Length of the stress window in seconds; 0 turns the coalescer burst off. */
  stressFor: number;
  /** Seconds between the codec switcher's re-hellos. */
  switchEvery: number;
  /** Leave out the slow consumer and the codec switcher. */
  noSpecial: boolean;
  /** Seconds the slow consumer waits before it stops reading. */
  slowAt: number;
  help: boolean;
};

export const USAGE = `Usage: talos [options]

  --clients <n>        WebSocket clients (default 50; one slow consumer and one codec switcher among them when n >= 4)
  --duration <s>       run length in seconds (default 300)
  --codec <c>          json | msgpack | both (default json; both alternates clients)
  --url <ws url>       server WebSocket (default ws://127.0.0.1:4000/ws)
  --metrics <url>      server /metrics, sampled every 2s (default http://127.0.0.1:4000/metrics; "off" disables)
  --seed <n>           scenario seed (default 1)
  --out <dir>          results directory (default <repo>/loadtest/results)
  --scroll-rate <n>    block requests per second per client (default 2)
  --change-every <s>   mean seconds between view changes per client (default 45)
  --command-rate <n>   commands per second per client (default 0.1)
  --stress-at <s>      when the 60s stress window opens (default: centred in the run)
  --stress-for <s>     stress window length, 0 to skip (default 60)
  --switch-every <s>   codec switcher period (default 20)
  --slow-at <s>        when the slow consumer stops reading (default 20% into the run, at least 10s)
  --no-special         no slow consumer, codec switcher or stress window
  -h, --help
`;

function num(name: string, raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) throw new Error(`--${name} must be a number >= ${min}, got "${raw}"`);
  return value;
}

/** Parses the command line. A leading `--` (what `pnpm start -- ...` passes through) is ignored. */
export function parseOptions(argv: readonly string[]): Options {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      clients: { type: 'string' },
      duration: { type: 'string' },
      codec: { type: 'string' },
      url: { type: 'string' },
      metrics: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
      'scroll-rate': { type: 'string' },
      'change-every': { type: 'string' },
      'command-rate': { type: 'string' },
      'stress-at': { type: 'string' },
      'stress-for': { type: 'string' },
      'switch-every': { type: 'string' },
      'slow-at': { type: 'string' },
      'no-special': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const codec = values.codec ?? 'json';
  if (codec !== 'json' && codec !== 'msgpack' && codec !== 'both') throw new Error(`--codec must be json, msgpack or both, got "${codec}"`);
  const clients = num('clients', values.clients, 50, 1);
  if (!Number.isInteger(clients)) throw new Error('--clients must be a whole number');
  const duration = num('duration', values.duration, 300, 1);
  return {
    clients,
    duration,
    codec,
    url: values.url ?? 'ws://127.0.0.1:4000/ws',
    metrics: values.metrics ?? 'http://127.0.0.1:4000/metrics',
    seed: num('seed', values.seed, 1, 0),
    out: values.out ?? null,
    scrollRate: num('scroll-rate', values['scroll-rate'], 2, 0.01),
    changeEvery: num('change-every', values['change-every'], 45, 1),
    commandRate: num('command-rate', values['command-rate'], 0.1, 0.001),
    stressAt: values['stress-at'] === undefined ? null : num('stress-at', values['stress-at'], 0, 0),
    stressFor: num('stress-for', values['stress-for'], 60, 0),
    switchEvery: num('switch-every', values['switch-every'], 20, 1),
    noSpecial: values['no-special'] === true,
    slowAt: num('slow-at', values['slow-at'], Math.max(10, duration * 0.2), 0),
    help: values.help === true,
  };
}
