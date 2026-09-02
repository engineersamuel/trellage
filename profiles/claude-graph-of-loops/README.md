# Claude Graph of Loops

This profile applies Granite's Graph of Loops workflow to multi-step software
engineering work through an explicit control plane, not automatic routing.
Graph execution starts only when the user invokes `/graph-of-loops` with an
objective. That invocation calls the `trellage-graph` CLI, which is the only
component that plans, schedules, supervises nodes, and decides completion.
The outer Claude session never simulates graph state, gate results, review
findings, or proof outcomes in prose, and it never edits repository code
directly while in graph mode — every code change happens inside a node's
Bernstein worktree, through that node's authorized, Waku-supervised
specialist.

## Explicit entry point and CLI contract

Invoke the workflow with named arguments:

```text
/graph-of-loops OBJECTIVE="Investigate why the API retries duplicate writes" CONSTRAINTS="Do not change production code; reproduce the fault and report exact evidence"
```

Use `OBJECTIVE` for what to build, fix, or investigate. Use `CONSTRAINTS` for
required behavior, limits, compatibility needs, and completion evidence. The
[Graph of Loops prompt](../../.github/prompts/graph-of-loops.prompt.md)
translates this into `trellage-graph` CLI calls:

| Command | Purpose |
| --- | --- |
| `trellage-graph run --goal "<objective>" [--constraint "<text>"]...` | Print a durable run ID before planning, then plan, validate, accept Beads state, and begin scheduling. |
| `trellage-graph status --run <run-id>` | Report bootstrap phases before acceptance and node, gate, review, and proof state afterward. |
| `trellage-graph resume --run <run-id>` | Continue the same interrupted run, reuse its current reviewed plan, or retry only a failed candidate-plan audit when provenance still matches. |
| `trellage-graph resume --run <run-id> --replan` | Explicitly supersede a blocked or stale generation when no node commit or integration exists and generated worktrees are clean. It can also supersede after every node is closed, integrated, current, reviewed, and proved when graph gates fail before graph review or proof, provided the clean named HEAD is the integrated target or its descendant. |
| `trellage-graph validate-plan --plan <path>` | Validate a graph plan document without starting execution. |
| `trellage-graph finding reject <finding-id> --run <run-id> --evidence <path>` | Record an explicit, evidence-backed rejection of one Codex review finding. |

When `/graph-of-loops` explicitly names an existing 12-character run ID and
asks to inspect or resume it, the entrypoint permits a direct `status` or
`resume` command as the first controller action. It still blocks repository
inspection and wrapped shell commands before that action.

## Control plane

- **The lifecycle journal owns pre-accept bootstrap; Beads owns accepted graph
  state.** The run ID and request are durable before the first planner call.
  Status and resume work during planning, validation, and acceptance. Once a
  plan is accepted, Beads is the only durable graph authority. The controller
  is the only caller that creates, claims, transitions, reopens, or closes
  graph Beads. See
  [ADR 0001](../../docs/adr/0001-graph-of-loops-state-and-control.md).
- **Beads state is explicit and recoverable.** Every `bd` call uses the
  current worktree's `.beads` directory. Partial graph creation is retried by
  namespaced run and node metadata, so resume reuses matching issues and
  fails closed on ambiguous duplicates.
- **Bernstein computes ready waves and creates worktrees.** Nodes with
  overlapping or undeclared write sets run serially instead of in parallel.
  Integration is rebase-first and fast-forward-only; a conflict creates
  repair work instead of a merge commit.
- **Waku is a bounded per-node supervisor**, not the graph scheduler. Its
  tool registry exposes only `run_specialist` (the node's one authorized
  Claude role and phase) and `run_gate` (the node's predeclared commands).
  Model text is never completion authority — the controller verifies the
  required event sequence in the node's evidence ledger. See
  [ADR 0002](../../docs/adr/0002-waku-node-supervision.md).
- **Named specialist roles** resolve exactly once each:
  `trellage-graph-planner` (planning), `insane-research` (research nodes),
  `team-implementer` (implementation), `tdd-workflows-tdd-orchestrator` (red/green
  phases), `team-debugger` (repair), `conductor-validator` (validation).
- **Research nodes use a headless adapter.** The runtime-owned
  `insane-research` role writes the upstream validator's session layout:
  `artifacts/claim_ledger.jsonl`, `sources/sources.jsonl`, validator outputs,
  and `state.json`. The controller runs the locked `validate_ledger.py` with
  `--session` and copies validated evidence into the run journal.
- **Serena discovery is required** for code nodes, started with
  `--project-from-cwd`, and requires at least one successful symbol or
  reference lookup before implementation. If Serena cannot start or does not
  support the repository language, the controller records the exact failure
  and an explicit fallback event before allowing ordinary text search.
- **Planner discovery comes first.** The planner has only read-only Serena
  discovery tools and must return structured discovery before it freezes
  module seams, node dependencies, and exact ownership sets. Symbol/reference
  lookup is preferred; read-only file and pattern tools cover repository
  languages not served by active language servers. Native structured output or
  JSON result text is accepted only after local schema validation. If discovery
  returns evidence-rich prose or schema-invalid structured output, one bounded
  tool-free normalizer may convert only those supplied facts to the locked
  schema; invalid normalized output still fails closed. Generated Graph state,
  agent work, dependencies, and build output are excluded. A later research
  node does not substitute for this discovery. If the model omits a Serena
  fallback field, the controller preserves the exact observed tool failure in
  the schema-validated result.
- **Rust work uses an exact locked toolchain.** The image includes Rust,
  Cargo, rustfmt, and Clippy 1.96.0 plus the AArch64, x86_64, and i686 musl
  standard libraries. Native AArch64 builds and tests use the bundled
  `rust-lld`; x86 targets can be compiled and linked for portability checks.
  The runtime entrypoint restores the locked Cargo target configuration after
  the persistent `/home/agent` volume is mounted.
  AVX2 execution and performance claims still require a native x86_64 runner.
- **Planning is grounded and reviewed before acceptance.** The planner returns
  either a repository-evidenced plan or a durable blocked decision. Candidate
  plans preserve the request exactly, declare repair ownership and validation
  coverage, and pass a read-only Codex plan audit before Beads are created.
- **Plan reuse is provenance-checked.** Resume verifies request, policy,
  runtime, planner contract, discovery, review, base revision, and plan
  digests. If review transport fails before acceptance, resume retries only the
  audit against the unchanged candidate and Git base. Semantic findings still
  require explicit replan, which preserves superseded generations.
- **Gates execute direct commands only.** Inline shell or interpreter source
  through `-c`, `-lc`, `-e`, or equivalent flags is rejected during plan
  validation and again at runtime. Compound checks belong in separate gates
  or checked-in fail-fast scripts.
- **Behavior-changing nodes require red, green, and final-gate evidence**:
  a red phase with a failing predeclared test command, an implementation
  phase, the identical command passing green, and all final node gates
  passing after the last specialist attempt. Missing red evidence, a
  changed green command, or a failing final gate blocks integration.
- **Codex review is Trellage-owned and container-isolated.** It runs
  ephemerally in Codex external-sandbox mode because the Trellage Docker
  container is the security boundary and nested Linux user namespaces are not
  portable. It writes one final JSON response, and Trellage validates that
  response locally against the locked schema after a node's local gates pass
  and again across all nodes at the end of a
  run. The image includes Bubblewrap for the Linux sandbox, and a response
  that says inspection was unavailable fails closed. Every returned finding blocks
  completion and creates a Beads repair node unless explicitly rejected with
  `trellage-graph finding reject` and recorded evidence. See
  [ADR 0003](../../docs/adr/0003-graph-review-and-proof.md).
- **Raindrop proof is repository-opt-in.** It is applicable only when the
  repository declares both `.raindrop/agents.yaml` and a Trellage proof
  policy. Without both, proof status is `not-applicable` — the controller
  never reports that replay occurred when it did not.
- **Push, pull request, and deployment are unsupported and blocked.** The
  typed schema fixes `[orchestration.authorization]`'s `allow_push`,
  `allow_pull_request`, and `allow_deploy` to `false`, with no per-invocation
  override. A graph plan cannot raise these limits.
- **A late failure reopens work.** If a gate, review, proof check, or
  integration step fails after passing earlier, the controller reopens the
  affected node Bead and the root Bead and blocks completion until it is
  resolved again.

## Beads graph-aware triage (manual inspection)

The profile includes the Go `bd` tracker and
[beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for a
human or agent operator to inspect graph state between runs. These commands
are read-oriented triage tools; they do not run or mutate a `/graph-of-loops`
run. Only the `trellage-graph` controller creates, claims, transitions, or
closes graph Beads while a run is active. Issues are stored in `.beads/`. `bv`
reads supported JSONL exports, including `.beads/issues.jsonl` and
`.beads/beads.jsonl`.

Use `bd` and `bv` for triage of Beads issues outside an active graph run
(for example, general project backlog). Do not use them to advance or repair
a `/graph-of-loops` run in progress — use `trellage-graph status` and
`trellage-graph resume` instead.

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
