# Software Factory prototypes

One TypeScript coordinator (Bun). Two frontends (dark theme) on the same backend stream.

```
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
mise run factory:restart coordinator   # one service (coordinator | copilotkit | foldkit); no name restarts all
mise run factory:status | factory:logs | factory:tui | factory:down
```

The tasks are in the repository `mise.toml`. The services run detached under [process-compose](https://f1bonacc1.github.io/process-compose/) (`process-compose.yaml`; mise installs the pinned version). Each service restarts when it exits. `factory:tui` attaches the process-compose TUI (status and live logs; `q` leaves it, the services keep running). The API is the unix socket `$SF_STATE_DIR/pc.sock`, not TCP, because copilot-proxy-rs uses port 8080. Logs are in `$SF_STATE_DIR/logs` (default state dir: `$TMPDIR/software-factory`).

| Option | URL |
|---|---|
| 1 React + CopilotKit 2.0 RC | http://localhost:5173/copilotkit.html |
| 2 Foldkit + agent-interface | http://localhost:5174/ |
| Coordinator API | http://127.0.0.1:7700/ |

## Goals: the self-improve loop

A goal is one test case for the factory: a prompt for a repo, and what the run must show. The loop runs the goal; when the run fails, an outer agent fixes the factory code, commits, restarts, and runs again until it passes. Agents open PRs; a human merges.

| Part | Where |
|---|---|
| Spec Schema, scoring, form draft | `shared/goal.ts` (one Schema for the UI, the API and `sf`) |
| Specs and run logs | `docs/goals/factory/<id>.json`, `<id>.runs.jsonl` (append only; each line has the factory commit) |
| API | `GET/POST /api/goals`, `GET /api/goals/<id>`, `GET /api/goals/<id>/prompt`, `GET/POST /api/goals/<id>/runs`, `GET /api/runs/<thread>` |
| Form | Foldkit navbar **◎ Goals**: steps and skills come from `/api/steps`, repos from `/api/folders` |
| CLI | `sf goal list | show ID | new | save FILE | run ID [--thread T] | check ID THREAD | history ID` |
| Loop protocol | `skills/factory-loop/SKILL.md`; `mise run factory:skill` links it so `/factory-loop <id>` works in Claude Code |

A spec says:

- `expect.steps`: step id → `{min, max}` workers on that step (e.g. `review: {min: 1}`, `finish: {min: 1, max: 1}`).
- `expect.skills`: skills some worker must have invoked (`skill.invoked` events).
- `expect.pr`: `state`, `checks`, `base` (defaults to the goal's base), `bodyIncludes`, `untouched` files.
- `approvals`: per topic (`plan`, `findings`, `ship`, `other`) who answers: `auto` (the runner picks the first option) or `human` (`sf goal run` stops with exit 2). Approvals carry a `topic`; a ship request is always `ship`.
- `limits`: runs per loop, minutes per run.

Flow: fill the form (or `sf goal new`) → copy `/factory-loop <id>` → paste into Claude Code. `sf goal run` exits 0 pass, 1 fail/timeout, 2 waiting for the human, 3 blocked. `sf -f FOLDER -b BRANCH` branches the worktree from BRANCH and the finish worker opens the PR against it. `make factory-test` (also in CI) runs the coordinator type check and tests.

## Model routing

- `SF_AUTH=native`: each runtime gets the host GitHub token (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`). Model calls go to the Copilot subscription (`isByok:false`).
- `SF_AUTH=proxy`: each session gets a `ProviderConfig` of type `openai` at `SF_PROXY_URL` (default `http://localhost:8080/v1`). The runtime starts with `--no-auto-login`, so no GitHub token is passed (`isByok:true`).
- Workers inherit the coordinator's mode. Only coordinators start workers (`spawn_worker`).

## Coordinator

- `src/factory.ts`: one `CopilotClient` per worker, `RuntimeConnection.forTcp({ port: 0 })`, own `COPILOT_HOME` (`baseDirectory`). `onEvent` is registered before `session.create`, so no event is lost.
- `src/tools.ts`: coordinator tools `spawn_worker`, `report_up` (sub-coordinators), `list_workers`, `message_worker`, `read_worker`, `stop_worker`, `render_ui` (OpenUI Lang).
- `src/agui.ts`: Copilot SDK events → AG-UI (`TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT`, `RUN_*`).
- `openui-prompt.txt`: the OpenUI chat-library prompt (from `@plana-solutions/agent-interface/prompt`, trimmed).

## Security review

`src/security.ts` runs automatically when a `spawn_worker` worker with `step: "implement"` first goes idle after its task:

1. A new reviewer worker loads only Cloudflare's [security-audit](https://github.com/cloudflare/security-audit-skill) skill (no ub-mode, no quality-gate tools), with the implement worker's auth, audits `git diff <base>` of the worktree, and writes `findings.json` outside the worktree.
2. `confirmed` and `needs_validation` findings are triaged by Jev (`keep`, or discard as false positive, out of scope, or low risk). Without a Jev key, or on error, every finding is kept.
3. Kept findings go to a fix worker (implement) and then a verify worker. Discarded findings are logged with their reason.

Until the review is `done` or `failed`, `next_step` returns `wait_security_review`. Every transition publishes `factory.security_review`; `GET /api/steps` returns `securityReviews`, shown in both UIs. Fix workers never trigger another review. While a review is unfinished (from its start until `done` or `failed`), `spawn_worker` refuses every spawn in that worktree, whatever the step. Every review, fix, and verify worker is stopped when the review ends, fails, or times out.

- `SF_SECURITY_MODEL`: reviewer model (blank counts as unset). Default: the copilot-proxy-rs routed model, else `SF_MODEL`.
- `SF_SECURITY_TIMEOUT_MS`: wait per review, fix, or verify worker (default 1200000, 20 minutes).

## Fan-out: research, decisions and optimizations

For comparative research, design decisions and find-optimizations requests, the sub-coordinator of a repo conversation calls `fanout` with the exact request. One catalog (`FANOUT_CATALOG` in `coordinator/src/workflows.ts`) holds the research workflows and the `trx guide --optimize` lenses. Jev answers one independent Noul question per entry in one request; entries at or above 0.65 are selected, at most 4 (the most probable win), including no match.

## Harnesses

Copilot SDK is the default harness for every worker. A step that needs skills or plugins built for another harness names it (`harness` in `coordinator/src/steps.ts`), and `spawn_worker` takes `harness` (`claude` or `pi`) and `profiles`. The factory composes the trx profiles in process, as `trx run <harness> <profile>` would, and runs the worker in that harness's TypeScript SDK:

- **Claude** (`src/claude.ts`, Claude Agent SDK): plugins, `CLAUDE_CONFIG_DIR` and copilot-proxy-rs env. Permission mode `default`, so every prompt goes through `canUseTool`, which denies merge, push and delete.
- **Pi** (`src/pi.ts`, Pi SDK): skills, extensions, provider and model from the profile; an inline `tool_call` extension applies the same deny rule.

Both map their events to the Copilot event names, so the feed, `read_worker`, the supervisor and both UIs treat them like any other worker. Council, Six Hats and Hyperresearch run in Claude. Each saves a separate `reports/<step>.md`. Selection probabilities appear in `factory.workflows_selected`.

The sub-coordinator collects every worker, then starts `step=synthesis` to write `reports/synthesis.md` and calls `report_up`. Synthesis is refused until all selected workers are idle, collected, and have nonempty report files. Launch failures are reported explicitly. This report-only path does not trigger the implementation/security loop or authorize application edits, commits, pushes, or merges.

## Report-up loop

A sub-coordinator calls `report_up` (`src/report.ts`) when its delivery loop is `done`, `blocked`, or `needs-decision`: summary, checks with evidence, gaps, and next steps; branch and commit always come from `git rev-parse` in its worktree (`unknown` outside git); the model cannot set them. `report_up` succeeds only once the report was handed to the global coordinator; a failed delivery returns an error and can be retried. The report becomes a `[report from <folder> · <title>]` turn in the newest General conversation (else a new "Reports" one) for the global coordinator, which proposes the next step with `request_approval` (`reportThreadId` set) and relays the human's answer with `message_conversation`. A repeat for the same commit and status is dropped; each publishes `factory.report_up`.

When a sub-coordinator goes idle without reporting, and Jev's last `moreWork` was below 0.3, a worker or review failed, or its session errored, the factory nudges it once per turn to call `report_up`. Never while workers run, a review is pending, or a decision is open. Merges and deletes stay human decisions.

Shipping: a sub-coordinator calls `request_approval` with `ship=true` (its branch must be `factory/*`). When the human picks the first option, `spawn_worker step=finish` starts a finish worker whose gate allows only `git push [-u] origin <that branch>` (no force). It opens or updates the PR and loops until every check is green: read failures, fix, test, commit, push, at most 5 fix rounds after the first push per approval (the gate rejects the next push; a new approval resets it). Decisions, ship grants and push counts are kept in SQLite (`approvals.db` in the state directory), so they survive a restart; an old `approvals.json` is imported once. It never merges. All agents are refused `gh pr merge`, `gh pr close -d`, and `gh repo delete`; `gh api` stays open.

## Notes

- `web-foldkit` uses npm `overrides` because `foldkit@0.169.0` peers `effect@4.0.0` but `agent-interface@0.5.0` peers `effect@4.0.6`.
- State lives in `$TMPDIR/software-factory/<worker-id>` (override with `SF_STATE_DIR`).
- Ctrl-C stops the coordinator and terminates every runtime process.

## Self-updating UI (agent access parity)

One settings document (`coordinator/src/settings.ts`) drives both UIs. The UI and the agent edit it the same way: a JSON merge patch.

- UI: `PATCH /api/settings` from the ⚙ drawer (hotkey `,`) and hotkeys.
- Agent: `get_settings` / `update_settings` tools.
- Every change is validated, saved to `$SF_STATE_DIR/settings.json`, and broadcast as `factory.settings_updated` on `/api/feed`, so every open UI updates live.

| Setting | Effect |
|---|---|
| `theme`, `themes` | Palette applied to factory, CopilotKit and OpenUI tokens. The agent can create themes. |
| `layout` | Worker panel right / left / hidden, width 25–70%. |
| `navbar` | status, workers, model, context bar, auth, crons. |
| `banner`, `animations`, `hotkeys`, `focus` | Pinned note, busy pulse, key map, peer-panel worker. |
| `agent.model`, `agent.reasoningEffort` | Switches the live coordinator session (`Session::set_model`). |
| `agent.disabledTools` | Permission handler rejects those built-in tool kinds. |
| `agent.instructions` | Added to every coordinator turn. |
| `crons` | Prompts sent to the coordinator on a schedule (min 30 s) while it is idle. |

## UI extensions (agent-written code)

For changes no settings field covers (animations, canvases, widgets), the agent writes an extension. Each one is saved in `settings.extensions` and mounted live in both UIs by `shared/extensions.ts`.

- `slot`: `chat-background`, `page-background`, `navbar`, `banner`, `panel-top`, `overlay`. Both UIs render empty `[data-slot]` divs; the host owns their children.
- `js`: body of `function (el, api)`. Returns a cleanup function. `api` = `{settings, palette, workers, onSettings, onWorkers}`.
- `css`: global. Stable hooks: `.sf-chat`, `.sf-nav`, `.sf-panel`, `[data-ext="<name>"]`.
- Errors (sync, timers, animation frames) are posted to `/api/extension-errors`. The agent reads them with `extension_errors` and fixes its code.
- Extension code runs with full page access. Treat it like code you run yourself.

## Event store

Every agent's compact event log is saved in one SQLite file, `$SF_STATE_DIR/events.db` (`coordinator/src/events.ts`), so the UI shows it after a restart. An old per-agent `events.json` is imported once and removed.
