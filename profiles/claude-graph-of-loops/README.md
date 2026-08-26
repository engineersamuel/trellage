# Claude Graph of Loops

This profile applies Granite's Graph of Loops workflow to multi-step software
engineering work. It combines specification-first planning, dependency-aware
task graphs, safe parallel work, validation gates, review loops, and Beads
tracking.

## Beads graph-aware triage

The profile includes the Go `bd` tracker and
[beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`).
Issues are stored in `.beads/`. `bv` reads supported JSONL exports, including
`.beads/issues.jsonl` and `.beads/beads.jsonl`.

Use `bd` to create, claim, update, and close issues. Use `bv` to decide what to
work on by analyzing dependencies and graph metrics.

For agent automation, use only `--robot-*` commands. Bare `bv` opens an
interactive TUI and blocks an agent session.

### Start with triage

```bash
bv --robot-triage
bv --robot-triage --format toon
bv --robot-next
```

`bv --robot-triage` returns:

- `quick_ref`: counts and the top three picks.
- `recommendations`: ranked work with reasons and unblock information.
- `quick_wins`: low-effort, high-impact work.
- `blockers_to_clear`: issues that unblock downstream work.
- `project_health`: status, type, priority, and graph metrics.
- `commands`: commands for the next actions.

Before claiming an issue, verify its current state:

```bash
bd show <id> --json
bd ready --json
bd update <id> --claim --json
```

Only `quick_ref.top_picks` and recommendations with a non-empty
`claim_command` are claimable.

### Planning and analysis commands

| Command | Result |
| --- | --- |
| `bv --robot-plan` | Parallel tracks and their unblock lists |
| `bv --robot-priority` | Priority misalignment with confidence |
| `bv --robot-insights` | PageRank, centrality, HITS, critical paths, cycles, and k-core |
| `bv --robot-alerts` | Stale issues, blocking cascades, and priority mismatches |
| `bv --robot-suggest` | Duplicate, dependency, label, and cycle suggestions |
| `bv --robot-diff --diff-since <ref>` | Issue changes since a Git reference |
| `bv --robot-graph --graph-format=json` | Dependency graph export |

Scope analysis when the full graph is not useful:

```bash
bv --robot-plan --label backend
bv --robot-insights --as-of HEAD~30
bv --recipe actionable --robot-plan
bv --recipe high-impact --robot-triage
```

### Tracker workflow

1. Run `bv --robot-triage`.
2. Verify the selected issue with `bd show` and `bd ready`.
3. Claim it with `bd update <id> --claim --json`.
4. Implement and validate the work.
5. Close it with `bd close <id> --json`.
6. Refresh the export:

   ```bash
   bd export --no-memories -o .beads/beads.jsonl
   ```

`bv` does not grant permission to commit or push code. Follow the repository's
Git rules.

## Reusable prompt

The profile installs
[Graph of Loops](../../.github/prompts/graph-of-loops.prompt.md) as an
explicit-only Codex skill. Invoke it with named arguments:

```text
$graph-of-loops OBJECTIVE="Investigate why the API retries duplicate writes" CONSTRAINTS="Do not change production code; reproduce the fault and report exact evidence"
```

Use `OBJECTIVE` for what to build, fix, or investigate. Use `CONSTRAINTS` for
required behavior, limits, compatibility needs, and completion evidence.
