# Plan 005: Take factory work from TickTick (Todo view)

Status: TODO (draft for review). Priority P2. Effort M.
Risk MEDIUM (OAuth token storage; writes to the owner's TickTick account).
Depends on: [ADR 0009](../docs/adr/0009-factory-todo-sources.md).

## Goal

The owner browses TickTick lists and tasks in a new Factory UI **Todo** view, takes one task into a draft for a repo
they pick, and the factory keeps the TickTick task in step: tagged and commented when taken, completed on merge,
released on discard or a PR closed without merge.

## Changes

All paths are under `prototypes/software-factory/`.

1. **Dependency**: add `@modelcontextprotocol/sdk` (exact version) to `coordinator/package.json`.
2. **`coordinator/src/todo/source.ts`**: the `TodoSource` Effect service and its Schemas (`TodoList`, `TodoTask`,
   `TodoComment`), and `draftPrompt(task, list, comments)` (format in the ADR).
3. **`coordinator/src/todo/ticktick-auth.ts`**: dynamic registration, PKCE, code swap; the store is one
   `Bun.secrets` item (service `trellage.factory`, name `ticktick`, JSON `{clientId, accessToken, expiresAt}`), behind
   a small `TokenStore` service so tests use an in-memory store; when `Bun.secrets` throws, the file fallback
   `~/.config/trellage/factory/ticktick.json` (0600, folder 0700, tmp plus rename);
   `status()` → `disconnected | connected(expiresAt) | expired`; Disconnect deletes the item.
4. **`coordinator/src/todo/ticktick.ts`**: the MCP client (`StreamableHTTPClientTransport`, Bearer header), decode
   `structuredContent` with Schema; 401 → `TodoAuthError`. `claim` / `release` read the task, change only the
   `factory` tag, send the `etag`, retry once on a conflict.
5. **`coordinator/src/threads.ts`**: `Thread.todo` (ADR shape) and a setter.
6. **`coordinator/src/drafts.ts` + `main.ts`**: `POST /api/drafts` takes an optional `todo: {source, listId,
   taskId}`. The coordinator fetches the task, builds the prompt, creates the draft, then claims. `run` and `remove`
   call the lifecycle hooks.
7. **`coordinator/src/cos.ts` + `main.ts` `prSweep`**: emit `closed`; on `pr-opened` (first seen), `merged`, and
   `closed`, call the lifecycle for threads with `todo`. Retry a failed TickTick action on the next sweep.
8. **Routes** (`main.ts`): `GET /api/todo/status`, `GET /api/todo/ticktick/connect`, `GET /api/todo/ticktick/callback`,
   `GET /api/todo/lists`, `GET /api/todo/lists/:id/tasks`, `GET /api/todo/tasks/:id` (with comments).
   `/api/todo/lists/:id/tasks` marks each task with the thread id that has it.
9. **Config** (`config.ts` schema + `defaults/config.toml`): `[todo] enabled = true`, `tag = "factory"`.
10. **Foldkit UI** (`web-foldkit/src/todo/`, same layout as `goals/`): navbar **Todo** button; the view shows
    Connect/Reconnect and the token expiry; lists on the left, tasks on the right (title, due, priority, tags, a
    badge with a link when a thread has it); a task panel with the draft prompt preview, a repo picker (`/api/folders`)
    and **Draft**, which opens the new draft in the Inbox.
11. **Docs**: README section "Todo sources"; `plans/README.md` row.

## Tests

- `draftPrompt`: title only; content plus checklist (done and open); factory comments left out; metadata line.
- Tag edit: keeps the owner's other tags; `[]` / `null` handling; etag conflict retries once, then reports.
- Lifecycle: draft → claim; discard → release; `merged` → complete; `closed` → release; a TickTick failure does not
  block the draft and is retried on the next sweep; a second sweep does not post a second comment.
- Auth store: in-memory `TokenStore` in tests; the fallback file is used when the secrets call throws, mode 0600;
  the token is not in `/api/todo/status` or logs; 401 gives `expired`.
- A fake MCP server (in-process) for all of the above; no test calls TickTick.

## Acceptance

- AC-1: Connect in the Todo view completes OAuth; the view lists the owner's TickTick lists.
- AC-2: Draft on a task makes a draft whose prompt holds title, description, checklist, comments, metadata; the task
  gets the `factory` tag (other tags kept) and a comment with the thread link.
- AC-3: Merge of the PR completes the task and adds a comment with the PR URL.
- AC-4: Discard, or a PR closed without merge, removes only the `factory` tag and adds a comment with the reason.
- AC-5: With TickTick down or the token expired, drafts, runs and merges still work; the view shows Reconnect.
- AC-6: `make factory-test` passes.

## Manual check

Use the task `factory-spike-test` in the list `🇺🇸Microsoft` for AC-1 to AC-4.

## STOP conditions

- The MCP server rejects the registered client or changes its tool names: stop and report.
- A change would let a worker or agent call TickTick: stop; ADR 0009 forbids it.

## Out of scope

Automatic task pick, write back of the enhanced prompt or research, more than one task per draft, a second todo app.
