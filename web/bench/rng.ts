// Deterministic randomness for AirlockBench: the same seed always yields the same dataset, byte for byte.

/** FNV-1a 32-bit hash — derives per-item seeds from strings. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough for synthetic data. Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export const pick = <T>(r: Rng, xs: readonly T[]): T => {
  if (xs.length === 0) throw new Error("pick from empty list");
  return xs[Math.floor(r() * xs.length)]!;
};
export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const digits = (r: Rng, n: number): string => Array.from({ length: n }, () => String(int(r, 0, 9))).join("");

/** `k` distinct elements in a deterministic order. */
export function sample<T>(r: Rng, xs: readonly T[], k: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < k && pool.length > 0) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return out;
}

/** A deterministic fraction in [0, 1) for a key — used to decide mock misses without consuming an RNG stream. */
export const unit = (key: string): number => hash32(key) / 4294967296;
