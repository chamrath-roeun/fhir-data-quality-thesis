# GOP Thesis Artifacts — Data-Quality and Evaluation Code

Supporting code for the bachelor thesis:

> **From Legacy Records to Structured Interoperability: Design and Evaluation of a
> FHIR-Based Data Pipeline for Automated Guarantee of Payment Processing at a
> Cambodian Private Hospital**
> Roeun Chamrath — BSc Data Science & AI Engineering, Faculty of Engineering,
> Cambodia University of Technology and Science.

This repository exists so that the numbers reported in Chapter 5 of the thesis can be
traced to the code that produced them. Appendix C of the thesis points here.

## What this repository is, and is not

This is **not** the GOP Tracking System. The full system is a Next.js application
holding hospital workflow logic, authentication, and an integration against a live
hospital information system, and it is not published. It stays private because it is
operational software for a working hospital.

What is published here is the part of my own contribution that the thesis makes
quantitative claims about: the statistics module, the two outlier detectors, their
tests, and the three analysis scripts that generate the tables and figures in
Chapter 5. These stand on their own — they take numbers in and produce statistics
out, and they carry no hospital logic, no credentials, and no patient data.

## Layout

Paths here match the paths quoted in the thesis exactly, so a reference like
`scripts/profile-anzer-schema.ts` resolves against this repository root.

```
src/lib/stats/descriptive.ts        mean, SD, type-7 quantiles,
                                    seeded percentile bootstrap, one-sample t-test
src/lib/stats/descriptive.test.ts   tests, including a case checked against R's t.test()

src/lib/fhir/anomaly.ts             the two outlier detectors: Tukey IQR fences
                                    and sample z-score, plus the shared finding shape
src/lib/fhir/anomaly.test.ts        tests, including the SD-masking demonstration

scripts/profile-anzer-schema.ts     exploratory profiling of the source snapshot
scripts/detect-anomalies.ts         batch outlier run over every numeric column
scripts/analyze-latency.ts          latency descriptives, bootstrap CI, t-test
```

## Which thesis section each file backs

| File | Thesis section |
|---|---|
| `scripts/profile-anzer-schema.ts` | §5.5.1 Exploratory Data Analysis of the Test Snapshot |
| `scripts/detect-anomalies.ts` | §5.6 Statistical Outlier Detection |
| `scripts/analyze-latency.ts` | §5.4.3 Statistical Treatment |
| `src/lib/fhir/anomaly.ts` | §3.6.3 Statistical Outlier Detection Layer, Appendix B |
| `src/lib/stats/descriptive.ts` | Appendix B, Statistical Methods |

Each script writes two outputs into `scripts/results/`: a JSON file with the full
machine-readable result, and a `.tex` file containing the LaTeX table that goes into
the thesis. The thesis tables are generated, not typed by hand, which is why a re-run
refreshes them.

## Running it

Requires Node.js 22 LTS.

```bash
npm install
npm test                                  # runs the unit tests for both modules
npx tsx scripts/analyze-latency.ts        # needs measurement output, see below
npx tsx scripts/profile-anzer-schema.ts   # needs a snapshot, see below
npx tsx scripts/detect-anomalies.ts       # needs a snapshot, see below
```

`npm test` works with no extra input, since the tests are self-contained. That is the
part a reader can verify directly.

## About the input data

The three scripts read from `scripts/results/`, which is empty here.

The profiling and anomaly scripts expect `scripts/results/anzer-dump.json`, a snapshot
of the hospital's **test** database taken on 1 August 2026. The latency script expects
`mapping-quality.json` and `orchestrator-quality.json`, written by the measurement
harnesses in the private repository.

None of these files are published. Even though the test database holds deliberately
fabricated values rather than real patient records, it still carries the hospital's
schema and its pricing structure, and that is not mine to release.
`scripts/results/FORMAT.md` documents the shape each script expects, so the code can
be read, reviewed, and run against your own data.

## A note on what the statistics do and do not claim

The outlier detectors flag values that sit far from the central tendency of their own
column. They do not decide whether a value is clinically or commercially plausible —
that needs domain knowledge which is not in the data. The thesis states this limit in
§3.6.3 and §5.6, and I would rather repeat it here than have the code read as a
stronger claim than it is.

The two detectors are deliberately kept side by side. They disagree, and the
disagreement is the point: the sample standard deviation the z-score threshold uses is
inflated by the very outliers it is meant to catch, so it misses them in exactly the
tail-heavy columns where it matters. `anomaly.test.ts` has a test demonstrating this
directly.

## License

MIT. See `LICENSE`.

## Contact

Roeun Chamrath — chamrath.roeun@gmail.com
