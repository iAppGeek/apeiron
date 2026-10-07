export type Sample = { name: string; labels: Record<string, string>; value: number };

function parseValue(raw: string): number {
  if (raw === '+Inf' || raw === 'Inf') return Infinity;
  if (raw === '-Inf') return -Infinity;
  return Number(raw);
}

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const eq = text.indexOf('=', i);
    if (eq < 0) break;
    const key = text.slice(i, eq).trim().replace(/^,/, '').trim();
    let j = eq + 1;
    if (text[j] !== '"') break;
    j++;
    let value = '';
    while (j < text.length && text[j] !== '"') {
      if (text[j] === '\\' && j + 1 < text.length) {
        const next = text[j + 1];
        value += next === 'n' ? '\n' : (next as string);
        j += 2;
      } else {
        value += text[j];
        j++;
      }
    }
    labels[key] = value;
    i = j + 1;
    while (text[i] === ',' || text[i] === ' ') i++;
  }
  return labels;
}

/** Parses the Prometheus text exposition format into samples. Comments and malformed lines are skipped. */
export function parseProm(text: string): Sample[] {
  const out: Sample[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;
    if (brace >= 0) {
      const close = line.lastIndexOf('}');
      if (close < brace) continue;
      name = line.slice(0, brace);
      labels = parseLabels(line.slice(brace + 1, close));
      rest = line.slice(close + 1).trim();
    } else {
      const space = line.indexOf(' ');
      if (space < 0) continue;
      name = line.slice(0, space);
      rest = line.slice(space + 1).trim();
    }
    const value = parseValue(rest.split(/\s+/)[0] ?? '');
    if (Number.isNaN(value) && !rest.startsWith('NaN')) continue;
    out.push({ name, labels, value });
  }
  return out;
}

const matches = (sample: Sample, name: string, labels: Record<string, string>): boolean =>
  sample.name === name && Object.entries(labels).every(([k, v]) => sample.labels[k] === v);

/** The value of the first sample with this name whose labels include `labels`. */
export function valueOf(samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number | undefined {
  return samples.find((s) => matches(s, name, labels))?.value;
}

/** The sum over every sample with this name whose labels include `labels`. */
export function sumOf(samples: readonly Sample[], name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const s of samples) if (matches(s, name, labels)) total += s.value;
  return total;
}

export type HistogramDelta = { buckets: { le: number; count: number }[]; count: number; sum: number };

/** Buckets (cumulative), count and sum a histogram gained between two scrapes, merged across the labels not named in `labels`. */
export function histogramDelta(before: readonly Sample[], after: readonly Sample[], name: string, labels: Record<string, string> = {}): HistogramDelta {
  const merge = (samples: readonly Sample[]): Map<number, number> => {
    const byLe = new Map<number, number>();
    for (const s of samples) {
      if (s.name !== `${name}_bucket` || !Object.entries(labels).every(([k, v]) => s.labels[k] === v)) continue;
      const le = parseValue(s.labels.le ?? '');
      byLe.set(le, (byLe.get(le) ?? 0) + s.value);
    }
    return byLe;
  };
  const a = merge(after);
  const b = merge(before);
  const buckets = [...a.keys()]
    .sort((x, y) => x - y)
    .map((le) => ({ le, count: Math.max(0, (a.get(le) ?? 0) - (b.get(le) ?? 0)) }));
  return {
    buckets,
    count: Math.max(0, sumOf(after, `${name}_count`, labels) - sumOf(before, `${name}_count`, labels)),
    sum: sumOf(after, `${name}_sum`, labels) - sumOf(before, `${name}_sum`, labels),
  };
}

/** The `q` quantile (0 to 1) of a histogram, interpolated within its bucket the way Prometheus does. NaN when it has no observations. */
export function histogramQuantile(h: HistogramDelta, q: number): number {
  const total = h.buckets.length === 0 ? 0 : (h.buckets[h.buckets.length - 1] as { count: number }).count;
  if (total === 0) return Number.NaN;
  const rank = q * total;
  let lower = 0;
  let below = 0;
  for (const bucket of h.buckets) {
    if (bucket.count >= rank) {
      if (bucket.le === Infinity) return lower;
      const inBucket = bucket.count - below;
      return inBucket === 0 ? bucket.le : lower + ((bucket.le - lower) * (rank - below)) / inBucket;
    }
    lower = bucket.le;
    below = bucket.count;
  }
  return lower;
}
