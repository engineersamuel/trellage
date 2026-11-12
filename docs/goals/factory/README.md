# Factory goals

One file per goal: `<id>.json`. A goal is one objective in one target repo (ADR 0007). Start it with
`sf goal run <id>` or the guided goal page; the factory runs its loops until every acceptance criterion passes and the
PR is green, or its cost limit (`limits.usd`, all loops together) asks you. Its live state is
`$SF_STATE_DIR/goal-state/<id>.json` (`GET /api/goals/<id>/state`). `<id>.runs.jsonl` keeps one grade per loop.

The earlier benchmark-style specs (cpr-*, trellage-factory-run-grading) were removed on 2026-11-12; see git history.
