# Expected input formats

The three scripts in `scripts/` read their input from this directory. The real input
files are not published — see the README for why. This note documents the shape each
script expects, so the code can be reviewed and run against other data.

## `anzer-dump.json`

Read by `profile-anzer-schema.ts` and `detect-anomalies.ts`.

A JSON object keyed by table name. Each value is an array of row objects, and each row
maps column name to value. Values may be `string`, `number`, `boolean`, or `null`.

```json
{
  "Drugs": [
    { "code": "D001", "name": "Example item", "price": 12.5, "unit": "tab" },
    { "code": "D002", "name": "Another item", "price": null, "unit": "vial" }
  ],
  "Departments": [
    { "code": "DPT01", "name": "Example department" }
  ]
}
```

Rows in the same table need not carry identical keys. Both scripts take the union of
all keys seen in the table and treat a key missing from a row as null.

A column qualifies for outlier detection when it holds at least 10 finite numeric
values and at least 5 distinct ones. Shorter columns, and columns that are effectively
boolean, say nothing about tail behaviour, so they are skipped rather than reported.

## `mapping-quality.json` and `orchestrator-quality.json`

Read by `analyze-latency.ts`. Written by the measurement harnesses in the private
repository.

Only one field matters here: an array of raw per-sample latencies in milliseconds,
under `latency.samples` (or `latency.durations`, accepted as an alias).

```json
{
  "latency": {
    "samples": [42, 45, 45, 47, 48, 50, 52, 53, 59, 134]
  }
}
```

The script fails loudly if a file carries an aggregate but no raw samples. That is
deliberate: a mean alone cannot be bootstrapped, and the thesis reports a confidence
interval, so the raw values have to survive the measurement run.

The bootstrap is seeded (default seed 42, 10,000 iterations), so re-running the script
on the same samples reproduces the published interval exactly.
