---
name: factory-loop
description: >-
  Run the software factory self-improve loop for one goal spec: start the goal's run with `sf goal run`,
  score it, and when it fails fix the factory code (not the target repo), commit, restart, and run again
  until the goal passes or its run limit is reached. Use when the user says `/factory-loop <goal-id>` or
  asks to hill-climb or self-improve the factory against a goal.
---

# Factory loop

You improve the software factory until it delivers one goal. The goal spec says what to build, in which repo, and what
the run must show (steps, skills, PR). You do not build the feature yourself. The factory builds it; you fix the factory
when it fails.

Argument: a goal id. Run every command from `prototypes/software-factory` of the factory checkout.

## Memory

Keep no state of your own. All state is in:

- `sf goal show <id>`: the spec. Never edit it during the loop; a human owns it.
- `sf goal history <id>`: one line per run, with the factory commit it ran on. Read it first.
- `git log --grep "Goal: <id>"`: your earlier fixes and their diagnoses.

## Setup

1. `mise run factory:status`. If it is down: `mise run factory:up`.
2. `sf goal show <id>`. Count runs since the newest PASS in `sf goal history <id>`. At the spec's `limits.runs`, stop
   and report BLOCKED.

## One run

1. `sf goal run <id>` (it can take up to `limits.minutesPerRun`; run it in the background and wait for it to end). It
   starts a new thread, answers the decisions the spec's `approvals` policy marks `auto` (first option), scores the run,
   and appends the result to the run log. Exit codes:
   - 0 PASS: go to Verify.
   - 2 WAITING: a decision the policy leaves to the human. Show it to the user with `sf approvals` and stop. After the
     user answers, continue with `sf goal run <id> --thread <thread>`.
   - 3 BLOCKED or 1 FAIL / TIMEOUT: go to Diagnose.
2. The score card lists each expected step, skill and PR check with ✓ or ✗, and the unmet lines.

## Diagnose

Find the factory defect that made the run fail, not the symptom.

- `sf run <thread>`: workers with step, skills, status; approvals; report; PR.
- `curl -s '127.0.0.1:7700/api/events?workers=<ID,ID>&perWorker=200'`: what each agent did.
- `mise run factory:logs`: coordinator errors.
- Factory code: `coordinator/src` (prompts.ts, steps.ts, tools.ts, security.ts, factory.ts).

Typical defects: a prompt that does not tell the sub-coordinator to run a step; a step without the skill; a tool error;
a gate that blocks a legal action; a worker that timed out.

When the cause is the spec (a wrong expectation, a vague prompt) and not the factory, stop and tell the user; do not
edit the spec.

## Fix

1. Change the factory in this checkout. Add or update a test that fails without the fix.
2. `make factory-test` from the repository root must pass.
3. Commit (use `mise x -- git commit` so the hooks find their tools). End the message with `Goal: <id>` and one line
   `Diagnosis: <cause>`. Do not push.
4. `mise run factory:restart coordinator`. Restart only between runs: a restart stops running workers.
5. Start the next run (One run, step 1). Never continue a failed thread.

## Verify (after PASS)

Do not trust the score alone. In the target repo, read `gh pr view <url>` and `gh pr diff <url>` and check that the
change does what the spec's prompt asks. If it does not, the spec misses an expectation: tell the user which one, and
stop.

## Rules

- Never edit the target repo or the factory's worktrees by hand.
- Never edit `coordinator/src/guard.ts`, `coordinator/src/approvals.ts`, or `shipGrant` in `coordinator/src/tools.ts`.
  If a fix needs them, stop and tell the user.
- Never merge, close, or delete a PR, branch, or worktree. A human merges.
- Answer decisions only through `sf goal run`'s policy. Never answer a `human` decision yourself.
- Improvement proposals ("Improve the Factory after a failed grade …") are human-only. Never answer, approve, or reject
  one, and never launch an improvement run yourself.

## Report

End with: goal id, PASS / BLOCKED / WAITING, runs used, PR URL, each fix commit with its diagnosis, and anything the
user must decide.
