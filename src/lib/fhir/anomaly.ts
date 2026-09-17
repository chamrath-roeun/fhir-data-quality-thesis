// Statistical outlier detection — a second layer on top of the rule-based
// validation already performed by the FHIR transformers.
//
// The rule-based layer catches shape (missing required fields, wrong types,
// unrecognised code system). It has nothing to say about a claim whose net
// amount is 200× the median, or an encounter whose length of stay is negative
// but not null. That is what this module adds.
//
// Two detectors, deliberately simple so the thesis can defend both:
//
//   • detectIQR — Tukey fences on the interquartile range.
//     Flag if x < Q1 − k·IQR or x > Q3 + k·IQR, k = 1.5 by default.
//     Non-parametric; safe when the distribution is skewed or long-tailed,
//     which cost/LOS data reliably is. Preferred default.
//
//   • detectZ — sample z-score, |x − mean| / sd > threshold.
//     Reported for comparison; sensitive to the very outliers it is trying
//     to detect (they inflate the SD used to threshold them). Kept because
//     it is what an undergrad reader will expect to see, and the contrast
//     with IQR makes the point about robust statistics.
//
// Both return the same shape so the same downstream reporter can consume
// either — enabling a like-for-like false-positive comparison against
// hand-labelled fixtures, which is what Chapter 5 §5.3.4 does.

export interface OutlierFinding {
  index: number     // position in the input array
  value: number
  reason: 'low' | 'high'
  score: number     // for IQR: (Q1 − x)/IQR or (x − Q3)/IQR, whichever fired.
                    // for Z:   (x − mean) / sd, signed.
}

export interface DetectorResult {
  method: 'iqr' | 'z'
  n: number
  flagged: OutlierFinding[]
  thresholds: {
    // IQR fills lowFence/highFence; Z fills mean/sd/k. Both are reported for
    // audit — Chapter 5 quotes them.
    lowFence?: number
    highFence?: number
    mean?: number
    sd?: number
    k: number
  }
}

// ─── IQR / Tukey fences ────────────────────────────────────────────────────

export function detectIQR(
  values: readonly number[],
  opts: { k?: number } = {},
): DetectorResult {
  const k = opts.k ?? 1.5
  const n = values.length
  if (n < 4) {
    // Fewer than four points and quartiles collapse onto the extremes — every
    // point becomes a fence, and every point becomes an outlier. Report empty
    // rather than fabricate a signal from too little data.
    return { method: 'iqr', n, flagged: [], thresholds: { k } }
  }

  const sorted = [...values].sort((a, b) => a - b)
  const q1 = quantile7(sorted, 0.25)
  const q3 = quantile7(sorted, 0.75)
  const iqr = q3 - q1
  const lowFence = q1 - k * iqr
  const highFence = q3 + k * iqr

  const flagged: OutlierFinding[] = []
  for (let i = 0; i < n; i++) {
    const x = values[i]
    if (iqr === 0) continue                // constant column — no fence to speak of
    if (x < lowFence) {
      flagged.push({ index: i, value: x, reason: 'low',  score: (q1 - x) / iqr })
    } else if (x > highFence) {
      flagged.push({ index: i, value: x, reason: 'high', score: (x - q3) / iqr })
    }
  }

  return { method: 'iqr', n, flagged, thresholds: { lowFence, highFence, k } }
}

// ─── z-score ─────────────────────────────────────────────────────────────

export function detectZ(
  values: readonly number[],
  opts: { k?: number } = {},
): DetectorResult {
  const k = opts.k ?? 3
  const n = values.length
  if (n < 2) return { method: 'z', n, flagged: [], thresholds: { k } }

  let sum = 0
  for (const x of values) sum += x
  const mean = sum / n

  let ss = 0
  for (const x of values) ss += (x - mean) * (x - mean)
  const sd = Math.sqrt(ss / (n - 1))

  const flagged: OutlierFinding[] = []
  if (sd === 0) return { method: 'z', n, flagged, thresholds: { mean, sd, k } }

  for (let i = 0; i < n; i++) {
    const z = (values[i] - mean) / sd
    if (Math.abs(z) > k) {
      flagged.push({
        index: i,
        value: values[i],
        reason: z < 0 ? 'low' : 'high',
        score: z,
      })
    }
  }

  return { method: 'z', n, flagged, thresholds: { mean, sd, k } }
}

// ─── FHIR-facing wrapper ─────────────────────────────────────────────────
//
// The rule-based validator returns Issue[]. This wrapper packages an
// outlier finding into the same Issue shape so a downstream reporter (or
// a Chapter 5 figure) can merge rule-based and statistical findings into
// one table without special-casing.

export interface QualityIssue {
  code: 'outlier-iqr' | 'outlier-z' | (string & {})
  severity: 'info' | 'warning' | 'error'
  field: string
  index: number
  message: string
}

export function findingsToIssues(
  field: string,
  result: DetectorResult,
): QualityIssue[] {
  return result.flagged.map((f) => ({
    code: result.method === 'iqr' ? 'outlier-iqr' : 'outlier-z',
    severity: 'warning',
    field,
    index: f.index,
    message:
      result.method === 'iqr'
        ? `value ${f.value} is ${f.score.toFixed(2)}·IQR outside the ` +
          `${f.reason === 'low' ? 'lower' : 'upper'} Tukey fence`
        : `value ${f.value} is z = ${f.score.toFixed(2)} (|z| > ${result.thresholds.k})`,
  }))
}

// Type-7 quantile, matching src/lib/stats/descriptive.ts. Duplicated here so
// this module has no non-test import outside its own file.
function quantile7(sorted: readonly number[], q: number): number {
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo])
}
