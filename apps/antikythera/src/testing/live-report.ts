import { MongoOrderRepository } from '@apeiron/mnemosyne';
import { LiveClient, groupedRequest, flatRequest, measureDefaultView, measureGroupedView, percentile } from './live-client.js';

/**
 * Live verification against a running stack:
 *   tsx src/testing/live-report.ts --scenario default|grouped|stress|writebehind|restart-check [--seconds 15]
 * Prints one JSON document per scenario.
 */
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const url = arg('url', 'ws://127.0.0.1:4000/ws');
const http = arg('http', 'http://127.0.0.1:4000');
const mongo = arg('mongo', 'mongodb://127.0.0.1:27017');
const scenario = arg('scenario', 'default');
const seconds = Number(arg('seconds', '15'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const getJson = async (path: string): Promise<unknown> => (await fetch(`${http}${path}`)).json();
const print = (name: string, value: unknown): void => console.log(JSON.stringify({ scenario: name, ...(value as object) }, null, 2));

async function stress(): Promise<void> {
  const client = await LiveClient.connect(url);
  await client.getRows(flatRequest());
  await client.control('stress');
  await sleep(8_000); // let the preset take effect and the LIVE population build
  await getJson('/debug/lag?reset=1');
  const mark = Date.now();
  const report = await measureDefaultView(client, seconds);
  const grouped = await measureGroupedView(client, Math.max(5, Math.floor(seconds / 3)));
  const lag = await getJson('/debug/lag');
  const summaries = client.since(mark).flatMap((r) => (r.msg.t === 'summary' ? [r.msg] : []));
  const cpu = summaries.map((s) => s.server.cpu);
  const rss = summaries.map((s) => s.server.rssMb);
  const lagWindows = summaries.map((s) => s.server.elLagMs);
  print('stress', {
    preset: 'stress',
    lagCumulative: (lag as { lag: unknown }).lag,
    perSecondLagP99: { p50: percentile(lagWindows, 50), p99: percentile(lagWindows, 99), max: Math.max(...lagWindows) },
    cpuPercent: { median: percentile(cpu, 50), max: Math.max(...cpu) },
    rssMb: { median: percentile(rss, 50), max: Math.max(...rss) },
    flush: (lag as { flush: unknown }).flush,
    writeBehind: (lag as { writeBehind: unknown }).writeBehind,
    liveStats: (lag as { live: unknown }).live,
    defaultView: report,
    groupedView: grouped,
    health: await getJson('/health'),
  });
  await client.control('medium');
  await client.close();
}

async function writeBehind(): Promise<void> {
  const client = await LiveClient.connect(url);
  await client.getRows(flatRequest());
  const repo = await MongoOrderRepository.connect({ url: mongo, db: 'blotter' });
  const col = repo.database.collection<{ _id: string; filledQty: number; status: string }>('orders');
  const samples: { orderId: string; filledQty: number; status: string; latencyMs: number; viaDelta: number }[] = [];
  const seen = new Set<string>();
  const end = Date.now() + seconds * 1000;
  let cursor = 0;
  while (Date.now() < end && samples.length < 25) {
    const batch = client.received.slice(cursor);
    cursor = client.received.length;
    for (const r of batch) {
      if (r.msg.t !== 'delta' || samples.length >= 25) continue;
      for (const u of r.msg.updates) {
        for (const row of u.rows) {
          if (row.filledQty === undefined || seen.has(row.orderId)) continue;
          seen.add(row.orderId);
          const filledQty = row.filledQty;
          const t0 = r.at;
          let doc = await col.findOne({ _id: row.orderId });
          while ((doc?.filledQty ?? 0) < filledQty && Date.now() - t0 < 5_000) {
            await sleep(25);
            doc = await col.findOne({ _id: row.orderId });
          }
          samples.push({ orderId: row.orderId, filledQty, status: String(row.status ?? ''), latencyMs: Date.now() - t0, viaDelta: r.at - t0 });
        }
      }
    }
    await sleep(100);
  }
  const lat = samples.map((s) => s.latencyMs);
  print('writebehind', {
    samples: samples.length,
    latencyMs: { p50: percentile(lat, 50), p95: percentile(lat, 95), max: Math.max(...lat) },
    notPersistedWithin5s: samples.filter((s) => s.latencyMs >= 5_000).length,
    sample: samples.slice(0, 5),
  });
  await repo.close();
  await client.close();
}

async function restartCheck(): Promise<void> {
  const client = await LiveClient.connect(url);
  const first = await client.getRows(flatRequest());
  const ids = first.rows.map((r) => String(r.orderId));
  const grouped = await client.getRows(groupedRequest());
  const dup = ids.length - new Set(ids).size;
  const health = await getJson('/health');
  const errors = client.received.filter((r) => r.msg.t === 'error').length;
  print('restart-check', { topBlockRows: ids.length, topBlockDuplicates: dup, rootGroups: grouped.rowCount, totalRows: first.rowCount, errors, health });
  await client.close();
}

/** Compares what the server serves with what Mongo holds, for the newest orders and the LIVE ones. Run when the feed is quiet. */
async function consistency(): Promise<void> {
  await sleep(1_500); // let write-behind settle
  const client = await LiveClient.connect(url);
  const repo = await MongoOrderRepository.connect({ url: mongo, db: 'blotter' });
  const col = repo.database.collection('orders');
  const fields = ['status', 'filledQty', 'remainingQty', 'numFills', 'avgFillPrice', 'lastFillQty', 'completedAt', 'orderQty'];
  const live = { ...flatRequest(0, 1_000), filterModel: { status: { filterType: 'set', values: ['LIVE', 'PAUSED', 'PENDING_START'] } } };
  const blocks = [await client.getRows(flatRequest(0, 100)), await client.getRows(live)];
  let checked = 0;
  const mismatches: unknown[] = [];
  for (const block of blocks) {
    for (const row of block.rows) {
      const doc = await col.findOne({ _id: String(row.orderId) as never });
      checked++;
      if (doc === null) {
        mismatches.push({ orderId: row.orderId, problem: 'missing in mongo' });
        continue;
      }
      const diff = fields.filter((f) => (doc as Record<string, unknown>)[f] !== row[f]);
      if (diff.length > 0) mismatches.push({ orderId: row.orderId, fields: diff, server: diff.map((f) => row[f]), mongo: diff.map((f) => (doc as Record<string, unknown>)[f]) });
    }
  }
  const mongoCount = await col.countDocuments({});
  const health = (await getJson('/health')) as { rows: number };
  print('consistency', { rowsChecked: checked, mismatches: mismatches.length, firstMismatches: mismatches.slice(0, 3), serverRows: health.rows, mongoRows: mongoCount, rowCountsEqual: health.rows === mongoCount });
  await repo.close();
  await client.close();
}

switch (scenario) {
  case 'consistency':
    await consistency();
    break;
  case 'default': {
    const client = await LiveClient.connect(url);
    print('default', await measureDefaultView(client, seconds));
    await client.close();
    break;
  }
  case 'grouped': {
    const client = await LiveClient.connect(url);
    print('grouped', await measureGroupedView(client, seconds));
    await client.close();
    break;
  }
  case 'stress':
    await stress();
    break;
  case 'writebehind':
    await writeBehind();
    break;
  case 'restart-check':
    await restartCheck();
    break;
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
process.exit(0);
