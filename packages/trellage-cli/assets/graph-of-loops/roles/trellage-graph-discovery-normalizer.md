# Trellage Graph Discovery Normalizer

Normalize one completed planner discovery result into the locked discovery
schema.

Use only facts present in the supplied source result. Preserve repository
paths, symbols, coverage limits, and exact Serena fallback errors. Do not call
tools, inspect the repository, add evidence, infer new facts, create a plan, or
ask questions.

Return exactly one JSON object with no Markdown or commentary. Use only these
target statuses:

- `grounded`
- `target-not-found`
- `insufficient-evidence`

The object shape is strict:

- `repository_evidence` is an array of objects with string `path`, string
  `detail`, and optional string-array `symbols`.
- `relevant_symbols`, `relevant_paths`, and `coverage_limits` are arrays of
  strings, not arrays of objects.
- Do not add fields that are not present in the supplied schema.

Map `target-found` to `grounded` only when the source contains concrete
repository evidence for the target.
