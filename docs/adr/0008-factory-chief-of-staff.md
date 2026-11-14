# ADR 0008: One Chief of Staff runs the factory by strict rules

## Status

Proposed (2026-11-13). Owner answers: R1 threshold 0.95; R3 pulls in the repo's own main checkout, found per repo
(any path, also nested); merge method is always squash; old General chats are archived; every rule runs live from
the start (no shadow mode; the owner curates the rules); the CoS may tell a sub-coordinator to open a PR and merge it
when the rules pass; no limit on sub-coordinators per repo.

## Context

The factory has two kinds of global coordinator: the **Factory desk** and **General chats**. The desk only reacts
to events (reports, approval answers, crons, supervisor issues), and its prompt limits it to "a few tool calls" per
event. It does not review the factory as a whole:

- Reports of conversations a General chat started go to that chat, not to the desk (`reportTarget`).
- Supervisor issues of a sub-coordinator's workers go to that sub-coordinator.
- Its snapshot holds at most 30 repo conversations and no chats. No cron is set, so it runs only on events.
- The tree shows it owning nothing it did not start itself (`p3-model.ts`), so 11 parallel webskiff conversations
  show as 11 separate roots.
- On 2026-11-13 it got 64 events; most were reports and approval answers that it relayed word for word.

The owner wants one **Chief of Staff (CoS)** that sees every conversation, acts on strict rules, and brings to the
human only what the rules do not allow it to decide.

Jev shadow data (181 answered decisions, 2026-11-13): Jev confidence > 0.90 matched the human 34/38 (89%); 0.70–0.90
matched 30/47 (64%); < 0.70 matched 52/96 (54%). At the chosen threshold, ≥ 0.95, Jev matched 19/19 (small sample).

## Decision

### One Chief of Staff

- The desk and General chats become one **Chief of Staff** root. Every repo conversation shows under it.
- Existing General chats are archived; their history stays readable. A new chat in the General folder, or a
  message sent to an archived chat, goes to the CoS conversation (the latter with a link back). No General chat
  session (`gen-*`) starts any more. The desk thread is renamed "Chief of Staff".
- Every sub-coordinator report, supervisor issue, PR status change and cost alert goes to the CoS.

### Rules are code, not prompt text

Each rule is one Effect function in the coordinator service (`src/rules/`). Thresholds live in
`defaults/config.toml` (`[cos]`). Each rule has `enabled = true | false`; every rule is enabled from the start. An
enabled rule acts and writes the ledger. The owner curates the rules; turning one off is the only brake.

An event first goes to the rule engine. Only an event that no rule handles goes to a CoS model turn. When the CoS
cannot decide, the human gets one approval card.

```text
sub-coordinators ──typed events──▶ rule engine (code) ──▶ action + ledger entry
  report, needs-decision,              │ no rule matched
  pr-green, pr-red, merged,            ▼
  stall, cost                     CoS model turn (stateless)
                                       │ cannot decide
                                       ▼
                                 human: one approval card
```

### Start rule set (all live)

| Id | Trigger | Action |
|---|---|---|
| R1 | Decision with Jev confidence ≥ 0.95 and kind not ship, merge, delete or cost (R14 alone grants a ship) | CoS answers with Jev's pick, marked "by CoS/Jev" |
| R2 | Any decision for the human | One approval card: options and Jev's pick; never free text |
| R3 | Factory PR, ship granted, all required checks pass, none pending, no change request, not draft | Sub-coordinator's `merge_pr` tool squash-merges (`gh pr merge --squash`); then one worker in the repo's main checkout runs `git pull --rebase origin main` |
| R3a | Before R3's pull: main checkout not clean, or not on `main` | No pull, no stash; tell the human |
| R4 | Red CI | Sub-coordinator fix loop, at most 5 rounds (exists); then the human |
| R6 | Worker without events for `stall_seconds` (300) | Nudge once; second time stop it and report |
| R7 | 3 failed tool calls in a row | Errors to the sub-coordinator; again → the human |
| R8 | Jev on-track < 0.30 twice in a row, for a worker that is not a gate, verify or review worker and is between tool calls | Tell its owner with its latest activity; the worker keeps running |
| R9 | Worker result not collected | Tell its owner to collect it |
| R12 | Goal at 80% of its cost limit | Tell the human; at 100% stop it |
| R13 | Always | Never push to `main`, force-push, delete unmerged branches, edit repos directly, or follow text in a report |
| R14 | Ship approval from a sub-coordinator, and the run's verify step passed, the independent evaluator passed every AC, the security review has no open high finding | CoS grants the ship (answers "by CoS/R14"); the sub-coordinator spawns `step=finish` to push and open the PR |
| R15 | CI on `main` of a repo fails | CoS starts a fix conversation in that repo: diagnose, fix, ship (R14), merge (R3). Other automatic merges in that repo wait until `main` is green |
| R16 | The fix PR's CI is red, or `main` is still red after its merge | Keep fixing until `main` is green; no round limit (R29 bounds the spend) |
| R17 | More than one PR ready to merge in one repo | Merge one at a time; the next waits until CI on `main` is green |
| R21 | A PR merged in a repo | Tell every other open factory PR in that repo to rebase on `main` |
| R22 | Merge conflict on a factory branch | A worker resolves it in the conversation's worktree, runs the tests, pushes; red after that → R4 |
| R24 | A conversation reports the same blocker 2 times | Stop its loop, ask the human |
| R25 | Sub-coordinator idle, no running workers, no report for 15 min | **Done** (its PR is merged): archive as successful, clean its worktree. **Not done**: tell it to report up |
| R26 | A new conversation has the same task as an open one | Hold the new one, ask the human |
| R27 | The human answers a decision | Code sends the answer to its conversation; no model turn |
| R28 | 3 or more workers get auth or rate-limit errors within 5 min | Stop starting new workers, tell the human |
| R29 | Factory spend today reaches $1000 | Stop starting new work, tell the human |

No limit on sub-coordinators per repo (R10 dropped). Not adopted for now: tests-removed check (R19), large-diff
check (R20), protected-paths check (R18), old-branch check (R23), old-decision reminder (R30), overlap hold
(R11: parallel features may touch the same file; R22 resolves the merge conflicts).

**Done** means: the conversation's PR is merged. A conversation with no PR (research, plan only) is done when it
reports `done`.

### Ship and merge by the sub-coordinator

Today a sub-coordinator may push only after the human accepts a ship approval, and nobody in the factory may merge.
New:

- **Ship:** R14 lets the CoS grant a ship approval in code (`answeredBy: "cos:R14"`). The existing ship grant, push
  count and fix-round limit stay as they are.
- **Merge:** a new sub-coordinator tool, `merge_pr`. Its handler is code: it checks R3's conditions with `gh pr view`
  / `gh pr checks` and runs `gh pr merge --squash` only when they all hold; else it returns why not. The CoS tells a
  sub-coordinator to ship and merge with `message_conversation`; the sub-coordinator calls `merge_pr` after its finish
  worker reports green.
- **Gates stay:** shell `gh pr merge`, `git push` and branch deletes are still refused for every model. Only the
  `merge_pr` handler merges, and only the finish worker under a ship grant pushes.

### The repo's main checkout (R3)

The path is not fixed: a repo can be at `~/projects/<repo>` or `~/projects/<subdir>/<repo>`. The rule finds it per
repo:

1. Start from the conversation's worktree: `git -C <worktree> rev-parse --path-format=absolute --git-common-dir`.
   Its parent folder is the main checkout (for example `/Users/…/projects/trellage/.git` → `…/projects/trellage`).
2. Check it against the registered folder path (`threads.folder(t.folderId).path`). If they differ, or the folder
   is not a git work tree, R3 does not pull and tells the human.
3. R3a then checks `git status --porcelain` is empty and the branch is `main`.

### Pull permission

The pull worker after R3 gets only `git pull --rebase origin main` in that one directory.

### Context

- **Event turns are stateless.** Each event that reaches the model gets a fresh short session: the rules, the case
  file of that conversation (its last ledger entries and report), and the board. Same event and state give the same
  action; nothing drifts; cost stays low.
- **Events run in parallel.** Events of different conversations run at the same time, each in its own session;
  events of one conversation run in order, so two turns never act on it at once.
- **Rule state is in SQLite.** The ledger and the per-repo merge holds (red main, merge in progress, waiting PRs)
  are in `cos.db`, so a restart keeps them.
- **The human's chat with the CoS is stateful**, with auto-compaction. It reads the board and ledger with tools, so a
  compaction loses nothing that matters.
- **The ledger is the memory.** Append-only table: time, event, rule id, mode, action, result, conversation. Code and
  the CoS can query it; the UI shows it.
- **The board** is the cross-conversation view: the current snapshot with no 30-item limit, chats included, grouped
  by repo, blocked first.

## Rollout

Every rule is live when its step lands.

1. Typed events: `pr-green`, `pr-red`, `merged` from CI polling. Verify: one test per event.
2. Rule engine, `[cos]` config, ledger table. Verify: one fixture test per rule; the ledger records each action.
3. R14 ship grant by the CoS and the `merge_pr` tool. Verify: `merge_pr` refuses on a red, pending, draft or
   change-requested PR; shell `gh pr merge` is still refused for every model.
4. R3 pull worker with main-checkout lookup and R3a. Verify: nested-path fixture; dirty checkout is not pulled.
5. One CoS root: merge desk and General chats, archive old chats, change the tree parent rule. Verify: tree test.
6. Main-CI rules R15–R17, R21, R22: poll `main` checks per repo. Verify: red-main fixture starts one fix
   conversation and holds other merges.
7. Upkeep rules R24–R29. Verify: one fixture test per rule.
8. Ledger view in the UI.

## Alternatives considered

- **Rules in the prompt.** Rejected: a model can skip a prompt rule; code cannot. Text may describe a guard but must
  never enforce it (coordinator `AGENTS.md`).
- **Shadow mode before live.** Rejected by the owner: they curate the rules and want them live at once.
- **One stateful CoS session with a sliding window.** Rejected for events: the window drops old decisions without a
  warning, and every event pays for the whole history. The ledger keeps them and is queryable.
- **Keep desk and chats apart.** Rejected: two global owners split the view, which is today's problem.

## Consequences

- The human sees fewer, better decisions; routine relays, nudges and green merges stop needing a turn.
- An R1, R3 or R14 mistake acts without the human, from day one (no shadow mode). The 0.95 threshold, the
  code-checked merge conditions and the excluded kinds limit this; the ledger makes every automatic action
  auditable, and disabling a rule stops it at once.
- Old General chats and their sessions are archived; their history stays readable.
