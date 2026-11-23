# ADR 0009: The factory takes work from a todo app (TickTick first)

## Status

Proposed (2026-11-21). Owner answers: the coordinator code (not an agent) talks to TickTick; the UI is a new **Todo**
view, so later todo apps can join it; all TickTick lists show; one task gives one draft; the owner picks the repo each
time; the task gets the `factory` tag and a comment with the thread link; TickTick gets status comments only; the task
is completed when the PR is merged; a discarded draft or a PR closed without merge removes the tag and adds a comment.
Automation (the factory picks tasks itself) is out of scope; the human chooses every task.

## Context

The owner keeps work items in TickTick. Today the owner copies a task by hand into a factory draft, and the task does
not show that the factory has it or that the work is done.

TickTick has an official MCP server. A spike on 2026-11-21 (script outside the repo) found:

| Item | Result |
|---|---|
| Endpoint | `https://mcp.ticktick.com/`, Streamable HTTP, Bearer token |
| OAuth | Discovery at `/.well-known/oauth-protected-resource` → `https://ticktick.com/`. Dynamic client registration (`https://api.ticktick.com/oauth/register`), public client (`token_endpoint_auth_method: none`), PKCE S256, scopes `tasks:read tasks:write`. No developer app is needed. |
| Token | `expires_in` 15 551 999 s (180 days). **No refresh token.** |
| Read | `list_projects` (14 lists), `get_project_with_undone_tasks`, `get_task_by_id`, `get_comment`. Task fields: `title`, `content`, `desc`, `items` (checklist), `tags`, `priority`, `dueDate`, `etag`, `status`. |
| Write | `update_task` with `tags` **replaces** the full tag list (`[]` gives `null`). `add_comment`: plain text, max 1024 characters. `complete_task` sets `status` 2; `update_task {status: 0}` opens the task again. |
| Result shape | Use `structuredContent`; `content` has one text item per object. |

The factory already has the parts it needs: drafts (`POST /api/drafts {folderId, prompt}`, run, discard in
`src/drafts.ts`), and a 2-minute PR sweep over every open repo thread (`prSweep`, `src/cos.ts` `prState`) that knows
`merged` and `closed`. A `Thread` has no field for an outside source today.

## Decision

### One `TodoSource` interface; TickTick is the first

`src/todo/` holds an Effect service `TodoSource` with: `lists`, `tasks(listId)`, `task(id)` (with comments),
`claim(task, threadUrl)`, `note(task, text)`, `release(task, reason)`, `complete(task)`. `src/todo/ticktick.ts`
implements it with `@modelcontextprotocol/sdk` as an MCP client in the coordinator. No worker gets TickTick tools, so
no agent can change a task.

### Auth

- `GET /api/todo/ticktick/connect` registers a client (once; the client id is kept), starts PKCE, and sends the browser
  to TickTick. `GET /api/todo/ticktick/callback` swaps the code for the token.
- The client id, token and expiry are one JSON value in the OS credential store through `Bun.secrets` (service
  `trellage.factory`, name `ticktick`): the macOS Keychain, libsecret on Linux. The token is encrypted at rest, is not
  in a plain file that backups or dotfile syncs copy, and never goes on a command line (`security -w` would show it in
  `ps`). Never in config, logs, events or the UI model. Checked on 2026-11-21: Bun 1.4.4 `Bun.secrets` set, get and
  delete work with no Keychain prompt.
- Fallback when `Bun.secrets` fails (no credential store, for example in a container):
  `~/.config/trellage/factory/ticktick.json` (`$XDG_CONFIG_HOME` if set), file mode 0600, folder 0700, tmp file plus
  rename. The Todo view says which store is in use. Not the default: the token is plain text on disk.
- No refresh token: the Todo view shows the expiry date, warns 14 days before, and shows **Reconnect** when a call
  returns 401.

### Link a thread to a task

`Thread` gets `todo?: { source: "ticktick"; listId: string; taskId: string; title: string; state: "claimed" |
"completed" | "released" }`. The Todo view reads it to show a badge on tasks the factory has.

### Lifecycle

| Event | TickTick action |
|---|---|
| **Draft** from the Todo view | Create the draft (prompt below), then `claim`: add `factory` to the existing tags, and comment `🏭 Factory draft: <SF_UI_URL>?thread=<id>` |
| Draft **Run** | comment `🏭 Factory started work.` |
| PR opened (first seen by `prSweep`) | comment `🏭 PR: <url>` |
| PR **merged** | comment `🏭 Merged: <url>`, then `complete_task`; `state: completed` |
| Draft **discarded**, or PR **closed** without merge | remove `factory` from the tags, comment `🏭 Factory stopped: <reason>`; `state: released` |

- Tag changes read the task first, change only `factory`, and send the `etag`. On an etag conflict: read again, try once
  more.
- A TickTick failure never blocks the factory: the draft, run and merge go on. The failure is logged, shown on the
  thread as a warning, and tried again on the next `prSweep` (the action is idempotent from `todo.state`).
- `prEvent` today emits no event for `closed`; this ADR adds `closed`.

### Draft prompt

```text
<title>

<content or desc>

Checklist:
- [ ] <item>            (done items as [x])

Comments:
- <comment>             (factory comments, which start with 🏭, are left out)

Source: TickTick · list <name> · tags <tags> · priority <none|low|medium|high> · due <date>
```

The prompt is plain draft text; enhance, research and the other draft actions work on it as they do today.

## Consequences

- One click takes a task into the factory, and the task in TickTick shows the state of the work.
- Every owner TickTick list is visible in the Factory UI (owner choice). The data passes only between the coordinator
  and TickTick; tasks reach a model only when the owner makes a draft.
- A second todo app adds one `TodoSource` implementation and its auth routes; the view and lifecycle stay.
- The owner must log in again every 180 days.
- The comment link points to `localhost` and works only on the machine that runs the factory.

## Alternatives rejected

- **TickTick MCP tools for an agent**: flexible, but an agent could change tasks the owner did not choose.
- **TickTick Open API (REST)**: needs a registered developer app with a secret; MCP gives the same data without one.
- **Move the task to a "Factory" list**: loses the original list. **Title prefix**: changes the owner's text.
