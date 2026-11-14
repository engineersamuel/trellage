# Software Factory prototypes

One TypeScript coordinator (Bun). One frontend (Foldkit + agent-interface, no React) on the backend stream.

```text
browser ──AG-UI SSE──► coordinator (TypeScript, Bun, @github/copilot-sdk 1.0.29-preview.5)
        ◄─raw feed SSE─┤
                       ├─ Transport::External ─► copilot-runtime --server  (coordinator, own COPILOT_HOME)
                       ├─ Transport::External ─► copilot-runtime --server  (worker 1, own COPILOT_HOME)
                       └─ …                                                 (worker n)
```

## Run

```sh
mise run factory:up                    # native Copilot subscription (token from gh auth token)
mise run factory:up proxy              # BYOK through copilot-proxy-rs at localhost:8080/v1
SF_MODEL=claude-haiku-5.5 mise run factory:up   # cheaper model
mise run factory:restart coordinator   # one service (coordinator | foldkit); no name restarts all
SF_WATCH=1 mise run factory:up          # reload the coordinator on every save (stops running workers)
mise run factory:status | factory:logs | factory:tui | factory:down
```

The tasks are in the repository `mise.toml`. The services run detached under
[process-compose](https://f1bonacc1.github.io/process-compose/) (`process-compose.yaml`; mise installs the pinned
version). Each service restarts when it exits. The coordinator does not reload on save unless `SF_WATCH=1`, because a
reload stops running workers. Only one coordinator may use a state folder: it writes `coordinator.lock` and a second one
exits. `factory:tui` attaches the process-compose TUI (status and live logs; `q` leaves it, the services keep running).
The API is the unix socket `$SF_STATE_DIR/pc.sock`, not TCP, because copilot-proxy-rs uses port 8080. Logs are in
`$SF_STATE_DIR/logs` (default state dir: `~/.local/state/trellage/factory`, or `$XDG_STATE_HOME/trellage/factory`; every
git worktree shares it). The first start moves an old `$TMPDIR/software-factory` there, repairs its git worktrees, and
leaves a link at the old path (`coordinator/src/statedir.ts`).

| Service | URL |
|---|---|
| Factory UI (Foldkit + agent-interface) | <http://localhost:5174/> |
| Coordinator API | <http://127.0.0.1:7700/> |

## SDLC gates

Each change gets the smallest correct process. Code holds the floors; Jev decides the optional gates (one probability
per gate against its threshold, `GATES` in `coordinator/src/sdlc.ts`); a risk tier can force a gate on.
`request_approval ship=true` is refused while `sdlc_status` lists blockers.

| Gate | When | What it checks |
|---|---|---|
| Criteria + evidence | always (floor) | `sdlc_plan` writes `.factory/acceptance.md`; verify writes `AC-n: PASS` lines to `.factory/evidence.md` |
| Verify after implement | always (floor) | runs the repo's CI commands (`.github/workflows`, `AGENTS.md`) |
| Security review | always (floor) | `security.ts` |
| Independent evaluation | `[evaluate] enabled` (default on); never blocks | `evaluate.ts`: contract at `sdlc_plan`, verdicts at the first ship request (below) |
| Design note | Jev ≥ 0.6 | `.factory/design.md` (decision, alternatives, rollback) |
| Tests first | Jev ≥ 0.5 | a tests-only commit before the first code commit |
| Code review | Jev ≥ 0.6, or tier T2 | `review.ts`: Jev picks ≤3 lenses, parallel reviewers, synthesis, Jev scores each finding (real ≥ 0.7 and worth ≥ 0.6), fix + verify |
| Supply chain | Jev ≥ 0.5, or a dependency change | betterleaks on the new commits, osv-scanner (vulnerabilities, license allowlist) on changed lockfiles |
| Docs | Jev ≥ 0.5 | the diff changes README, docs or CHANGELOG |
| Post-merge | Jev ≥ 0.5 | after the human merges, the merge commit's checks on the default branch |

The tests-first gate inspects commits oldest first, keeping the existing test/documentation path rules.
For other Rust files, non-blank added and removed lines are checked against the commit and parent respectively.
It recognizes column-0 `#[cfg(test)]` followed immediately by `mod name {`, indented non-blank interior lines,
and a column-0 `}`. A plain `mod name;` addition also qualifies when the same commit adds the corresponding
`name.rs` containing only such test modules, blank lines, and line comments. Existing modules, production stubs,
and mixed production/test commits do not qualify. Unsupported layouts, unterminated strings/comments, or module
markers or changed lines inside multiline comments/strings fail closed. Blockers identify the commit and production
location or explain the classification failure.

Risk tier (`classify`): T0 small docs-only, T2 > 400 lines, dependency manifests or sensitive paths (auth, secrets,
bind, CI, scripts, Docker, mise), else T1. `.factory/` is git-excluded; `.factory/pr.md` (criteria ✓, tier, gates,
evidence, rollback) is the PR body. `report_up` saves up to 3 lessons per repo (`$SF_STATE_DIR/lessons/<folder>.md`),
shown to the next sub-coordinator. The `show_sdlc` card shows it all live; `/api/runs/<thread>` has it under `sdlc` with
metrics (minutes, workers, findings kept and dropped), and goal specs can require it (`expect.sdlc`: `criteriaProven`,
`gatesRun`, `gatesSkipped`, `maxTier`).

## Goals: loops until the objective is met

A goal is one objective in one target repo (which may be the factory itself), [ADR 0007](../../docs/adr/0007-factory-goal-loops.md).
The coordinator works on it in **loops**: each loop is a fresh sub-coordinator session (a fresh context) in the goal's
one conversation, so every loop shares one worktree, branch and PR. Code in the coordinator (`src/goalLoop.ts`), not an
agent, runs the loops. Agents open the PR; a human merges.

After every `report_up` of a loop, the coordinator updates the **goal state** (`$SF_STATE_DIR/goal-state/<id>.json`,
`GET /api/goals/<id>/state`): AC status (the independent evaluator's verdicts, else the run's evidence), the PR and
its checks, each loop's summary, gaps, commit and spend. Then, in order:

1. Every AC passes and the PR checks are `SUCCESS` (or the repo has none): **done**. A report goes to the global
   coordinator; the human merges. Checks still `PENDING`: it checks again every 30 s.
2. `needs-decision`: wait for the human.
3. `report_up` names a `factoryDefect`: a `goal` decision for the human: open a **child goal** on the factory repo
   (this goal waits; when the child is done the human merges it, restarts the factory, and resumes), loop again, or stop.
4. **No progress** in 2 loops in a row (no AC newly passing, no new commit): a `goal` decision: run another loop (typed
   text goes into its handoff as direction) or stop.
5. Otherwise the **next loop** starts once the conversation is idle: the sub-coordinator's session is replaced by a
   new one (same agent id, new session id `sf-sub-<id>-l<n>`), whose first turn (`prompts/goal-loop.md`) carries the goal
   and its state.

`budget` and `goal` decisions are never auto-answered. Failed grades of goal loops open no improvement proposal.

| Part | Where |
|---|---|
| Spec Schema, scoring, form draft | `shared/goal.ts` (one Schema for the UI, the API and `sf`) |
| Specs and run logs | `docs/goals/factory/<id>.json`, `<id>.runs.jsonl` (append only except unknown-grade regrading; each line has the factory commit) |
| API | `GET/POST /api/goals`, `GET /api/goals/<id>`, `POST /api/goals/<id>/start`, `GET /api/goals/<id>/state`, `GET /api/goals/<id>/runs`, `GET /api/runs/<thread>` |
| Form | Foldkit navbar **◎ Goals**: steps and skills come from `/api/steps`, repos from `/api/folders` |
| CLI | `sf goal list | show ID | new | save FILE | run ID [--thread T] | check ID THREAD | history ID` |
| Agent protocol | `skills/factory-loop/SKILL.md` (`/factory-loop <id>`): start the goal with `sf goal run`, relay human decisions |

A spec says:

- `expect.steps`: step id → `{min, max}` workers on that step (e.g. `review: {min: 1}`, `finish: {min: 1, max: 1}`).
- `expect.skills`: skills some worker must have invoked (`skill.invoked` events).
- `expect.pr`: `state`, `checks`, `base` (defaults to the goal's base), `bodyIncludes`, `untouched` files.
- `approvals`: per topic (`plan`, `findings`, `ship`, `other`) who answers: `auto` (the runner picks the first option)
  or `human` (`sf goal run` stops with exit 2). Approvals carry a `topic`; a ship request is always `ship`.
- `limits`: `usd`, the cost limit of the **goal**: all its loops together (default $250). There
  is **no time limit**: a goal may run for days. Every 30 s the coordinator sums the spend of every run of the goal
  (`sf cost` per run) and compares it with the limit. At the limit it stops the goal's running agents and opens a
  `budget` decision for the human (never auto-answered): "Continue to $X" (2-3 higher limits), any typed dollar amount
  above the spend, or "Stop the goal". Going on resumes each paused run with a handoff turn, like a restart resume. A
  stopped goal starts no new run (`sf goal run` is refused and the card opens again) until the human raises the limit.
  The human's raised limit and the pause are kept in `$SF_STATE_DIR/goal-budgets.json` and survive a restart; a
  higher `usd` in the spec wins over it. Plain prompts (no goal) have no cost limit. Old specs with `minutesPerRun`
  load; the key is ignored.

Flow: fill the form (or `sf goal new`, or the guided goal page) → `sf goal run <id>` (the goal page's Launch does it).
`sf goal run` starts the goal or attaches to its conversation, answers the decisions its policy allows, and exits 0 when
the goal is done, 2 when a decision waits for the human (cost limit, no progress, factory defect, or policy), 3 when the
goal was stopped. `sf -f FOLDER -b BRANCH` branches the worktree from BRANCH and the
finish worker opens the PR against it. `make factory-test` (also in CI) runs the coordinator type check and tests.

### Grading

When a sub-coordinator's `report_up` ends with `done` or `blocked`, the coordinator grades the conversation in the
background from objective evidence. A grader failure never fails `report_up`. Prompted runs and saved-goal runs are both
graded. `SF_GRADING=off` turns off grading and improvement retries.

How others grade agents, and what we take from each:

| Project | Metric | Limitation | Taken here |
|---|---|---|---|
| [SWE-bench](https://www.swebench.com/SWE-bench/guides/evaluation/) / [Verified](https://openai.com/index/introducing-swe-bench-verified/) | % resolved: all `FAIL_TO_PASS` and `PASS_TO_PASS` tests pass | Tests can be too narrow or underspecified; public issues may leak into training data | "Instances with errors" are counted apart from "unresolved"; every required check must pass |
| [Inspect AI](https://inspect.aisi.org.uk/scorers.html) ([errors](https://inspect.aisi.org.uk/handling-errors.html)) | Per-sample scorer values aggregated by `accuracy()`/`mean()` | Model-graded scorers inherit the judge's bias | Errored samples are not scored; the judge model is recorded |
| [Terminal-Bench](https://www.tbench.ai/) | Resolution rate of sandboxed test scripts, with a 95% CI | Flaky test scripts; contamination (canary GUIDs) | An oracle solution proves the grader can pass |
| [Aider polyglot](https://aider.chat/2024/12/21/polyglot.html) | `pass_rate_N`: tasks with all tests passing in N tries | Public problems; scores saturate | Malformed responses and timeouts are reported apart from the pass rate; the commit is recorded |
| [OpenAI Evals](https://github.com/openai/evals/blob/main/docs/eval-templates.md) | Match/Includes templates or `ModelBasedClassify` | Self-grading bias; invalid output is folded into the score | Judged scores are kept apart from status |

Metrics, each reported separately on every grade:

- **Criteria pass rate** = passed / evaluated. Each `AC-n` of the run's SDLC acceptance criteria is `pass` (an `AC-n … PASS`
  line in `.factory/evidence.md`), `fail` (a `FAIL` line) or `missing`. Missing criteria are not evaluated, so the rate
  is `-` when none were evaluated; `total` is reported beside it. Any `FAIL` takes precedence over conflicting `PASS` lines.
- **PR checks**: the PR's check rollup (`SUCCESS`, `FAILURE`, `PENDING`, `NONE`, `missing`). Checks are required when
  the goal sets `expect.pr.checks`; for a prompted `done` run, when the PR reported any.
- **Benchmarks**: `expect.benchmarks` is a list of `{id, baseline, higherIsBetter, tolerance}` with fixed baselines.
  The run writes the values to `.factory/benchmarks.json` (`{"id": number}`); a value worse than the baseline by more
  than the tolerance has regressed. Editing a goal in Foldkit preserves its benchmarks and improvement policy,
  even though those settings are not editable in the form.
- **Cost**: the run's spend when it was graded (`cost.total` and `cost.byStep`: USD, AIC, tokens, calls; agents with no
  step count as `coordinator`), from the same roll-up as `sf cost`. Recorded only; it **never changes the status**,
  and a failed cost lookup is only logged. `sf goal history` shows the USD on each grade line. Older grades have none.
- **Quality** (optional `.factory/quality.json`): model-judged scores, each with its judge model and harness. They are
  stored but **never change the status**. An unreadable or malformed quality file records only an evidence note.

Rubric (`gradingVersion` `g1`), applied in order:

| # | Condition | Status |
|---|---|---|
| 1 | Any evaluated criterion fails, a PR check fails, or a benchmark regressed | `fail` |
| 2 | The grader could not grade (a `gh` failure or bad output, an unreadable or malformed evidence file) | `error`: a grading error, not a failed run |
| 3 | Evidence is missing: no evaluated criteria or a `missing` one, required checks not `SUCCESS`, no PR when one is required, or a benchmark value absent | `unknown` |
| 4 | Every required result passes | `pass` |

Limitations: criteria verdicts come from the run's own evidence file, so a run that writes `PASS` dishonestly passes
that criterion (the PR checks and the human reviewer are the counterweight). Benchmarks are only as good as the
numbers the run writes. One grade per report is not a statistic: compare pass rates only within one grading version.

Where grades live (key `threadId|reportCommit|reportStatus|gradingVersion`; a replayed report with the same key is
dropped, so a restart never duplicates a grade):

- Every minute, the coordinator regrades an `unknown` grade whose PR checks were `PENDING`. Once checks settle,
  it replaces that grade under the same key, never appending a second grade. Settled grades cannot be superseded,
  and replaying a completion does not regrade it.
- **Saved goal** (the thread was created with `goalId`): a `GoalRun` line with a `grade` in
  `docs/goals/factory/<id>.runs.jsonl`. Its `outcome` is the grade status. `sf goal list` and the run limit count only
  lines without a grade; `sf goal history` marks grade lines `grade` with the criteria rate and grading version.
  The thread retains the validated goal snapshot from launch, so edits or deletion cannot change its benchmarks or
  retry policy. Older threads without a snapshot report goal lookup failures as grading errors, never as plain prompts.
  Grades are also saved on the thread, keeping them available through the run API if the goal log cannot be read or written.
  Regrading atomically replaces the matching grade line using a temporary file and rename; all other lines,
  including runner lines, remain byte-identical.
- **Plain prompt**: in the thread's `grades` in `threads.json`; `subject.id` is the first 12 hex digits of the prompt's
  sha256.
- Each grade links the thread, the factory commit, the report commit, the grading version and its evidence (files read
  with their sha256, the PR URL, the commit). `GET /api/runs/<thread>` shows `grades`, `prError` and `improvement`.
  The Foldkit **◎ Goals** dialog charts them under **Grade history**: one chart per goal and grading version, never
  merged.

Improvement policy: a failed grade opens one improvement proposal, a desk approval ("Launch improvement run" or
"Reject"), keyed by the grade key. A pending grade that settles to failure opens at most one proposal.
Each distinct failed grade can propose new work, even after an earlier proposal was rejected; earlier
proposals retain their own approval routing and retry state. Only a human answer launches it: the answer must have no `by`
(goal runners always send one), the goal's
`improve.approval` can only be `"human"`, and the proposal is not part of any goal run's approvals. On "Launch", the
coordinator starts one Factory improvement conversation in the factory checkout. A failed launch is retried at most
`improve.maxRetries` times (default 1). This must be a whole number >= 0; goal saves and Foldkit drafts reject
fractional, negative, or nonfinite counts rather than rounding them. Zero allows only the initial launch.
A run started to improve the Factory never opens a proposal of its own, and
merging its PR stays human. Risk: the approval API is unauthenticated, as for every approval; any local caller that
omits `by` counts as the human.

## Model routing

- `SF_AUTH=native`: each runtime gets the host GitHub token (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`).
  Model calls go to the Copilot subscription (`isByok:false`).
- `SF_AUTH=proxy`: each session gets a `ProviderConfig` of type `openai` at `SF_PROXY_URL` (default
  `http://localhost:8080/v1`). The runtime starts with `--no-auto-login`, so no GitHub token is passed (`isByok:true`).
- Workers inherit the coordinator's mode. Only coordinators start workers (`spawn_worker`).

## Coordinator

- `src/factory.ts`: one `CopilotClient` per worker, `RuntimeConnection.forTcp({ port: 0 })`, own `COPILOT_HOME`
  (`baseDirectory`). `onEvent` is registered before `session.create`, so no event is lost.
- `src/tools.ts`: coordinator tools `spawn_worker`, `report_up` (sub-coordinators), `list_workers`, `message_worker`,
  `read_worker`, `stop_worker`, `render_ui` (OpenUI Lang).
- `src/agui.ts`: Copilot SDK events → AG-UI (`TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT`, `RUN_*`).
- `openui-prompt.txt`: the OpenUI chat-library prompt (from `@plana-solutions/agent-interface/prompt`, trimmed).

## Security review

`src/security.ts` runs automatically when a `spawn_worker` worker with `step: "implement"` first goes idle after its
task:

1. A new reviewer worker loads only Cloudflare's [security-audit](https://github.com/cloudflare/security-audit-skill)
   skill (no ub-mode, no quality-gate tools), with the implement worker's auth, audits `git diff <base>` of the
   worktree, and writes `findings.json` outside the worktree.
2. `confirmed` and `needs_validation` findings are triaged by Jev (`keep`, or discard as false positive, out of scope,
   or low risk). Without a Jev key, or on error, every finding is kept.
3. Kept findings go to a fix worker (implement) and then a verify worker. Discarded findings are logged with their
   reason.

Until the review is `done` or `failed`, `next_step` returns `wait_security_review`. Every transition publishes
`factory.security_review`; `GET /api/steps` returns `securityReviews`, shown in the UI. Fix workers never trigger
another review. While a review is unfinished (from its start until `done` or `failed`), `spawn_worker` refuses every
spawn in that worktree, whatever the step. Every review, fix, and verify worker is stopped when the review ends, fails,
or times out.

- `SF_SECURITY_MODEL`: reviewer model (blank counts as unset). Default: the copilot-proxy-rs routed model, else
  `SF_MODEL`.
- Gate workers (code review, security review, evaluator, and their fix and verify workers) have **no short time
  limit**: the goal's cost limit bounds spending. `src/gateWorker.ts` replaces a worker that is **stuck**: it ended in
  error, `[workers] stuck_failed_tools` (5) tool calls failed in a row, or it was silent for `stuck_quiet_minutes` (10)
  while no tool call was running (a long build or test is a running tool call, so it is never silent). A stuck worker
  is stopped and a fresh one gets the same task, `retries` (1) times; then the gate fails with the reason. Backstop:
  a worker still running after `wait_minutes` (90) counts as stuck. `SF_SECURITY_TIMEOUT_MS` overrides the backstop.

## Fan-out: research, decisions and optimizations

For comparative research, design decisions and find-optimizations requests, the sub-coordinator of a repo conversation
calls `fanout` with the exact request. One catalog (`FANOUT_CATALOG` in `coordinator/src/workflows.ts`) holds the
research workflows and the `trx guide --optimize` lenses. Jev answers one independent Noul question per entry in one
request; entries at or above 0.65 are selected, at most 4 (the most probable win), including no match.

## Harnesses

The model picks the harness. A Claude model runs in the Claude Agent SDK; any other model runs in the Copilot SDK. This
applies to the desk, General chats and sub-coordinators (their model at spawn), and to workers with `workers.harness =
auto` (pinned, routed or default model). A step that needs skills or plugins built for another harness names it
(`harness` in `coordinator/src/steps.ts`), and `spawn_worker` takes `harness` (`claude` or `pi`) and `profiles`; these
choices win for workers. The finish worker stays in the Copilot SDK. Jev picks from the copilot-proxy-rs `GET /v1/models`
list; a worker model the native Copilot runtime does not serve (e.g. `gemini-4-argon`) runs over proxy auth.

A Claude coordinator gets the run's AG-UI client tools on an extra MCP server (`setMcpServers`). A coordinator whose new
model needs the other SDK stops after its turn and starts in that SDK on its next message. Before it stops it writes a
handoff (its own summary, else the last turns from the event log) that the new session gets first;
the desk restarts the service once no agent runs. The Copilot model list comes from the desk's runtime, else from a
small Copilot client of its own.

Every worker has a `generate_image` tool (`coordinator/src/images.ts`): Jev picks the image model from copilot-proxy-rs
(`POST /v1/models` with `type: "image"`), the proxy generates it (`POST /v1/images/generations`), and the file is
saved in the worker's folder, by default in `.factory/images/` (git-excluded). A named `path` must stay inside that
folder, not under `.git`, end in `.png`, `.jpg`, `.jpeg` or `.webp` (the image is made in that format), and not be a
symlink; an existing file is replaced only with `overwrite: true`. The
factory composes the trx profiles in process, as `trx run <harness> <profile>` would, and runs the worker in that
harness's TypeScript SDK:

- **Claude** (`src/claude.ts`, Claude Agent SDK): plugins, `CLAUDE_CONFIG_DIR` and copilot-proxy-rs env. Permission mode
  `default`, so every prompt goes through `canUseTool`, which denies merge, push and delete.
- **Pi** (`src/pi.ts`, Pi SDK): skills, extensions, provider and model from the profile; an inline `tool_call` extension
  applies the same deny rule. Pi has no skill tool: a `read` of a loaded `SKILL.md`, or a `/skill:name` prompt, counts
  as `skill.invoked`.

Both map their events to the Copilot event names, so the feed, `read_worker`, the supervisor and the UI treat them like
any other worker. Council, Six Hats and Hyperresearch run in Claude. Each saves a separate `reports/<step>.md`.
Selection probabilities appear in `factory.workflows_selected`.

The sub-coordinator collects every worker, then starts `step=synthesis` to write `reports/synthesis.md` and calls
`report_up`. Synthesis is refused until all selected workers are idle, collected, and have nonempty report files. Launch
failures are reported explicitly. This report-only path does not trigger the implementation/security loop or authorize
application edits, commits, pushes, or merges.

## Report-up loop

A sub-coordinator calls `report_up` (`src/report.ts`) when its delivery loop is `done`, `blocked`, or `needs-decision`:
summary, checks with evidence, gaps, and next steps; branch and commit always come from `git rev-parse` in its worktree
(`unknown` outside git); the model cannot set them. `report_up` succeeds only once the report was handed to the global
coordinator; a failed delivery returns an error and can be retried. The report becomes a
`[report from <folder> · <title>]` turn in the newest General conversation (else a new "Reports" one) for the global
coordinator, which proposes the next step with `request_approval` (`reportThreadId` set) and relays the human's answer
with `message_conversation`. A repeat for the same commit and status is dropped; each publishes `factory.report_up`.

When a sub-coordinator goes idle without reporting, and Jev's last `moreWork` was below 0.3, a worker or review failed,
or its session errored, the factory nudges it once per turn to call `report_up`. Never while workers run, a review is
pending, or a decision is open. Merges and deletes stay human decisions.

Shipping: a sub-coordinator calls `request_approval` with `ship=true` (its branch must be `factory/*`). When the human
picks the first option, `spawn_worker step=finish` starts a finish worker whose gate allows only
`git push [-u] origin <that branch>` (no force). It opens or updates the PR and loops until every check is green: read
failures, fix, test, commit, push, at most 5 fix rounds after the first push per approval (the gate rejects the next
push; a new approval resets it). Decisions, ship grants and push counts are kept in SQLite (`approvals.db` in the state
directory), so they survive a restart; an old `approvals.json` is imported once. It never merges. All agents are refused
`gh pr merge`, `gh pr close -d`, and `gh repo delete`; `gh api` stays open.

## Independent evaluator

`src/evaluate.ts` ([ADR 0006](../../docs/adr/0006-factory-acceptance-evaluator.md)). One worker (`step=evaluate`) from a
model family other than the builder's, in a fresh context, with a permission gate: it may build, run and call the
deliverable, writes only its own output folder (outside the worktree), and never changes git state.

1. **Contract** (`sdlc_plan`, in the background): one `check` and `expect` per criterion, or a `problem` and a testable
   `rewrite`. `sdlc_plan` returns at once; `next_step` returns `wait_contract` and a `topic=plan` approval is refused
   while it runs, and while open problems remain, for `[evaluate].contract_rounds` rounds (default 2). After the last
   round the open problems are appended to the plan approval summary. The factory writes `.factory/contract.md`;
   implement and verify tasks get each criterion with its check. A contract applies only to the exact criteria it was
   agreed for: new criteria drop it (and its file). Criteria the goal page locked are never sent back. A restart
   stops a running contract without counting its round.
2. **Evaluation** (first ship request after the floors and other gates, before the final security review): it runs
   every check and writes `verdicts.json` (a criterion with no verdict fails). A failed criterion gets a fix
   (`implement`) and a `verify` worker, then a new evaluation, at most `[evaluate].max_rounds` evaluations (default 2).
   It **never blocks shipping**: the verdicts go to the PR body (`## Independent evaluation`) and the grade, and the
   `show_evaluation` card shows them live.
3. **Grade `g2`**: when an evaluation has verdicts, the criteria come from them; `selfCriteria` keeps the run's own
   `evidence.md` results and `disagreements` lists criteria the run marked PASS and the evaluator failed. Without an
   evaluation the grade stays `g1`. `g1` and `g2` are charted apart.

A coordinator restart marks a running evaluation failed; the next ship request runs it again.

## Restart resume

A coordinator stop (`factory:restart`, SIGTERM) publishes `factory.shutdown` with every running agent. The next start
sends each repo conversation that had running work one `[factory restarted]` turn (`src/resume.ts`,
`prompts/resume.md`): the stopped workers and their tasks, the branch commits, uncommitted files, criteria and gates.
The sub-coordinator spawns the stopped steps again. A code review the restart stopped runs again by itself and its
round is not counted; a stopped security review starts again at the next ship request. `factory.resumed` marks the
shutdown handled, so a second restart does not repeat it. A crash (no shutdown record) resumes nothing.
`sf goal run` keeps polling while the coordinator is unreachable or answers 5xx.

## Notes

- `web-foldkit` uses npm `overrides` because `foldkit@0.169.0` peers `effect@4.0.0` but `agent-interface@0.5.0` peers
  `effect@4.0.6`.
- State lives in `~/.local/state/trellage/factory/<worker-id>` (override with `SF_STATE_DIR`).
- Ctrl-C stops the coordinator and terminates every runtime process.

## Factory home file

`~/projects/FACTORY.md` (override with `SF_HOME_FILE`) says how the human's repos relate and which rules cross them.
Text before the first level-2 heading goes to every agent. A `## <folder name>` heading starts a section that goes
only to agents in that repo.

- The desk and General chats get the whole file, so they pick the right repo.
- A repo sub-coordinator, every worker it spawns, and Discover on the goal page get the shared text plus their
  repo's section. Workers run in worktrees outside `~/projects`, so their harness never finds the file itself.
- Each copy is tagged with the file's path and a 12-character hash. Discover lists it as a fact.
- Keep paths in Folders, build and test commands in each repo's AGENTS.md, and secrets out.
- Read at use time: an edit applies to the next session, worker, or Discover call.
- A section reaches only a folder with the same name. At start and on each new folder, the coordinator log
  names sections with no folder and folders with no section.

## Factory config and prompts

One rule: text a model reads is a prompt file, numbers and model names are config, contracts with code stay in code.

- Prompt files: `coordinator/defaults/prompts/` (system prompts, worker tasks, Jev questions, and the catalogs
  `steps/`, `research/`, `lenses/`, `gates/`). Override one by putting a file at the same path under
  `~/.config/trellage/factory/prompts/`; add a catalog item by adding a file.
- Config: `coordinator/defaults/config.toml`, overridden key by key in `~/.config/trellage/factory/config.toml`.
  `sf config sync [--dry-run]` adds the shipped sections and keys your file lacks, commented out with their comments,
  so you see every option and its default; it never changes a line you have, and works with the factory down.
- Edits apply live; a delivery run keeps the config and prompts it started with.
- Full reference, including a walkthrough of `~/.config/trellage/factory/`: `coordinator/AGENTS.md`.

## Self-updating UI (agent access parity)

One settings document (`coordinator/src/settings.ts`) drives the UI. The UI and the agent edit it the same way: a JSON
merge patch.

- UI: `PATCH /api/settings` from the ⚙ drawer (hotkey `,`) and hotkeys.
- Agent: `get_settings` / `update_settings` tools.
- Every change is validated, saved to `$SF_STATE_DIR/settings.json`, and broadcast as `factory.settings_updated` on
  `/api/feed`, so every open UI updates live.

| Setting | Effect |
|---|---|
| `theme`, `themes` | Palette applied to factory and OpenUI tokens. The agent can create themes. |
| `navbar` | status, workers, model, context bar, auth, crons. |
| `banner`, `animations`, `hotkeys`, `focus` | Pinned note, busy pulse, key map, agent the Inbox shows. |
| `inboxCritters`, `treeStyle` | Critters and connector lines of the Inbox conversation tree and canvas. |
| `agent.model`, `agent.reasoningEffort` | Switches the live coordinator session (`Session::set_model`). |
| `agent.disabledTools` | Permission handler rejects those built-in tool kinds. |
| `agent.instructions` | Added to every coordinator turn. |
| `crons` | Prompts sent to the coordinator on a schedule (min 30 s) while it is idle. |

## UI extensions (agent-written code)

For changes no settings field covers (animations, canvases, widgets), the agent writes an extension. Each one is saved
in `settings.extensions` and mounted live in the UI by `shared/extensions.ts`.

- `slot`: `chat-background`, `page-background`, `navbar`, `banner`, `overlay` (`panel-top` is still accepted but has no
  host since the worker panel was removed). The UI renders empty `[data-slot]` divs; the host owns their children.
- `js`: body of `function (el, api)`. Returns a cleanup function. `api` =
  `{settings, palette, workers, onSettings, onWorkers}`.
- `css`: global. Stable hooks: `.sf-chat`, `.sf-nav`, `.sf-panel`, `[data-ext="<name>"]`.
- Errors (sync, timers, animation frames) are posted to `/api/extension-errors`. The agent reads them with
  `extension_errors` and fixes its code.
- Extension code runs with full page access. Treat it like code you run yourself.

## Event store

Every agent's compact event log is saved in one SQLite file, `$SF_STATE_DIR/events.db` (`coordinator/src/events.ts`), so
the UI shows it after a restart. An old per-agent `events.json` is imported once and removed.
