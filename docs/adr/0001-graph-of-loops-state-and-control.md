# ADR 0001: Beads owns durable Graph of Loops state; Bernstein owns DAG scheduling and worktrees

## Status

Accepted. This is the implementation contract for Beads and Bernstein
ownership boundaries in the `claude-graph-of-loops` profile's Graph of Loops
control plane (`trellage_graph`, under
`packages/trellage-cli/assets/graph-of-loops/`).

## Context

The `claude-graph-of-loops` profile installs Beads, Bernstein, Waku, Serena,
curated Claude specialist roles, Codex, and Raindrop. Without one control
plane, these tools have no shared task contract:

- Beads and Bernstein can each believe they own task state, with no rule for
  which one wins after a crash or a partial run.
- A prior custom `wt` worktree wrapper duplicated part of Bernstein's job and
  defaulted to merge-first integration.
- Nothing prevented a specialist agent, rather than the controller, from
  mutating tracker state directly.

The profile needs exactly one durable authority for graph and repair state,
and exactly one component responsible for computing execution order and
creating isolated worktrees. It also needs durable bootstrap state before an
accepted Beads graph exists, because planning or partial Beads creation can
fail after the user has already started a run.

## Decision

- **A lifecycle journal owns pre-accept bootstrap state.** The controller
  persists the run request, lifecycle phase, grounded planning decision,
  review result, provenance record, and a schema-valid canonical plan under
  the run ID before graph acceptance.
  `status` can report planning, planned, accepting, or blocked state without
  querying Beads. `resume` reuses a provenance-current reviewed plan and does
  not call the planner again. Explicit `resume --replan` archives and
  supersedes a generation.
- **Beads is the only durable accepted-graph authority.** The Trellage graph
  controller (`trellage-graph` CLI) is the only component that creates,
  claims, transitions, reopens, or closes Beads issues for a graph run. Every
  scheduler, worktree, evidence, review, and proof reference is stored as
  metadata on the applicable Bead. Specialist agents and Waku never call
  mutating `bd` commands.
- **Beads location and bootstrap identity are explicit.** Every `bd` call
  receives `<worktree>/.beads` through `BEADS_DIR`; it does not derive state
  from a linked worktree's Git common directory. Root and node issues are
  recovered by namespaced run, plan-generation, and node metadata. Zero matches creates an
  issue, one exact match is reused, and duplicate or conflicting matches
  fail closed.
- **Bernstein computes ready waves and creates worktrees.** The controller
  submits a validated graph snapshot, keyed by Bead IDs, to Bernstein's
  pinned `TaskDag`. Bernstein determines which nodes are ready given
  satisfied dependencies, and its `WorktreeManager` creates the isolated
  worktree for each node. Nodes with overlapping, missing, or
  not-declared-parallel-safe write sets are scheduled serially instead of in
  parallel.
- **Integration is rebase-first and fast-forward-only.** When a node is
  ready to integrate, the controller rebases its branch onto the current
  target, reruns the node's required gates, and fast-forwards the target. It
  never falls back to a merge commit. A rebase conflict creates repair work
  instead of forcing an integration.
- **The user entry point is `/graph-of-loops`, which invokes the CLI.** The
  Claude workflow prompt (`.github/prompts/graph-of-loops.prompt.md`) does
  not simulate graph state, scheduling, or worktree creation in prose. It
  calls `trellage-graph run --goal "<objective>" [--constraint "<text>"]...`,
  then uses `trellage-graph status --run <run-id>` to observe progress, and
  `trellage-graph resume --run <run-id>` to continue an interrupted run.

## Consequences

- Bernstein's in-memory DAG state is always a derived, disposable snapshot.
  Losing it does not lose graph history; the controller rebuilds it from
  Beads and resumes.
- Recovery, resume, and audit questions have one answer: query Beads through
  the controller after graph acceptance. Before acceptance, query the
  lifecycle journal through the same controller interface. The journal does
  not duplicate accepted node state and is not a second graph authority.
- A failure after planning or during partial Beads creation keeps the same
  run ID. Resume can finish bootstrap without a second planner call or
  duplicate Beads.
- Superseded generations preserve their plans, state, diagnostics, evidence,
  and Beads history instead of rewriting audit records.
- The controller is a synchronization point. Every node worktree, gate
  result, and review outcome must round-trip through it before Beads
  reflects the change, which adds one hop compared with letting Bernstein
  report status directly.
- Removing the old `wt` wrapper means any workflow that depended on its
  merge-first behavior must move to the controller's rebase-and-fast-forward
  integration gate.

## Alternatives considered

- **Let Bernstein own the graph and mirror status into Beads.** Rejected:
  mirrored state is lossy after a crash mid-run, and resume/repair logic
  would need to reconcile two sources of truth with no defined precedence.
- **Let each specialist agent update Beads directly.** Rejected: this
  removes the single validation point for state transitions and makes it
  possible for a specialist to mark work done without the required gate,
  review, or proof evidence.
- **Keep the custom `wt` wrapper and merge-first integration.** Rejected:
  duplicates Bernstein's isolation logic, is not connected to graph state,
  and conflicts with this repository's rebase-first policy.

## Rollback and review triggers

- **Rollback:** Remove the `[orchestration]` block from
  `profiles/claude-graph-of-loops/profile.toml`. This is the sole activation
  boundary; profiles without the block are unaffected, and no Beads schema
  migration is required because graph-specific state uses namespaced
  metadata and comments.
- **Review this decision if:** Bernstein's pinned API changes in a way that
  breaks ready-wave determinism or `WorktreeManager` isolation; if resume
  behavior is found to lose evidence after a controller crash; or if a
  repository needs a second durable tracker that Beads cannot represent.
