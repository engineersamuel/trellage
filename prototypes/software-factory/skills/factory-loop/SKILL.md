---
name: factory-loop
description: >-
  Start a software factory goal and see it through: `sf goal run <id>` starts the goal (or attaches to it); the
  factory runs its loops by itself until every acceptance criterion passes and the PR is green. Relay the human-only
  decisions (cost limit, no progress, factory defect) to the user. Use when the user says `/factory-loop <goal-id>`.
---

# Factory goal

A goal is one objective in one target repo (docs/adr/0007-factory-goal-loops.md). The factory works on it in loops:
each loop is a fresh sub-coordinator session in the goal's one conversation (same worktree, branch and PR), started by
the coordinator from the goal state. You do not build the feature and you do not loop yourself.

Argument: a goal id. Run every command from `prototypes/software-factory` of the factory checkout.

## Run

1. `mise run factory:status`. If it is down: `mise run factory:up`.
2. `sf goal run <id>` in the background; wait for it to end. It starts the goal (or attaches to it), answers the
   decisions the spec's `approvals` policy marks `auto`, and returns:
   - 0 DONE: every AC passes (independent evaluator) and the PR is green. Go to Verify.
   - 2 WAITING: a human decision. `sf approvals` shows it. Cost limit (`[budget]`), no progress and factory defect
     (`[goal]`) are the user's only: show them and stop. After the user answers, run `sf goal run <id>` again.
   - 3 STOPPED: the user stopped the goal. Report and stop.
3. Progress: `curl -s 127.0.0.1:7700/api/goals/<id>/state` (AC status, PR, each loop's summary and spend).

## Verify (after DONE)

In the target repo, read `gh pr view <url>` and `gh pr diff <url>` and check that the change does what the goal asks.
If it does not, a criterion is missing: tell the user which one.

## Rules

- Never edit the target repo, the factory's worktrees or the goal state by hand.
- Never merge, close, or delete a PR, branch, or worktree. A human merges.
- Never answer a `budget` or `goal` decision, or any decision the policy leaves to the human.

## Report

End with: goal id, DONE / WAITING / STOPPED, loops used, spend, PR URL, and anything the user must decide.
