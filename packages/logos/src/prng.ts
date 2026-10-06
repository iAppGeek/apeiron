/** A pseudo-random source returning floats in [0, 1). */
export type Rng = () => number;

/** mulberry32: a tiny, fast, seedable 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform float in [min, max). */
export function uniform(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Uniform integer in [min, max] (inclusive). */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Standard normal sample (Box-Muller). Always consumes exactly two draws, so streams stay aligned. */
export function normal(rng: Rng, mean = 0, sd = 1): number {
  const u = 1 - rng();
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Picks an index according to the given non-negative weights. */
export function pickWeightedIndex(rng: Rng, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i] ?? 0;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** Picks an item according to the given weights. */
export function pickWeighted<T>(rng: Rng, items: readonly T[], weights: readonly number[]): T {
  const item = items[pickWeightedIndex(rng, weights)];
  if (item === undefined) throw new Error('pickWeighted: empty item list');
  return item;
}

/** Picks a uniformly random item. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick: empty item list');
  return item;
}
