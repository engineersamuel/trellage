You will work in a loop until the task meets the bar.

This file is the only memory. It must work in one long conversation
and in a fresh process that has only this file.

FILL IN BEFORE THE FIRST RUN (the human writes these; the loop never edits them):
TARGET REPO: /Users/smendenh/projects/copilot-proxy-rs
TARGET BASE: main
FEATURE PROMPT:
Integrate process-compose (https://github.com/F1bonacc1/process-compose) into copilot-proxy-rs and operate it with mise tasks. Install mise if it needs to be installed.
- Pin `process-compose` in `mise.toml` `[tools]`.
- Add `process-compose.yaml` that runs the proxy with a readiness probe on `/health`. The proxy keeps listening on TCP 8080 by default (port from `COPILOT_PROXY_RS_PORT`).
- process-compose's own control API must use a unix socket (`-U` / `PC_SOCKET_PATH`), never TCP, so it never takes port 8080 from the proxy.
- mise tasks: `proxy:up` (detached), `proxy:down`, `proxy:restart`, `proxy:status`, `proxy:logs`.
- `scripts/bootstrap.sh`: installs mise when it is missing, then `mise install`. Document it and the tasks in README.
- Keep `compose.yaml` as it is.
- Proof: run `COPILOT_PROXY_RS_PORT=18080 mise run proxy:up`, `curl -fsS 127.0.0.1:18080/health`, `mise run proxy:status`, `mise run proxy:down`, and put that output in the PR body. Never stop, restart, or bind the instance already running on port 8080.
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test --locked` pass.
EXPECTATION (written to /tmp/sf-expect.json by the loop):
{"steps":["implement","verify","security","finish"],"pr":{"state":"OPEN","checks":"SUCCESS"}}
RUN LIMIT: 5

TASK:
Make the software factory deliver the FEATURE PROMPT as an OPEN pull request in TARGET REPO whose checks are green and whose run meets EXPECTATION. The factory under test is the one running from this checkout (`prototypes/software-factory`). When a run fails, find the cause in the factory (code, prompts, step catalog, tools), fix it in this checkout with a test, restart the factory, and start a new run. The feature itself is the factory's job: never edit TARGET REPO or the factory's worktrees by hand.

SETUP (once; run from prototypes/software-factory):
- `mise run factory:status`; if it is down, `mise run factory:up`.
- Folder id: `./sf folders TARGET_REPO` (adds it, or prints the existing one).
- Write EXPECTATION to /tmp/sf-expect.json.

ONE RUN:
1. Start: `./sf -f <FOLDER_ID> -b <TARGET BASE> "<FEATURE PROMPT>"`. The thread id prints on stderr as `thread <ID>`. Record it in SCOREBOARD. `-b` makes the PR target TARGET BASE.
2. Watch: `./sf verify <THREAD> /tmp/sf-expect.json 5400`.
   - Exit 0: met. Go to VERIFY.
   - Exit 2: a decision is pending. `./sf approvals`. Answer only the ship approval of this thread with its first option (`./sf approve <ID> "<option>"`); for any other decision, follow the FEATURE PROMPT's intent and log the choice in LEARNINGS. Then go to step 2 again.
   - Exit 3: the run reported blocked. Diagnose.
   - Exit 1: timeout. Diagnose.
3. Diagnose: `./sf run <THREAD>` (workers, steps, report, PR), `curl -s '127.0.0.1:7700/api/events?workers=<ID,ID>&perWorker=200'`, `mise run factory:logs`. Name the factory defect: the code or prompt that made the run go wrong, not the symptom.
4. Fix: change this checkout, add or update a test, `make factory-test` (from the repository root) must pass, commit locally (no push). Then `mise run factory:restart coordinator`. A restart stops running workers, so restart only between runs.
5. Next run: a new thread (step 1). Do not continue a failed thread.

SUCCESS CRITERIA (be strict):
- Delivery: `sf verify` exits 0 for one thread: every expected step ran, the PR is OPEN against TARGET BASE with checks SUCCESS.
- Feature proof: the PR body and diff do what the FEATURE PROMPT asks, with tests or other proof the prompt names. Read the diff with `gh pr diff` in TARGET REPO; do not trust the summary.
- No merge: no agent merged, closed, or deleted anything; the human merges.
- Factory fixes: every factory defect found has a committed fix with a test; `make factory-test` passes.
- Evidence: SCOREBOARD names every thread, the PR URL, and the command output for each criterion.

LIMITS:
- At most RUN LIMIT runs. At the limit, print BLOCKED with the weakest point and stop.
- Never edit `coordinator/src/guard.ts` or the approval and ship-grant code (`approvals.ts`, `shipGrant` in `tools.ts`). If a run needs them changed, stop and report BLOCKED with why.
- Never merge, close, or delete a PR, branch, or worktree.

SCOREBOARD (overwrite this block after every VERIFY; do not append):
Status: ITERATING
Runs used: 0/5
Scores:
- Delivery: _
- Feature proof: _
- No merge: _
- Factory fixes: _
- Evidence: _
Weakest: _
Threads / PR: _
Last change: Created.

LEARNINGS (at most 8 bullets; replace stale ones; no narrative):
- Runs started before the `step` field existed show `step: null`; only new runs count.
- A past run blocked because its sub-coordinator ran `git push` itself instead of asking for ship approval and spawning step=finish.

LOOP PROTOCOL, repeat every turn:
1. READ   - read this file. SCOREBOARD and LEARNINGS are hints only.
2. PLAN   - state the single next step. If Weakest is set, start there.
3. DO     - produce or improve the work.
4. VERIFY - score the artifact 1-10 on each criterion.
            Re-score from the artifact, not from SCOREBOARD.
            Be brutally honest. List exactly what is still weak.
            Then overwrite SCOREBOARD. Add or compact LEARNINGS.
            Write this file before you stop.
5. DECIDE - if every criterion is 8+, print FINAL and stop.
            Otherwise print ITERATING and go again, fixing
            the weakest point first.

RULES:
- Never call it done until every criterion is 8 or higher.
- Each pass must fix the weakest score from the last VERIFY.
- Do not ask me questions. Make a sensible assumption
  and keep going.
- Do not create a second progress file. Keep all state in this file.
- Do not edit TASK, SUCCESS CRITERIA, LOOP PROTOCOL, or RULES.

Begin.
