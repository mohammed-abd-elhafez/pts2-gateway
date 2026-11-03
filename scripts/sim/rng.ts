/** A small seeded random source (mulberry32): the simulator must give the same data for the same seed. */
export interface Rng {
  /** uniform in [0, 1) */
  next(): number;
  /** integer in [lo, hi], both included */
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  /** normal with the given mean and standard deviation */
  normal(mean: number, sd: number): number;
  /** exponential with the given mean */
  exp(mean: number): number;
  /** Poisson count; meant for small lambda (below about 10) */
  poisson(lambda: number): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    normal: (mean, sd) => {
      const u = 1 - next();
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    exp: (mean) => -mean * Math.log(1 - next()),
    poisson: (lambda) => {
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
  };
}
