/**
 * Exploratory data analysis over the ANZER test-database snapshot at
 * scripts/results/anzer-dump.json.
 *
 * For every table × column captured in the dump, computes:
 *   - populated fraction    (1 - null-rate)
 *   - cardinality           (distinct non-null value count)
 *   - value type mix        (fraction numeric / string / boolean / other)
 *   - top-K frequent values (for enumerated / categorical columns)
 *   - descriptive stats     (mean, SD, quartiles) for numeric columns
 *
 * Writes:
 *   - scripts/results/anzer-profile.json   full machine-readable profile
 *   - scripts/results/anzer-profile.tex    a compact LaTeX summary table
 *                                           for chapter 5 §5.5
 *
 * Run:
 *   cd GOP-MVP && npx tsx scripts/profile-anzer-schema.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summary as descSummary } from '../src/lib/stats/descriptive'

const RESULTS_DIR = join(process.cwd(), 'scripts', 'results')
const DUMP = join(RESULTS_DIR, 'anzer-dump.json')

type Row = Record<string, unknown>

interface ColumnProfile {
  table: string
  column: string
  total: number
  populated: number
  populatedRate: number
  cardinality: number
  types: Record<string, number>          // 'number' | 'string' | 'boolean' | 'null' | 'other'
  topValues: Array<[string, number]>     // sorted desc; up to TOP_K
  numeric: null | ReturnType<typeof descSummary>
}

const TOP_K = 5

function classify(v: unknown): 'number' | 'string' | 'boolean' | 'null' | 'other' {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return 'number'
  if (t === 'string') return 'string'
  if (t === 'boolean') return 'boolean'
  return 'other'
}

function isNullish(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '')
}

function profileColumn(table: string, column: string, values: unknown[]): ColumnProfile {
  const total = values.length
  const types: Record<string, number> = {}
  const numeric: number[] = []
  const counts = new Map<string, number>()
  let populated = 0

  for (const v of values) {
    const kind = classify(v)
    types[kind] = (types[kind] ?? 0) + 1
    if (isNullish(v)) continue
    populated++
    if (typeof v === 'number' && Number.isFinite(v)) numeric.push(v)
    const key = typeof v === 'object' ? JSON.stringify(v) : String(v)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_K)

  return {
    table,
    column,
    total,
    populated,
    populatedRate: total === 0 ? 0 : populated / total,
    cardinality: counts.size,
    types,
    topValues,
    numeric: numeric.length >= 2 ? descSummary(numeric) : null,
  }
}

function profileTable(table: string, rows: Row[]): ColumnProfile[] {
  if (rows.length === 0) return []
  const columns = new Set<string>()
  for (const r of rows) for (const c of Object.keys(r)) columns.add(c)

  return [...columns].map((col) => {
    const values = rows.map((r) => r[col])
    return profileColumn(table, col, values)
  })
}

function main() {
  const dump = JSON.parse(readFileSync(DUMP, 'utf8')) as Record<string, unknown>

  const allProfiles: ColumnProfile[] = []
  const perTable: Record<string, { rows: number; columns: number; populatedMean: number }> = {}

  for (const [table, payload] of Object.entries(dump)) {
    if (!Array.isArray(payload)) continue
    const profiles = profileTable(table, payload as Row[])
    allProfiles.push(...profiles)

    const populatedMean = profiles.length === 0
      ? 0
      : profiles.reduce((a, p) => a + p.populatedRate, 0) / profiles.length
    perTable[table] = { rows: (payload as Row[]).length, columns: profiles.length, populatedMean }
  }

  // Console summary
  console.log(`Loaded ${Object.keys(perTable).length} tables from ${DUMP}\n`)
  const tableRows = Object.entries(perTable).sort((a, b) => b[1].rows - a[1].rows)
  console.log(`Top-10 tables by row count:`)
  for (const [name, s] of tableRows.slice(0, 10)) {
    console.log(`  ${name.padEnd(28)} rows=${String(s.rows).padStart(5)}  cols=${String(s.columns).padStart(3)}  mean populated = ${(s.populatedMean * 100).toFixed(1)}%`)
  }

  const totalCols = allProfiles.length
  const populatedMean = totalCols === 0 ? 0 : allProfiles.reduce((a, p) => a + p.populatedRate, 0) / totalCols
  const alwaysPopulated = allProfiles.filter((p) => p.populatedRate === 1).length
  const neverPopulated  = allProfiles.filter((p) => p.populatedRate === 0).length
  const binaryOrEnum    = allProfiles.filter((p) => p.cardinality > 0 && p.cardinality <= 5).length
  const numericCols     = allProfiles.filter((p) => p.numeric !== null).length

  console.log(`\nOverall over ${totalCols} columns:`)
  console.log(`  mean populated fraction: ${(populatedMean * 100).toFixed(1)}%`)
  console.log(`  columns always populated: ${alwaysPopulated} (${(alwaysPopulated / totalCols * 100).toFixed(1)}%)`)
  console.log(`  columns never populated:  ${neverPopulated} (${(neverPopulated / totalCols * 100).toFixed(1)}%)`)
  console.log(`  low-cardinality (≤5):     ${binaryOrEnum}`)
  console.log(`  numeric columns:          ${numericCols}`)

  // LaTeX — per-table summary (compact, one row per table). Also emit a
  // detail table listing every column mapped to the FHIR layer, if a
  // caller wants to inline it.
  const tableSummary: string[] = []
  for (const [name, s] of tableRows) {
    tableSummary.push(`${escapeTex(name)} & ${s.rows} & ${s.columns} & ${(s.populatedMean * 100).toFixed(1)}\\% \\\\`)
  }

  const tex = [
    `% Auto-generated by scripts/profile-anzer-schema.ts — do not edit by hand.`,
    `% Re-run: cd GOP-MVP && npx tsx scripts/profile-anzer-schema.ts`,
    ``,
    `\\begin{table}[htbp]`,
    `\\centering`,
    `\\caption{Per-table profile of the ANZER test-database snapshot. Populated fraction is the mean over all columns in the table; a column is populated when its value is non-null and, for strings, non-empty after trimming.}`,
    `\\label{tab:anzer-table-profile}`,
    `\\begin{tabular}{lrrr}`,
    `\\hline`,
    `\\textbf{Table} & \\textbf{Rows} & \\textbf{Columns} & \\textbf{Populated} \\\\`,
    `\\hline`,
    ...tableSummary,
    `\\hline`,
    `\\end{tabular}`,
    `\\end{table}`,
    ``,
    `\\noindent Aggregate over all ${totalCols} columns of the snapshot: mean populated fraction ${(populatedMean * 100).toFixed(1)}\\,\\%; ${alwaysPopulated} columns (${(alwaysPopulated / totalCols * 100).toFixed(1)}\\,\\%) are populated in every row, ${neverPopulated} (${(neverPopulated / totalCols * 100).toFixed(1)}\\,\\%) are populated in none. ${binaryOrEnum} columns hold five or fewer distinct values (candidates for an enumeration constraint the schema does not declare). ${numericCols} columns are numeric and admit descriptive statistics.`,
    ``,
  ].join('\n')

  writeFileSync(join(RESULTS_DIR, 'anzer-profile.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    perTable,
    columns: allProfiles,
    overall: { totalCols, populatedMean, alwaysPopulated, neverPopulated, binaryOrEnum, numericCols },
  }, null, 2))
  writeFileSync(join(RESULTS_DIR, 'anzer-profile.tex'), tex)
  console.log(`\nWrote scripts/results/anzer-profile.json and .tex`)
}

function escapeTex(s: string): string {
  return s.replace(/([&%$#_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}')
}

main()
