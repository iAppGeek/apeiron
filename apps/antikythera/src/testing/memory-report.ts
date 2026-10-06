import { forceGc, memorySnapshot } from '../memory.js';
import { generateStore } from './dataset.js';

/** Store memory layout for 1M rows of generator data. Run with `pnpm --filter @apeiron/antikythera memory-report`. */
forceGc();
const baseline = memorySnapshot();
const store = generateStore(1_000_000);
for (const field of ['parentOrderId', 'clientOrderId', 'strategyParams'] as const) store.stringRank(field);
forceGc();
const after = memorySnapshot();
const mem = store.memory();
const mb = (b: number): string => (b / 1048576).toFixed(1).padStart(8);

console.log(`rows ${mem.rows}, capacity ${mem.capacity}`);
console.log(`${'column'.padEnd(20)} ${'kind'.padEnd(7)} ${'used MB'.padStart(8)} ${'reserved MB'.padStart(12)}  note`);
for (const c of mem.columns) {
  const note =
    c.kind === 'enum'
      ? `dictionary ${c.dictionarySize} values, ${c.usedBytes / mem.rows} byte/row`
      : c.kind === 'string'
        ? `string[], ~${(c.estimatedHeapBytes ?? 0) / 1048576 | 0} MB heap (estimate)`
        : '8 byte/row';
  console.log(`${c.field.padEnd(20)} ${c.kind.padEnd(7)} ${mb(c.usedBytes)} ${mb(c.reservedBytes).padStart(12)}  ${note}`);
}
console.log(`typed arrays used     ${mb(mem.typedUsedBytes)} MB`);
console.log(`typed arrays reserved ${mb(mem.typedReservedBytes)} MB (virtual until written)`);
console.log(`string heap estimate  ${mb(mem.estimatedStringHeapBytes)} MB`);
console.log(`orderId -> row Map and string ranks are extra (ranks: 3 x ${mb(mem.rows * 4).trim()} MB)`);
console.log(`heap after GC: ${baseline.heapMb} -> ${after.heapMb} MB (delta ${(after.heapMb - baseline.heapMb).toFixed(1)} MB)`);
console.log(`arrayBuffers: ${baseline.arrayBuffersMb} -> ${after.arrayBuffersMb} MB; rss ${baseline.rssMb} -> ${after.rssMb} MB`);
