import { describe, it, expect } from 'vitest'
import { detectIQR, detectZ, findingsToIssues, medcouple, detectAdjustedBoxplot } from './anomaly'

describe('detectIQR', () => {
  // Textbook Tukey example: for [1..10] Q1=3.25, Q3=7.75, IQR=4.5,
  // fences at [-3.5, 14.5]. 100 sits outside → flagged high.
  it('flags a single high outlier a Tukey-fence method should catch', () => {
    const r = detectIQR([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100])
    expect(r.flagged).toHaveLength(1)
    expect(r.flagged[0].value).toBe(100)
    expect(r.flagged[0].reason).toBe('high')
    expect(r.thresholds.highFence).toBeGreaterThan(10)
    expect(r.thresholds.highFence).toBeLessThan(50)
  })

  it('flags a symmetric low outlier at the other fence', () => {
    const r = detectIQR([-100, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(r.flagged.some(f => f.value === -100 && f.reason === 'low')).toBe(true)
  })

  it('returns nothing when the sample is too small to define quartiles', () => {
    const r = detectIQR([1, 2, 3])
    expect(r.flagged).toEqual([])
  })

  it('flags nothing on a constant column — IQR = 0 has no fence', () => {
    const r = detectIQR([7, 7, 7, 7, 7])
    expect(r.flagged).toEqual([])
  })

  it('a stricter k narrows the fence and flags more points', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20]
    const strict = detectIQR(xs, { k: 0.5 })
    const lax    = detectIQR(xs, { k: 3.0 })
    expect(strict.flagged.length).toBeGreaterThan(lax.flagged.length)
  })
})

describe('detectZ', () => {
  it('flags what its k threshold names', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]
    const r = detectZ(xs, { k: 2 })
    expect(r.flagged.some(f => f.value === 100)).toBe(true)
  })

  // Illustrates the masking effect: a huge outlier inflates the SD used to
  // threshold it. The thesis discussion cites this as the reason to prefer
  // IQR here.
  it('a single 10 000× outlier can go undetected because it inflates its own SD', () => {
    const xs = [1, 2, 3, 4, 5, 10_000]
    const r = detectZ(xs, { k: 3 })
    // 10 000 does NOT clear |z| > 3 here — its own weight in the SD makes
    // z ≈ 2.2. IQR catches it easily.
    expect(r.flagged).toEqual([])
    const rIqr = detectIQR([1, 2, 3, 4, 5, 10_000])
    expect(rIqr.flagged.some(f => f.value === 10_000)).toBe(true)
  })

  it('degenerates cleanly when SD is 0', () => {
    const r = detectZ([5, 5, 5, 5])
    expect(r.flagged).toEqual([])
  })
})

describe('findingsToIssues', () => {
  it('projects both detector types into the shared QualityIssue shape', () => {
    const iqr = detectIQR([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100])
    const z   = detectZ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100], { k: 2 })
    const iqrIssues = findingsToIssues('claim.net', iqr)
    const zIssues   = findingsToIssues('claim.net', z)
    expect(iqrIssues[0].code).toBe('outlier-iqr')
    expect(zIssues[0].code).toBe('outlier-z')
    for (const i of [...iqrIssues, ...zIssues]) {
      expect(i.severity).toBe('warning')
      expect(i.field).toBe('claim.net')
      expect(typeof i.message).toBe('string')
    }
  })
})

describe('medcouple', () => {
  it('is 0 for a symmetric sample', () => {
    expect(medcouple([1, 2, 3, 4, 5])).toBeCloseTo(0, 12)
    expect(medcouple([-3, -2, -1, 0, 1, 2, 3])).toBeCloseTo(0, 12)
  })

  it('is positive for a genuinely right-skewed sample', () => {
    // Skewed in shape, not by a single extreme point.
    expect(medcouple([1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 11, 15, 21, 30, 44]))
      .toBeCloseTo(0.569231, 5)
  })

  it('is negative for the mirror image of that sample', () => {
    const skewed = [1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 11, 15, 21, 30, 44]
    expect(medcouple(skewed.map(x => -x))).toBeCloseTo(-0.569231, 5)
  })

  it('stays within [-1, 1]', () => {
    for (const xs of [[1, 2, 3, 4, 1e6], [1, 1, 1, 2, 3], [5, 5, 5, 5, 5, 9]]) {
      const mc = medcouple(xs)
      expect(mc).toBeGreaterThanOrEqual(-1)
      expect(mc).toBeLessThanOrEqual(1)
    }
  })

  // A single extreme point is not skew. For [1..10, 100] the kernel yields 36
  // pairs — 15 negative, 5 zero, 16 positive — so the median lands exactly on
  // zero. Hand-computed from the definition; this is the 25 % breakdown point
  // doing its job, since one outlier in eleven is well inside it.
  it('resists a lone outlier, which is the point of a robust statistic', () => {
    expect(medcouple([1,2,3,4,5,6,7,8,9,10,100])).toBeCloseTo(0, 12)
  })
})

describe('detectAdjustedBoxplot', () => {
  it('collapses to Tukey fences when the data is symmetric (MC = 0)', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]
    const adj = detectAdjustedBoxplot(xs)
    // Symmetric core, so the adjustment should not move the fence far.
    expect(adj.flagged.some(f => f.value === 100)).toBe(true)
  })

  it('tolerates a legitimate right tail that Tukey fences reject', () => {
    // Right-skewed but clean: no value here is an error.
    const skewed = [1, 1, 2, 2, 3, 3, 4, 5, 6, 8, 11, 15, 21, 30, 44]
    const tukey = detectIQR(skewed)
    const adj = detectAdjustedBoxplot(skewed)
    expect(adj.flagged.length).toBeLessThanOrEqual(tukey.flagged.length)
    expect(adj.thresholds.mc!).toBeGreaterThan(0)
    expect(adj.thresholds.highFence!).toBeGreaterThan(tukey.thresholds.highFence!)
  })

  it('reports the medcouple it used', () => {
    const r = detectAdjustedBoxplot([1, 2, 3, 4, 5, 6, 7, 8, 9, 50])
    expect(typeof r.thresholds.mc).toBe('number')
    expect(r.method).toBe('adjusted')
  })
})
