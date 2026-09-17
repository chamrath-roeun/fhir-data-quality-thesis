import { describe, it, expect } from 'vitest'
import {
  mean, sd, quantile, summary,
  bootstrapMeanCI, oneSampleTTest,
} from './descriptive'

describe('mean', () => {
  it('averages a small sample', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3)
  })
  it('throws on empty input rather than returning NaN', () => {
    expect(() => mean([])).toThrow(/empty/)
  })
})

describe('sd', () => {
  it('uses Bessel-corrected (n - 1) divisor — matches R sd(1:5) = sqrt(2.5)', () => {
    expect(sd([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2.5), 12)
  })
  it('throws for n < 2 rather than dividing by zero', () => {
    expect(() => sd([7])).toThrow(/2 observations/)
  })
})

describe('quantile (type-7, R/NumPy default)', () => {
  it('picks the exact value at 0 and 1', () => {
    expect(quantile([10, 20, 30], 0)).toBe(10)
    expect(quantile([10, 20, 30], 1)).toBe(30)
  })
  it('interpolates between neighbours for 1..10 at the quartiles', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(quantile(xs, 0.25)).toBeCloseTo(3.25, 12)
    expect(quantile(xs, 0.5)).toBeCloseTo(5.5, 12)
    expect(quantile(xs, 0.75)).toBeCloseTo(7.75, 12)
  })
})

describe('summary', () => {
  it('reports every field of the observed patient-sync latencies', () => {
    // The exact ten values behind the thesis's mean=57.5, median=49, max=134.
    const xs = [43, 45, 47, 49, 49, 49, 52, 68, 89, 134]
    const s = summary(xs)
    expect(s.n).toBe(10)
    expect(s.mean).toBeCloseTo(62.5, 1)
    expect(s.median).toBeCloseTo(49, 1)
    expect(s.min).toBe(43)
    expect(s.max).toBe(134)
    // IQR must be a non-negative number; sanity, not a fixed value.
    expect(s.iqr).toBeGreaterThanOrEqual(0)
    expect(s.q1).toBeLessThanOrEqual(s.median)
    expect(s.q3).toBeGreaterThanOrEqual(s.median)
  })
})

describe('bootstrapMeanCI', () => {
  it('is deterministic under a fixed seed — the thesis rerun must match', () => {
    const xs = [40, 42, 44, 46, 48, 50, 52, 54, 56, 134]
    const a = bootstrapMeanCI(xs, { iterations: 2000, seed: 7 })
    const b = bootstrapMeanCI(xs, { iterations: 2000, seed: 7 })
    expect(a.ciLo).toBe(b.ciLo)
    expect(a.ciHi).toBe(b.ciHi)
  })
  it('brackets the sample mean', () => {
    const xs = [40, 42, 44, 46, 48, 50, 52, 54, 56, 134]
    const ci = bootstrapMeanCI(xs, { iterations: 5000, seed: 42 })
    expect(ci.ciLo).toBeLessThanOrEqual(ci.mean)
    expect(ci.mean).toBeLessThanOrEqual(ci.ciHi)
  })
  it('rejects samples too small for a resample', () => {
    expect(() => bootstrapMeanCI([1])).toThrow(/2 observations/)
  })
})

describe('oneSampleTTest', () => {
  // Reference: R's t.test(c(1..10), mu = 0)
  //   t = 5.7446, df = 9, p-value = 0.0002741
  it('matches R for a known textbook case', () => {
    const r = oneSampleTTest([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0)
    expect(r.t).toBeCloseTo(5.7446, 3)
    expect(r.df).toBe(9)
    // Within ~5 % of R — the incomplete-beta series introduces its own
    // rounding, but this is nowhere near the decision threshold.
    expect(r.pTwoSided).toBeGreaterThan(2.5e-4)
    expect(r.pTwoSided).toBeLessThan(3.0e-4)
  })
  // Effect size: (mean - target) / sd — signed.
  it('reports Cohen d with the right sign', () => {
    const below = oneSampleTTest([1, 2, 3, 4, 5], 100)   // observations well BELOW target
    const above = oneSampleTTest([1000, 1001, 1002, 1003, 1004], 100)
    expect(below.cohensD).toBeLessThan(0)
    expect(above.cohensD).toBeGreaterThan(0)
  })
  // Latency demo: observed sample vs 15 000 ms target — p should be
  // vanishingly small (target is many SDs away).
  it('flags latency as statistically distinguishable from a 15 s target', () => {
    const patientSync = [43, 45, 47, 49, 49, 49, 52, 68, 89, 134]
    const r = oneSampleTTest(patientSync, 15_000)
    expect(r.pTwoSided).toBeLessThan(1e-6)
    expect(r.meanDiff).toBeLessThan(-14_000)
  })
})
