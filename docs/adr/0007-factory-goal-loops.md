# ADR 0007: A goal is an objective, finished by loops that share one goal state

## Status

Accepted (owner, 2026-11-12). Replaces the "repeatable factory test" goal model of the self-improve loop.

## Context

Until now a factory goal was a **benchmark of the factory**: `sf goal run` started a fresh conversation (new
worktree, branch and PR) from the spec each time, and `/factory-loop` fixed the factory code between runs. Spec
prompts said "other open PRs are earlier runs; ignore them". A pass proved the factory could deliver the goal in
one go; it did not move the work forward.

The owner wants the opposite: a goal is **work to finish in one target repo** (which may be the factory itself).
Anthropic's long-running harness work (ADR 0006 context) points the same way: each session starts with a fresh
context, and a shared progress record carries the work from one session to the next.

## Decision

### Terms

- **Goal**: one objective in one target repo: a spec (`docs/goals/factory/<id>.json`) with a prompt, acceptance
  criteria and a cost limit.
- **Loop**: one fresh sub-coordinator session working on the goal. Every loop of a goal works in the **same
  conversation, worktree, branch and PR**. A loop ends with `report_up`.
- **Goal state**: one record per goal (`$SF_STATE_DIR/goal-state/<id>.json`) that every loop reads (in its handoff
  turn) and the factory updates after every loop: AC status, branch, PR and checks, what each loop did, spend.

### Who runs the loop

Plain code in the coordinator service (`src/goalLoop.ts`), not an agent. Agents' chats grow and get compacted;
code is deterministic, costs no tokens and survives a restart. The global coordinator receives every loop's report
(as before) and is where the human steers.

After each `report_up` of a goal's conversation:

1. Update the goal state: AC status from the independent evaluator's verdicts (ADR 0006), else from the run's
   `evidence.md`; the PR and its checks; the loop's report, commit and spend.
2. **Done** when every AC passes and the PR's checks are `SUCCESS` (or the repo has no checks). Checks still
   `PENDING`: the state waits (`checking`) and is checked again. Done is reported to the global coordinator; the
   human merges.
3. `needs-decision`: wait for the human (the decision is already with the global coordinator).
4. **Factory defect** (`report_up` with `factoryDefect`): ask the human to open a **child goal** on the factory repo.
   The parent goal waits; when the child goal is done, the human merges its PR, restarts the factory, and resumes
   the parent.
5. **No progress** for 2 loops in a row (no AC newly passing and no new commit): pause and ask the human ("Run
   another loop" with optional direction, or "Stop the goal").
6. Otherwise start the **next loop**: once the conversation is idle, a new sub-coordinator session (same worker id,
   so SDLC state and cost stay with the goal; new session id, so the chat is fresh) gets a handoff turn built from
   the goal state.

The cost limit (per goal, all loops together, default $250) pauses the goal as before. There is no loop count and no
time limit.

### What changes

- `limits.runs` is removed. `sf goal run <id>` starts the goal (or attaches to it), answers the decisions its policy
  allows, and returns when the goal is done (exit 0), waits for the human (2) or was stopped (3).
- Failed grades of goal loops open no "improvement" proposal; child goals replace it.
- The finish worker updates the goal's one PR in every loop.
- The 8 benchmark-style specs and their run logs are deleted (git history keeps them).

## Alternatives considered

| Option | Why not |
| --- | --- |
| The sub-coordinator agent loops itself | Its context grows over every loop and is compacted: the long-run failure the fresh-session pattern avoids. |
| The global coordinator agent loops | One shared chat for all work; every step costs tokens; it can forget to start a loop. |
| Fresh branch per loop | Throws away the work; contradicts "finish the objective". |
| Keep benchmark goals as a second kind | The owner chose one kind; benchmarking is out of scope for now. |

## Consequences

- A goal's PR can collect commits from several loops; reviews and the evaluator see the whole diff each time.
- A loop that ends `blocked` is no longer the end: the next loop gets the block in its handoff.
- A child goal's fix reaches the running factory only after the human merges and restarts it.
- Grades stay per loop (history); the goal state is the source of truth for "done".
