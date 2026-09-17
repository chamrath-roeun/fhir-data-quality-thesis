/**
 * Supervised evaluation of the two outlier detectors in src/lib/fhir/anomaly.ts.
 *
 * Chapter 5 reports flag rates and the overlap between the detectors, but not
 * precision or recall, because the ANZER snapshot carries no labels: nothing in
 * the data says which rows are wrong. This script manufactures the labels it
 * needs by corrupting values at positions it chooses, which makes the ground
 * truth exact by construction.
 *
 * Two settings, because each answers a different objection:
 *
 *   A. Synthetic log-normal baseline. Clean by construction, so a flag on a
 *      non-injected row is a genuine false positive and precision is exact.
 *      Cost: the distribution is my assumption, not the hospital's.
 *
 *   B. Real ANZER columns. Realistic shape, but the column may already contain
 *      anomalies, so a flag on a non-injected row is not necessarily wrong.
 *      Precision here is therefore a LOWER BOUND, and is labelled as such.
 *
 * Corruption modes are the failure modes a priced line item actually suffers:
 * a missing decimal point, an order-of-magnitude slip, two transposed digits,
 * and a zeroed value standing in for "not recorded".
 *
 * Run:
 *   cd GOP-MVP && npx tsx scripts/evaluate-detectors.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectIQR, detectZ, detectAdjustedBoxplot } from '../src/lib/fhir/anomaly'

const RESULTS_DIR = join(process.cwd(), 'scripts', 'results')
const DUMP = join(RESULTS_DIR, 'anzer-dump.json')

const TRIALS = 200
const INJECTION_RATE = 0.05        // fraction of rows corrupted per trial
const BASE_SEED = 42

const IQR_KS = [1.0, 1.5, 2.0, 3.0]
const Z_KS = [2.0, 2.5, 3.0, 3.5]

// ─── seeded PRNG (same generator as src/lib/stats/descriptive.ts) ──────────

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

// ─── corruption modes ─────────────────────────────────────────────────────

type Mode = 'decimal-shift' | 'magnitude' | 'transposition' | 'zeroed'
const MODES: Mode[] = ['decimal-shift', 'magnitude', 'transposition', 'zeroed']

function corrupt(x: number, mode: Mode, rng: () => number): number {
  switch (mode) {
    case 'decimal-shift':
      // A missing decimal point: 12.50 typed as 1250.
      return x * (rng() < 0.5 ? 10 : 100)
    case 'magnitude':
      return x * 1000
    case 'transposition': {
      // Swap two adjacent digits of the integer part.
      const intPart = Math.trunc(Math.abs(x))
      const s = String(intPart)
      if (s.length < 2) return x * 10          // nothing to transpose
      const i = Math.floor(rng() * (s.length - 1))
      const swapped = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2)
      const frac = Math.abs(x) - intPart
      return Math.sign(x || 1) * (Number(swapped) + frac)
    }
    case 'zeroed':
      return 0
  }
}

/** Corrupts index `i`, retrying modes until the value actually changes. */
function corruptDistinct(x: number, rng: () => number): { value: number; mode: Mode } {
  for (let attempt = 0; attempt < 8; attempt++) {
    const mode = MODES[Math.floor(rng() * MODES.length)]
    const v = corrupt(x, mode, rng)
    if (Number.isFinite(v) && v !== x) return { value: v, mode }
  }
  return { value: x * 100, mode: 'decimal-shift' }
}

// ─── one trial ────────────────────────────────────────────────────────────

interface Scores { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number }

function score(flagged: Set<number>, injected: Set<number>): Scores {
  let tp = 0, fp = 0
  for (const i of flagged) (injected.has(i) ? tp++ : fp++)
  const fn = injected.size - tp
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = injected.size === 0 ? 0 : tp / injected.size
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return { precision, recall, f1, tp, fp, fn }
}

function runTrial(base: readonly number[], rng: () => number, iqrK: number, zK: number) {
  const n = base.length
  const nInject = Math.max(1, Math.round(n * INJECTION_RATE))

  const values = [...base]
  const injected = new Set<number>()
  const modeCount: Record<string, number> = {}

  while (injected.size < nInject) {
    const i = Math.floor(rng() * n)
    if (injected.has(i)) continue
    const { value, mode } = corruptDistinct(base[i], rng)
    values[i] = value
    injected.add(i)
    modeCount[mode] = (modeCount[mode] ?? 0) + 1
  }

  const iqr = detectIQR(values, { k: iqrK })
  const z = detectZ(values, { k: zK })
  const adj = detectAdjustedBoxplot(values, { k: iqrK })

  return {
    iqr: score(new Set(iqr.flagged.map(f => f.index)), injected),
    z: score(new Set(z.flagged.map(f => f.index)), injected),
    adj: score(new Set(adj.flagged.map(f => f.index)), injected),
    modeCount,
  }
}

function meanSd(xs: number[]): { mean: number; sd: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const varc = xs.length < 2 ? 0 : xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
  return { mean, sd: Math.sqrt(varc) }
}

function evaluate(base: readonly number[], iqrK: number, zK: number) {
  const acc = {
    iqrP: [] as number[], iqrR: [] as number[], iqrF: [] as number[],
    zP: [] as number[], zR: [] as number[], zF: [] as number[],
    aP: [] as number[], aR: [] as number[], aF: [] as number[],
  }
  const modes: Record<string, number> = {}

  for (let t = 0; t < TRIALS; t++) {
    const r = runTrial(base, mulberry32(BASE_SEED + t), iqrK, zK)
    acc.iqrP.push(r.iqr.precision); acc.iqrR.push(r.iqr.recall); acc.iqrF.push(r.iqr.f1)
    acc.zP.push(r.z.precision);     acc.zR.push(r.z.recall);     acc.zF.push(r.z.f1)
    acc.aP.push(r.adj.precision);   acc.aR.push(r.adj.recall);   acc.aF.push(r.adj.f1)
    for (const [m, c] of Object.entries(r.modeCount)) modes[m] = (modes[m] ?? 0) + c
  }

  return {
    n: base.length, trials: TRIALS, iqrK, zK,
    iqr: { precision: meanSd(acc.iqrP), recall: meanSd(acc.iqrR), f1: meanSd(acc.iqrF) },
    z:   { precision: meanSd(acc.zP),   recall: meanSd(acc.zR),   f1: meanSd(acc.zF) },
    adj: { precision: meanSd(acc.aP),   recall: meanSd(acc.aR),   f1: meanSd(acc.aF) },
    modes,
  }
}

// ─── baselines ────────────────────────────────────────────────────────────

/** Log-normal baseline: right-skewed and strictly positive, like a price column. */
function syntheticBaseline(n: number, seed: number): number[] {
  const rng = mulberry32(seed)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    // Box-Muller for a standard normal, then exponentiate.
    const u1 = Math.max(rng(), 1e-12), u2 = rng()
    const zz = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    out.push(Math.round(Math.exp(3.2 + 0.85 * zz) * 100) / 100)
  }
  return out
}

function realColumns(minN: number): Array<{ name: string; values: number[] }> {
  const dump = JSON.parse(readFileSync(DUMP, 'utf8')) as Record<string, unknown>
  const cols: Array<{ name: string; values: number[] }> = []

  for (const [table, payload] of Object.entries(dump)) {
    if (!Array.isArray(payload)) continue
    const rows = payload as Array<Record<string, unknown>>
    if (rows.length === 0) continue
    const names = new Set<string>()
    for (const r of rows) for (const c of Object.keys(r)) names.add(c)

    for (const col of names) {
      const nums = rows.map(r => r[col]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      const distinct = new Set(nums).size
      if (nums.length >= minN && distinct >= 10 && nums.some(v => v > 0)) {
        cols.push({ name: `${table}.${col}`, values: nums })
      }
    }
  }
  return cols.sort((a, b) => b.values.length - a.values.length)
}

// ─── reporting ────────────────────────────────────────────────────────────

const pct = (m: { mean: number; sd: number }) =>
  `${(m.mean * 100).toFixed(1)}\\,\\% (${(m.sd * 100).toFixed(1)})`

function escapeTex(s: string): string {
  return s.replace(/([&%$#_{}])/g, '\\$1')
}

function main() {
  console.log(`Supervised detector evaluation — ${TRIALS} trials, ${(INJECTION_RATE * 100).toFixed(0)}% injection rate\n`)

  // ---- Setting A: synthetic, clean by construction ----
  const synth = syntheticBaseline(200, 7)
  const a = evaluate(synth, 1.5, 3.0)
  console.log(`Setting A — synthetic log-normal baseline (n=${a.n})`)
  console.log(`  IQR  P=${(a.iqr.precision.mean * 100).toFixed(1)}%  R=${(a.iqr.recall.mean * 100).toFixed(1)}%  F1=${(a.iqr.f1.mean * 100).toFixed(1)}%`)
  console.log(`  z    P=${(a.z.precision.mean * 100).toFixed(1)}%  R=${(a.z.recall.mean * 100).toFixed(1)}%  F1=${(a.z.f1.mean * 100).toFixed(1)}%`)
  console.log(`  adj  P=${(a.adj.precision.mean * 100).toFixed(1)}%  R=${(a.adj.recall.mean * 100).toFixed(1)}%  F1=${(a.adj.f1.mean * 100).toFixed(1)}%`)

  // ---- Setting B: real ANZER columns ----
  const cols = realColumns(60).slice(0, 6)
  const bResults = cols.map(c => ({ column: c.name, ...evaluate(c.values, 1.5, 3.0) }))
  console.log(`\nSetting B — real ANZER columns (precision is a lower bound)`)
  for (const r of bResults) {
    console.log(`  ${r.column.padEnd(36)} IQR P=${(r.iqr.precision.mean*100).toFixed(1)}%/R=${(r.iqr.recall.mean*100).toFixed(1)}%  adj P=${(r.adj.precision.mean*100).toFixed(1)}%/R=${(r.adj.recall.mean*100).toFixed(1)}%  z P=${(r.z.precision.mean*100).toFixed(1)}%/R=${(r.z.recall.mean*100).toFixed(1)}%`)
  }

  // ---- Sensitivity sweep on the synthetic baseline ----
  const sweep = {
    iqr: IQR_KS.map(k => ({ k, ...evaluate(synth, k, 3.0).iqr })),
    z:   Z_KS.map(k   => ({ k, ...evaluate(synth, 1.5, k).z })),
  }
  console.log(`\nSensitivity (synthetic baseline)`)
  for (const s of sweep.iqr) console.log(`  IQR k=${s.k.toFixed(1)}  P=${(s.precision.mean * 100).toFixed(1)}%  R=${(s.recall.mean * 100).toFixed(1)}%  F1=${(s.f1.mean * 100).toFixed(1)}%`)
  for (const s of sweep.z)   console.log(`  z   k=${s.k.toFixed(1)}  P=${(s.precision.mean * 100).toFixed(1)}%  R=${(s.recall.mean * 100).toFixed(1)}%  F1=${(s.f1.mean * 100).toFixed(1)}%`)

  // ---- LaTeX ----
  const tex = [
    `% Auto-generated by scripts/evaluate-detectors.ts — do not edit by hand.`,
    `% Re-run: cd GOP-MVP && npx tsx scripts/evaluate-detectors.ts`,
    ``,
    `\\begin{table}[htbp]`,
    `\\centering`,
    `\\caption{Detector performance against injected ground truth, ${TRIALS} trials per cell at a ${(INJECTION_RATE * 100).toFixed(0)}\\,\\% injection rate, with $k = 1.5$ for the Tukey fences and $|z| > 3$ for the $z$-score. Standard deviation across trials in parentheses. In Setting~B the baseline column may already contain genuine anomalies, so a flag on a non-injected row is not necessarily an error and precision is a lower bound.}`,
    `\\label{tab:detector-supervised}`,
    `\\begin{tabular}{llrrrr}`,
    `\\hline`,
    `\\textbf{Setting} & \\textbf{Detector} & \\textbf{n} & \\textbf{Precision} & \\textbf{Recall} & \\textbf{F1} \\\\`,
    `\\hline`,
    `A: synthetic & Tukey IQR & ${a.n} & ${pct(a.iqr.precision)} & ${pct(a.iqr.recall)} & ${pct(a.iqr.f1)} \\\\`,
    `A: synthetic & $z$-score & ${a.n} & ${pct(a.z.precision)} & ${pct(a.z.recall)} & ${pct(a.z.f1)} \\\\`,
    `A: synthetic & Adjusted boxplot & ${a.n} & ${pct(a.adj.precision)} & ${pct(a.adj.recall)} & ${pct(a.adj.f1)} \\\\`,
    `\\hline`,
    ...bResults.flatMap(r => [
      `B: \\texttt{${escapeTex(r.column)}} & Tukey IQR & ${r.n} & ${pct(r.iqr.precision)} & ${pct(r.iqr.recall)} & ${pct(r.iqr.f1)} \\\\`,
      `B: \\texttt{${escapeTex(r.column)}} & $z$-score & ${r.n} & ${pct(r.z.precision)} & ${pct(r.z.recall)} & ${pct(r.z.f1)} \\\\`,
      `B: \\texttt{${escapeTex(r.column)}} & Adjusted boxplot & ${r.n} & ${pct(r.adj.precision)} & ${pct(r.adj.recall)} & ${pct(r.adj.f1)} \\\\`,
    ]),
    `\\hline`,
    `\\end{tabular}`,
    `\\end{table}`,
    ``,
    `\\begin{table}[htbp]`,
    `\\centering`,
    `\\caption{Threshold sensitivity on the synthetic baseline. Each row varies one detector's threshold while the other is held at its default. Loosening the Tukey fence trades recall for precision; the $z$-score threshold cannot recover the recall the Tukey fences reach at any setting tested.}`,
    `\\label{tab:detector-sensitivity}`,
    `\\begin{tabular}{llrrr}`,
    `\\hline`,
    `\\textbf{Detector} & \\textbf{Threshold} & \\textbf{Precision} & \\textbf{Recall} & \\textbf{F1} \\\\`,
    `\\hline`,
    ...sweep.iqr.map(s => `Tukey IQR & $k = ${s.k.toFixed(1)}$ & ${pct(s.precision)} & ${pct(s.recall)} & ${pct(s.f1)} \\\\`),
    `\\hline`,
    ...sweep.z.map(s => `$z$-score & $|z| > ${s.k.toFixed(1)}$ & ${pct(s.precision)} & ${pct(s.recall)} & ${pct(s.f1)} \\\\`),
    `\\hline`,
    `\\end{tabular}`,
    `\\end{table}`,
    ``,
  ].join('\n')

  writeFileSync(join(RESULTS_DIR, 'detector-evaluation.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    trials: TRIALS, injectionRate: INJECTION_RATE, baseSeed: BASE_SEED,
    settingA: a, settingB: bResults, sensitivity: sweep,
  }, null, 2))
  writeFileSync(join(RESULTS_DIR, 'detector-evaluation.tex'), tex)
  console.log(`\nWrote scripts/results/detector-evaluation.json and .tex`)
}

main()
