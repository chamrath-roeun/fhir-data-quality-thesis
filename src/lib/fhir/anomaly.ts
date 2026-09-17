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
  method: 'iqr' | 'z' | 'adjusted'
  n: number
  flagged: OutlierFinding[]
  thresholds: {
    // IQR fills lowFence/highFence; Z fills mean/sd/k. Both are reported for
    // audit — Chapter 5 quotes them.
    lowFence?: number
    highFence?: number
    mean?: number
    sd?: number
    mc?: number          // medcouple, adjusted boxplot only
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

// ─── Adjusted boxplot (Hubert & Vandervieren 2008) ───────────────────────
//
// Tukey fences assume a roughly symmetric distribution. On a right-skewed
// column — which every price column here is — the upper fence sits too close
// to a long tail of perfectly legitimate high values, so the detector reports
// them as outliers. Hubert and Vandervieren measured this and fixed it by
// scaling each fence by the *medcouple*, a robust skewness statistic that is
// zero for symmetric data and has a 25 % breakdown point.
//
//   MC >= 0:  [Q1 - 1.5·e^(-4·MC)·IQR ,  Q3 + 1.5·e^( 3·MC)·IQR]
//   MC <  0:  [Q1 - 1.5·e^(-3·MC)·IQR ,  Q3 + 1.5·e^( 4·MC)·IQR]
//
// A symmetric column gives MC = 0 and the fences collapse back to Tukey's,
// so this is a strict generalisation rather than a different rule.

/**
 * Medcouple: the median of h(x_i, x_j) over pairs straddling the median.
 * O(n^2); fine for the column sizes here (n <= ~600). Brys, Hubert and
 * Struyf give an O(n log n) algorithm if this ever needs to scale.
 */
export function medcouple(values: readonly number[]): number {
  const n = values.length
  if (n < 3) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const m = quantile7(sorted, 0.5)

  const below = sorted.filter((x) => x <= m)
  const above = sorted.filter((x) => x >= m)
  const k = sorted.filter((x) => x === m).length

  const h: number[] = []
  let tiedBelow = 0
  for (const xi of below) {
    let tiedAbove = 0
    for (const xj of above) {
      if (xi !== xj) {
        h.push(((xj - m) - (m - xi)) / (xj - xi))
      } else {
        // Both sit exactly on the median. The value-based kernel is 0/0 here,
        // so the definition falls back to position within the tied block.
        h.push(Math.sign((k - 1) - (tiedBelow + tiedAbove)))
        tiedAbove++
      }
    }
    if (xi === m) tiedBelow++
  }

  if (h.length === 0) return 0
  h.sort((a, b) => a - b)
  return quantile7(h, 0.5)
}

export function detectAdjustedBoxplot(
  values: readonly number[],
  opts: { k?: number } = {},
): DetectorResult {
  const k = opts.k ?? 1.5
  const n = values.length
  if (n < 4) return { method: 'adjusted', n, flagged: [], thresholds: { k } }

  const sorted = [...values].sort((a, b) => a - b)
  const q1 = quantile7(sorted, 0.25)
  const q3 = quantile7(sorted, 0.75)
  const iqr = q3 - q1
  const mc = medcouple(sorted)

  // Scale each fence by the skewness. Positive MC (right skew) pushes the
  // upper fence out and pulls the lower one in, which is the asymmetry the
  // plain Tukey rule cannot express.
  const [a, b] = mc >= 0 ? [-4, 3] : [-3, 4]
  const lowFence = q1 - k * Math.exp(a * mc) * iqr
  const highFence = q3 + k * Math.exp(b * mc) * iqr

  const flagged: OutlierFinding[] = []
  for (let i = 0; i < n; i++) {
    const x = values[i]
    if (iqr === 0) continue
    if (x < lowFence) {
      flagged.push({ index: i, value: x, reason: 'low', score: (q1 - x) / iqr })
    } else if (x > highFence) {
      flagged.push({ index: i, value: x, reason: 'high', score: (x - q3) / iqr })
    }
  }

  return { method: 'adjusted', n, flagged, thresholds: { lowFence, highFence, mc, k } }
}

// ─── FHIR-facing wrapper ─────────────────────────────────────────────────
//
// The rule-based validator returns Issue[]. This wrapper packages an
// outlier finding into the same Issue shape so a downstream reporter (or
// a Chapter 5 figure) can merge rule-based and statistical findings into
// one table without special-casing.

export interface QualityIssue {
  code: 'outlier-iqr' | 'outlier-z' | 'outlier-adjusted' | (string & {})
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
