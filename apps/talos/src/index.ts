import { join } from 'node:path';
import { USAGE, parseOptions } from './args.js';
import { consoleReport } from './format.js';
import { findRepoRoot, writeResults } from './output.js';
import { runLoadTest } from './run.js';
import { connectWebSocket } from './socket.js';

let options;
try {
  options = parseOptions(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (options.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  process.stderr.write('\ninterrupted: finishing up and reporting what was measured\n');
});

const report = await runLoadTest(options, {
  connect: connectWebSocket,
  stopped: () => interrupted,
  log: (line) => process.stderr.write(`${line}\n`),
});
process.stdout.write(`${consoleReport(report)}\n`);
const dir = options.out ?? join(findRepoRoot(process.cwd()), 'loadtest', 'results');
const files = await writeResults(report, dir);
process.stdout.write(`\nresults: ${files.json}\nsummary: ${files.markdown}\n`);
process.exit(0);
