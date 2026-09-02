---
name: graph-of-loops
description: 'Run the governed Trellage Graph of Loops workflow for multi-node development, status, resume, plan validation, and evidence-backed finding rejection.'
---

# /graph-of-loops

Plan, schedule, supervise, verify, and integrate a multi-node development
graph using the Trellage Graph of Loops runtime.

## Usage

```
/graph-of-loops OBJECTIVE="<objective>" CONSTRAINTS="<constraints and evidence>"
```

Parse the invocation as named `OBJECTIVE` and `CONSTRAINTS` inputs. `OBJECTIVE`
is required. Pass `CONSTRAINTS` unchanged as one or more `--constraint`
values.

## Mandatory entry point

**Always start with a direct `trellage-graph` controller command.** Do not wrap
it in a pipeline, redirection, command list, evaluator, or environment wrapper.
When `OBJECTIVE` is present, the first workflow action is:

```bash
trellage-graph run --goal "<OBJECTIVE>" --constraint "<CONSTRAINTS>"
```

When the user explicitly supplies an existing 12-character run ID and asks to
resume or inspect it, start with:

```bash
trellage-graph status --run <run-id>
```

Then use `trellage-graph resume --run <run-id>` if the run is incomplete. Do
not start a replacement run.

Before that command, do not search or inspect the repository, probe companion
tools, hand-decompose the work, reinterpret the objective, propose a substitute
target, or ask for clarification. The planner and controller own repository
discovery and semantic validation. Pass the user's objective and constraints
unchanged. If the target subsystem is absent or a dependency is unavailable,
report the concrete planner or controller error instead of replacing the graph
with an outer-session preflight.

Record the returned run ID. Observe the run only with:

```bash
trellage-graph status --run <run-id>
```

The CLI prints and flushes the run ID before its first planner model call.
`status` is valid during planning, validation, and Beads acceptance as well
as node execution. Poll it at reasonable intervals until the root Bead closes
or the controller reports a blocker it cannot resolve. After any interruption
or bootstrap failure, use `trellage-graph resume --run <run-id>`; never start a
second run for the same objective. Resume reuses an existing current, reviewed plan rather than paying to plan the
same run again. If candidate-plan review transport fails, resume retries only
that review when candidate provenance and the Git base still match. A durable
target mismatch or semantic plan-review blocker requires an explicit
`trellage-graph resume --run <run-id> --replan`; use it only when the user
requests a new plan generation.

## What the controller does

1. The Trellage graph CLI validates your objective against the locked
   orchestration policy, then asks a headless Claude planner to produce a
   grounded planned-or-blocked decision.
2. The planner performs bounded, read-only Serena discovery before fixing node
   ownership. Symbol/reference tools are preferred; read-only file and pattern
   tools provide fallback coverage when active language servers do not support
   a relevant repository language. Generated Graph state and build output are
   excluded. Evidence-rich prose or schema-invalid structured discovery
   receives one bounded, tool-free normalization attempt that can only
   restructure supplied facts. Missing or schema-invalid normalized discovery
   fails closed. When Serena reports a tool failure, the controller preserves
   the exact observed failure if the model omits it from structured output.
3. Candidate plans receive static validation and a read-only Codex plan audit
   before Beads acceptance.
4. The plan is validated for cycles, duplicate IDs, unknown roles,
   overlapping write sets, TDD gate requirements, research write rules,
   direct gate commands, and authorization bounds.
5. Beads uses the worktree's explicit `.beads` directory and idempotently
   creates or reuses the canonical graph root and one child per node.
6. Bernstein computes deterministic ready waves and creates isolated
   worktrees.
7. Each executable node runs through a bounded Waku loop that can invoke
   only the node's authorized specialist and its declared gates.
8. Behavior-changing nodes must show red → green → final gate evidence.
9. A Codex review gate blocks unresolved findings; findings become repair
   Beads.
10. Raindrop proof replay runs only when the repository declares a safe
   replay policy.
11. Accepted nodes rebase onto the target, rerun gates, and fast-forward
   only.  Merge fallback is not allowed.
12. Any late failure reopens the affected Bead and prevents graph
    completion.

## Commands

| Command | Purpose |
| --- | --- |
| `trellage-graph run --goal "<objective>" [--constraint "<text>"]...` | Plan and execute a new graph run |
| `trellage-graph validate-plan --plan <file>` | Validate without executing |
| `trellage-graph status --run <id>` | Show run status |
| `trellage-graph resume --run <id>` | Continue an interrupted or repaired run |
| `trellage-graph resume --run <id> --replan` | Explicitly create a new safe plan generation |
| `trellage-graph finding reject <finding-id> --run <id> --evidence <path>` | Reject a review finding with evidence |

## Boundaries

- The outer Claude session does not read or edit repository code in graph
  mode. Repository discovery and changes occur through authorized specialists
  in Bernstein worktrees.
- When a direct controller command runs in background, the outer session may
  use only that captured controller task's output and stop controls in addition
  to direct controller commands. A later background controller command replaces
  the completed controller task ID.
- Never simulate nodes, dependency state, gates, review findings, proof,
  integration, or completion in prose. If `trellage-graph status` did not
  report an event, it did not happen.
- Delivery actions (push, PR, deploy) are **fixed false** and cannot be
  raised by a node plan.
- All model traffic routes through `copilot-proxy-rs`.
- The outer Trellage container is the security boundary; Waku and
  Bernstein are orchestration controls, not security controls.
- Research nodes are read-only except for declared evidence output.

## Do not

- Do not simulate the workflow in prose.  Invoke the CLI.
- Do not override gate results or claim success without evidence.
- Do not merge; only rebase and fast-forward.

## Completion

Report completion only when `trellage-graph status --run <run-id>` shows:

- Every node Bead is closed.
- No Codex review finding remains unresolved.
- Raindrop proof is `passed` or `not-applicable`, exactly as reported.
- No node worktree remains pending integration.
- The root Bead is closed.

Any late gate, review, proof, or integration failure reopens the affected node
and root Beads. Continue observing or resume the run until the root closes
again.
