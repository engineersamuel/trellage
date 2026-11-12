# ADR 0006: Independent acceptance evaluator for the software factory

## Status

Accepted and built (`src/evaluate.ts`). Decisions 1-4 below were confirmed by the owner; 1 changed to
non-blocking with a fix attempt.

## Context

Anthropic's [harness design for long-running apps](https://www.anthropic.com/research/harness-design-long-running-apps)
finds that agents grade their own work too well. A separate evaluator, tuned to be skeptical, was the part that
still found core gaps after the model got better. Two parts of that design are missing in the factory:

1. **Self-grading.** The verify worker writes `.factory/evidence.md` (`AC-n: PASS`). `shipBlockers` and the grader
   (`grading.ts`, rubric `g1`) both trust that file. The README says it plainly: "a run that writes `PASS`
   dishonestly passes that criterion". Jev picks the verify worker's model; no rule keeps it out of the
   implementer's model family. Code and security reviewers already have that rule (`review.ts`).
2. **No contract.** The sub-coordinator writes the AC-n in `sdlc_plan`, and its own workers later prove them.
   Nobody checks that each AC is testable before the build starts. The article's "sprint contract" is that check:
   the generator and the evaluator agree on what "done" means, and how to test it, before any code is written.

## Decision

Add one **evaluator** role with two jobs: agree the contract at plan time, and grade the result at ship time.

### 1. Contract (at `sdlc_plan`)

- `sdlc_plan` spawns one read-only evaluator worker (step `evaluate`, model from a family other than the
  sub-coordinator's) with the request, the plan and the criteria.
- For each AC it returns `{id, check, expect}` or `{id, problem, rewrite}`:
  - `check`: the command or action that proves it (e.g. `curl -s :18080/v1/models | jq '.data[0].type'`).
  - `expect`: the output that counts as a pass.
  - `problem`: why the AC cannot be tested as written, with a rewrite.
- The factory writes `.factory/contract.md`. Implement and verify tasks get the contract, not only the criteria.
- Goal ACs locked by the goal page (`launch-criteria.md`) are never rewritten; the evaluator can only add a check.
- A `problem` goes back to the sub-coordinator as an `sdlc_plan` error. At most `[evaluate].contract_rounds`
  (default 2) rounds; after that the plan continues and the unresolved ACs are marked in the plan approval.

### 2. Evaluation (at ship time, before the final security review)

- Not a ship blocker (owner decision): the first ship request starts it and waits for it; its verdicts never block.
- The evaluator worker runs in a fresh context, from a family other than the **implementer's**, with:
  - the contract, the diff stat, the repo checks, and nothing from the implement or verify transcripts;
  - the shell, but no commit and no file write in the worktree. This needs a new permission rule: the
    sub-coordinator read-only shell (`readonly.ts`) is too strict (it refuses builds and servers), and review
    workers today have no write limit. It may build, start the deliverable on test ports and call it.
- It runs every `check` itself and writes `verdicts.json` **outside the worktree** (as `security.ts` does with
  `findings.json`): `{id, verdict: pass|fail, command, output, note}` per AC.
- The prompt says: run each check yourself; a check you did not run is `fail`; a stub, a TODO or a partial feature
  is `fail`; do not talk yourself out of a failure you saw. Calibration examples are prompt files under
  `prompts/evaluator/examples/` (start with 3 from real factory runs).
- Any `fail` → a fix worker (implement) with the failed verdicts, then verify, then evaluate again. At most
  `[evaluate].max_rounds` (default 2) evaluations. Still failing → the PR ships with the failed verdicts in its body,
  and the `g2` grade fails.

### 3. Grading

- Rubric `g2`: criteria results come from `verdicts.json`. `evidence.md` stays as the run's self-report.
- Each grade records both results and a **disagreement** count (self PASS, evaluator FAIL). That count is the
  measure of how much the evaluator is worth.
- `g1` and `g2` grades are never compared in one chart (the README rule for grading versions already says this).

### 4. Switch

- `[evaluate] enabled = true` in `config.toml`. Off restores today's flow. This lets a goal run measure the
  evaluator by ablation, as the article advises: remove one part at a time and compare.

## Alternatives considered

| Option | Benefit | Cost |
| --- | --- | --- |
| Keep self-evidence; add the family rule to verify only | Smallest change | Verify still writes its own pass; no contract |
| Evaluator grades only, no contract | One new worker per round | Vague ACs still reach the build; the evaluator then judges them by its own reading |
| **Evaluator does contract and grade (this ADR)** | One role, one prompt, one model rule; closes both gaps | Two to three more workers per run; ship takes longer |
| Make Jev judge the evidence | Cheap, fast | Jev reads text; it cannot run a check |

## Consequences

- Cost per run goes up by one contract worker and one or two evaluator workers. Cost per worker and per run
  exists (#311), and each grade now saves the run's cost per step (`grade.cost.byStep`), so the cost of the
  `evaluate` step is measured, not guessed.
- Runs that pass today on self-evidence may fail `g2`. That is the point, but the first runs will look worse.
- The verify step stays: it runs CI and finds problems fast. The evaluator does not replace it; it checks it.
- UI work: a verdicts card next to `show_sdlc`.

## Owner decisions

1. A failed evaluation does **not** block ship. It starts a fix attempt (at most 2 evaluations); the PR then ships
   with the verdicts, and the grade records the fail.
2. `g2` grades from the evaluator's verdicts; `evidence.md` is kept as `selfCriteria`, with a disagreement list.
3. The evaluator may add a check to a locked goal AC, never change or drop it.
4. Contract rounds 2, evaluation rounds 2.
