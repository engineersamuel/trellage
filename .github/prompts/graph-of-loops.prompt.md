---
name: graph-of-loops
description: 'Run an objective through the trellage-graph controller: Beads state, Bernstein worktrees, bounded Waku node supervision, TDD gates, Codex review, and repository-opt-in Raindrop proof.'
---

# Execute a Graph of Loops

## Mission

Use this workflow only when explicitly invoked as `/graph-of-loops`. Parse the
invocation arguments as named `OBJECTIVE` and `CONSTRAINTS` inputs.

`OBJECTIVE="<what to build, fix, or investigate>"`
`CONSTRAINTS="<limits, requirements, compatibility needs, and evidence>"`

This workflow is a thin controller front end. It does not plan, schedule, or
execute the graph itself. All graph state, scheduling, node supervision,
gates, review, and proof live in the `trellage-graph` CLI and its Beads,
Bernstein, Waku, Codex, and Raindrop integrations. This prompt's job is to
invoke the CLI correctly, read back its status, and report it accurately.

## Operating boundaries

- **Never simulate graph state.** Do not narrate fake nodes, dependencies,
  gate results, review findings, or proof outcomes in prose. If the CLI has
  not reported an event, it did not happen.
- **Never edit code directly in graph mode.** All reads and writes to
  repository files happen inside a node's Bernstein worktree, driven by the
  node's authorized Waku-supervised specialist. This prompt does not open an
  editor on the target repository itself.
- **Always start with a direct `trellage-graph run`.** Do not wrap it in a
  pipeline, redirection, command list, evaluator, or environment wrapper. Do
  not hand-decompose the
  objective into ad hoc tasks before invoking the CLI; the planner role
  (`trellage-graph-planner`) produces the schema-valid graph plan.
- Merging, pushing, opening a pull request, and deploying are unsupported
  and blocked. The typed schema fixes `[orchestration.authorization]`'s
  `allow_push`, `allow_pull_request`, and `allow_deploy` to `false`, with no
  per-invocation override.
- Do not weaken tests, security, type safety, validation, or product behavior
  to make a gate, review, or proof step pass.
- Preserve unrelated worktree changes and existing user state.

## CLI contract

Use only these `trellage-graph` commands. Do not invent additional
subcommands.

| Command | Purpose |
| --- | --- |
| `trellage-graph run --goal "<objective>" [--constraint "<text>"]...` | Start a new graph run. Prints and flushes a `run-id` before planning, then plans, validates, accepts Beads state, and schedules ready nodes. |
| `trellage-graph status --run <run-id>` | Report planning, acceptance, node, gate, review, and proof state. Use this to observe progress; never substitute for it. |
| `trellage-graph resume --run <run-id>` | Continue the same run after an interruption. A current, reviewed plan is reused instead of regenerated. |
| `trellage-graph resume --run <run-id> --replan` | Explicitly supersede a blocked or stale plan generation when the controller proves it is safe. |
| `trellage-graph validate-plan --plan <path>` | Validate a graph plan document against the locked schema and structural rules without starting execution. Use only to check a plan produced for inspection. |
| `trellage-graph finding reject <finding-id> --run <run-id> --evidence <path>` | Record an explicit, evidence-backed rejection of one Codex review finding. Use only when a finding is confirmed incorrect, never to silently dismiss it. |

If a required command, flag, or contract in this table does not yet exist in
the installed CLI, report that gap; do not paper over it with a manual
substitute.

## Workflow

1. **Invoke**
   - Confirm `OBJECTIVE` is present. Pass `CONSTRAINTS` as one or more
     `--constraint` values.
   - Run `trellage-graph run --goal "<OBJECTIVE>" --constraint "<CONSTRAINTS>"`
     from the current worktree.
   - Record the `run-id` as soon as it is printed, before planning finishes.

2. **Observe**
   - Poll `trellage-graph status --run <run-id>` at reasonable intervals.
   - During bootstrap, read the reported planning, planned, accepting, or
     blocked phase. After acceptance, read node states, gate results, Codex
     review findings, and Raindrop proof status (`passed`, `not-applicable`,
     or `blocked`) directly from the command output.
   - Do not infer a node's state from elapsed time or from what the
     objective implies should be happening.

3. **Resume on interruption**
   - If planning infrastructure, validation, Beads acceptance, the session, or the container
     fails mid-run, call
     `trellage-graph resume --run <run-id>` before doing anything else with
     that run. Do not start a second run for the same objective or ask the
     planner to regenerate a current persisted plan.
   - If planning returns a durable target mismatch or plan-review blocker,
     report it. Do not retry it with ordinary `resume`. Use `--replan` only
     when the user explicitly requests a new plan generation.

4. **Handle blocked findings**
   - If status reports a blocked Codex finding that is a confirmed
     false positive, use `trellage-graph finding reject <finding-id>
     --run <run-id> --evidence <path>` with a real evidence file. Otherwise, wait for the
     controller to route the finding to repair work and reflect it in a
     later `status` call.

5. **Report**
   - Once `status` reports the root Bead closed, or reports a concrete
     blocker the controller cannot resolve on its own, stop polling and
     report the outcome below.

## Completion rule

Report completion only when `trellage-graph status --run <run-id>` shows all
of the following, not when the objective merely seems finished:

- Every node Bead is closed.
- No Codex review finding is unresolved (fixed or explicitly rejected with
  evidence).
- Raindrop proof is either `passed` or `not-applicable`; never report
  `passed` when the CLI reported `not-applicable`.
- No node worktree remains pending integration.
- The root Bead itself is closed.

If any late gate, review, proof check, or integration step fails after an
earlier pass, the controller reopens the affected node Bead and the root
Bead. Treat that run as still open and continue observing or resuming it; do
not report completion until the root closes again.

## Output format

Report concise execution state from the CLI's own output:

```markdown
**Outcome:** <complete, blocked, or in progress>

- **Run:** <run-id>
- **Graph:** <node states from `status`, e.g. closed/running/blocked counts>
- **Review:** <resolved and rejected Codex findings, with evidence for
  rejections>
- **Proof:** <passed, not-applicable, or blocked, exactly as reported>
- **Remaining:** <none, or the exact blocked node/finding from `status`>
```
