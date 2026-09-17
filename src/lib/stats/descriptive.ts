// Descriptive statistics + basic inference for the evaluation chapter.
//
// Kept small and dependency-free on purpose:
//   • the thesis reports a handful of numbers computed once, then baked into
//     LaTeX tables; a NumPy-alike is not warranted
//   • all callers are Node/ts-node scripts under scripts/, so cost of a
//     hand-rolled bootstrap is invisible next to the FHIR round-trips
//     the measurement itself does
//
// What lives here:
//   • summary()        — mean, SD (sample), median, IQR, min, max
//   • bootstrapMeanCI  — non-parametric 95 % CI on the mean
//                        (percentile method, seeded PRNG so a re-run
//                        reproduces the number in the thesis exactly)
//   • oneSampleTTest   — Welch-style one-sample t against a fixed target;
//                        used to show latency is statistically distinguishable
//                        from the 15 000 ms design ceiling, not just eyeballed

export interface Summary {
  n: number
  mean: number
  sd: number      // sample standard deviation (Bessel's correction)
  median: number
  q1: number
  q3: number
  iqr: number
  min: number
  max: number
}

/** Sample mean. Empty array is a caller bug — throws rather than returning NaN. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('mean: empty sample')
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

/** Sample standard deviation (n - 1 denominator). Requires n >= 2. */
export function sd(xs: readonly number[]): number {
  if (xs.length < 2) throw new Error('sd: need at least 2 observations')
  const m = mean(xs)
  let ss = 0
  for (const x of xs) ss += (x - m) * (x - m)
  return Math.sqrt(ss / (xs.length - 1))
}

/** Type-7 quantile (R/NumPy default). q in [0, 1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) throw new Error('quantile: empty sample')
  if (q < 0 || q > 1) throw new Error(`quantile: q out of range: ${q}`)
  const sorted = [...xs].sort((a, b) => a - b)
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}

export function summary(xs: readonly number[]): Summary {
  const sorted = [...xs].sort((a, b) => a - b)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  return {
    n: xs.length,
    mean: mean(xs),
    sd: xs.length >= 2 ? sd(xs) : 0,
    median: quantile(sorted, 0.5),
    q1,
    q3,
    iqr: q3 - q1,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

// ─── Bootstrap 95 % CI on the mean ────────────────────────────────────────
//
// Percentile bootstrap with a seeded PRNG (mulberry32 — 32-bit output, ample
// for a resampler). Seeding makes the numbers reproducible: re-running the
// script for the thesis prints the same CI. Not intended to be
// cryptographically anything; that is the point.

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface BootstrapCI {
  mean: number
  ciLo: number
  ciHi: number
  level: number   // e.g. 0.95
  iterations: number
  seed: number
}

export function bootstrapMeanCI(
  xs: readonly number[],
  opts: { iterations?: number; level?: number; seed?: number } = {},
): BootstrapCI {
  const iterations = opts.iterations ?? 10_000
  const level = opts.level ?? 0.95
  const seed = opts.seed ?? 42
  if (xs.length < 2) throw new Error('bootstrapMeanCI: need at least 2 observations')

  const rng = mulberry32(seed)
  const n = xs.length
  const draws = new Array<number>(iterations)
  for (let i = 0; i < iterations; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += xs[Math.floor(rng() * n)]
    draws[i] = s / n
  }
  const alpha = (1 - level) / 2
  return {
    mean: mean(xs),
    ciLo: quantile(draws, alpha),
    ciHi: quantile(draws, 1 - alpha),
    level,
    iterations,
    seed,
  }
}

// ─── One-sample t-test (two-sided) ────────────────────────────────────────
//
// Tests H0: μ = target vs H1: μ ≠ target. Used in the thesis to say that
// the observed latency is statistically distinguishable from the 15 s
// design ceiling — not just numerically smaller.
//
// P-value is computed from the t distribution's survival function via a
// regularised incomplete beta approximation good to ~1e-8 for the df we
// see (n ≈ 10 → df = 9). Cohen's d is reported alongside so a defence
// panel can see effect size, not just a p-value on a tiny sample.

export interface TTestResult {
  t: number
  df: number
  pTwoSided: number
  meanDiff: number    // observed mean minus target
  cohensD: number     // (mean - target) / sd — signed
  target: number
}

export function oneSampleTTest(xs: readonly number[], target: number): TTestResult {
  if (xs.length < 2) throw new Error('oneSampleTTest: need at least 2 observations')
  const m = mean(xs)
  const s = sd(xs)
  const n = xs.length
  const t = (m - target) / (s / Math.sqrt(n))
  const df = n - 1
  return {
    t,
    df,
    pTwoSided: 2 * studentSurvival(Math.abs(t), df),
    meanDiff: m - target,
    cohensD: (m - target) / s,
    target,
  }
}

// P(T > t | df) for t ≥ 0. Uses the identity
//   P(T > t) = 0.5 · I_{df/(df+t²)}(df/2, 1/2)
// where I is the regularised incomplete beta function.
// Ref: Abramowitz & Stegun 26.7.1.
function studentSurvival(t: number, df: number): number {
  if (t < 0) throw new Error('studentSurvival: expects t >= 0')
  const x = df / (df + t * t)
  return 0.5 * regularisedIncompleteBeta(x, df / 2, 0.5)
}

// Regularised incomplete beta I_x(a, b). Continued-fraction expansion,
// same recipe as Numerical Recipes §6.4 — a small dependency-free port.
function regularisedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b)
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta) / a
  // Continued fraction converges faster from the smaller tail; swap if needed.
  if (x < (a + 1) / (a + b + 2)) {
    return front * betacf(x, a, b)
  }
  return 1 - front * (a / (a + b)) * betacf(1 - x, b, a) * ((a + b) / a)
}

function betacf(x: number, a: number, b: number): number {
  const MAX_IT = 200
  const EPS = 3e-14
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < 1e-300) d = 1e-300
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAX_IT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d
    h *= d * c
    aa = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300
    c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) return h
  }
  throw new Error('betacf: failed to converge')
}

// Lanczos log-gamma, g = 7. Accurate to ~1e-15 for x > 0.
function logGamma(x: number): number {
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  }
  x -= 1
  let a = c[0]
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  const t = x + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}
