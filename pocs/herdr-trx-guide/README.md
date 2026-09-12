# Herdr to Trellage guide handoff

This proof-of-concept Herdr plugin opens highlighted terminal text, the final
answer, or the filtered conversation from an exactly identified completed
agent as the intent in a modal `trx guide` popup.

**Open current <harness> conversation (9)** shows the number of messages in
the captured conversation. Every `prefix+ctrl+b` opening reads the current
transcript again and refreshes the count and preview. Picker inspection does
not call a model.

It follows the selection flow used by
[Herdr Annotate](https://github.com/plannotator/herdr-annotate): Herdr copies a
mouse selection to the system clipboard, then a compact popup previews the
text and asks what to send. The guide can recommend a profile and workflow,
prepare a prompt, and hand the work to a Herdr workspace or worktree.

## Requirements

- Herdr 0.8.2 or newer
- The repository's pinned Bun runtime
- Python 3
- `mise`
- A local Trellage checkout with a trusted `mise.toml`
- Installed source workspace dependencies
- Docker for Trellage Sandbox capture

This plugin runs `mise run trx -- guide` from the Trellage checkout that
contains this directory. It is a local proof of concept, not a standalone
release package.

## Link the plugin

From the Trellage repository root:

```sh
mise trust
mise install
bash pocs/herdr-trx-guide/prepare.sh
herdr plugin link pocs/herdr-trx-guide --enabled
herdr integration install copilot
herdr integration install codex
herdr integration install claude
```

The Herdr integrations apply only to direct harnesses in their normal default
homes. Trellage Native profiles use separate display-only metadata hooks so
Herdr does not cold-restore a scoped profile as a raw harness.

The explicit preparation step installs the frozen source workspace and then
the plugin's own frozen dependencies. Local package links retain the workspace
layout required by conversation capture. Normal plugin launches never install
dependencies or compile source.
The link registry is private to `node_modules/.trellage-links`; preparation
does not register packages in the user's global Bun installation.

Add these bindings to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+h"
type = "popup"
command = "bun --no-install --no-env-file --config=/dev/null /absolute/path/to/trellage/pocs/herdr-trx-guide/latest-popup.ts"
description = "Open latest agent result in Trellage guide"
width = "90%"
height = "90%"

[[keys.command]]
key = "prefix+ctrl+b"
type = "plugin_action"
command = "trellage.guide-handoff.source-picker"
description = "Open TRX actions"

[[keys.command]]
key = "prefix+ctrl+m"
type = "plugin_action"
command = "trellage.guide-handoff.context-menu"
description = "Open TRX contextual actions for the active agent pane"
```

Reload the Herdr configuration after you save it.

## Use it

To collect highlighted text before opening the guide:

1. Drag to highlight terminal text. Herdr copies it to the clipboard.
2. Press `prefix+ctrl+b`.
3. **Open highlighted text** is selected first. Verify the preview, then press
   `a` to add it to the capture queue. The picker stays open and selects
   **Open capture queue in trx guide (N)** so you can press `Enter` immediately
   if finished.
4. Press `q` or `Esc` when you want to close the picker and collect another
   highlighted section or exact agent result.
5. Press `prefix+ctrl+b` again, move to **Open capture queue in trx guide
   (N)**, and press `Enter`. The full guide opens with every captured item in
   insertion order. The capture queue clears only after the guide popup opens.

When the capture queue is empty, `Enter` still opens the currently selected
source immediately. Use the arrow keys or `j`/`k` to choose highlighted text,
an exact result, a terminal snapshot, the **Rewrite output** action, or the
accumulated queue. Press `a` to queue the selected source or `Enter` to open
it directly.

The **TRX actions** popup opens at 88×20 with the invoking agent, pane, and
project in its header. It shows loading rows immediately, then fills in each
source independently. Ready choices remain usable while other sources load;
Escape closes the picker at any point. Source failures appear beside their rows.
The shortcut freezes the invoking pane context before opening the popup, so a
focus change does not redirect capture. The picker captures the latest completed
harness message from that pane's exact conversation transcript once when it opens.
This includes Copilot task-completion summaries and does not depend on scroll
position. When exact capture is unavailable, the picker can use the latest
complete visible harness or system message. Session identity and transcript
access errors stop capture instead of triggering that fallback.
Choose **Rewrite output** to open
the contextual action popup without recapturing a later pane state. Select
one of the styles below; each choice includes a short description. The popup runs the Copilot SDK,
shows a spinner while it works, renders the returned Markdown, and verifies
the `c` copy action. The larger popup keeps the **Rewrite output** title and
uses 90% of the terminal.

| Style | Use it for |
| --- | --- |
| **TL&DR Rundown** | TL;DR, status checkboxes, blockers, and next choices. First in the list. |
| Ponytail voice | Terse senior prose with the original facts and structure. |
| STE English | ASD-STE100 guidance: plain words and direct sentences. |
| Caveman speech | Short, blunt fragments with technical accuracy. |
| Military | Problem → cause → fix, without a preamble. |
| BLUF | Conclusion first, then reasons and tradeoffs. |
| Reality Check | What works, real risks, and a candid verdict. |
| no-slop | Plain, specific prose without filler or clichés. |
| Humanizer | Remove AI writing tells while keeping voice and meaning. |
| avoid-ai-writing | Audit AI patterns and return the clean rewrite. |
| no-ai-slop | Peter Yang’s editing rules for cutting slop. |
| unslop | Remove stock phrasing and canned transitions. |
| Spartan | The whole answer first, with maximum compression. |
| Attention-kind | Answer first, arrow bullets, and bold words to skim. |
| wait-what | Re-explain plainly with context. |
| ELI15 | One clear analogy, its limits, and a takeaway. |
| ladder | The same answer at ages 5, 15, and professional. |
| analogy-engine | One sustained analogy with an explicit mapping. |
| First Principles | Build an explanation from facts and assumptions. |
| Yoda | Plain technical English with a Yoda-style final line. |

Rundown reads `~/.claude/output-styles/rundown.md` when selected, so local edits
take effect on the next rewrite. If that file is missing or unreadable, the
popup reports the error; it does not silently use another style. The remaining
references ship as Markdown writing guidance with the plugin and require no
network access at popup startup. See [style sources](rewrite-styles/README.md)
for upstream links and attribution. These references do not install skills or
enable their tools, hooks, or workflows. Rewrites apply the selected format to
the captured content without inventing causes, fixes, or status.

The last explicitly selected style is remembered without automatically starting
a rewrite. Successful rewrites are saved privately in plugin state; reopening
an unchanged message and style reuses the saved result without starting Copilot.
The cache retains the latest 100 results without time expiry. Changes to source,
effective instructions, skill contents, model, or effort invalidate the result.
Storage failures appear as a nonblocking status.

| Key | Action |
| --- | --- |
| `o` | Show the immutable original, including during loading or errors. |
| `w` | Show the successful rewrite. |
| `d` | Show a raw Markdown diff, side by side at 80 columns or wider, unified below. |
| `c` | Copy original in Original view; copy rewrite in Rewritten or Diff view. |
| `g` | Regenerate the selected style, bypassing the cache. |
| `r` / `s` | Retry or return to style selection. |
| `PgUp` / `PgDn` | Scroll the current view; each view remembers its position. |

A failed or cancelled regeneration preserves the previous successful rewrite.
Diff columns scroll together and use explicit addition/deletion markers. Copy
feedback refers to the content and view that initiated it; the footer names the
current copy target.

Set `TRELLAGE_GUIDE_REWRITE_CONFIG_JSON` in the Herdr plugin environment to
replace the built-in styles or tune the model. For example:

```sh
export TRELLAGE_GUIDE_REWRITE_CONFIG_JSON='{"model":"gpt-5.6-sol","effort":"medium","styles":[{"id":"plain","title":"Plain English","description":"Short direct sentences.","instruction":"Use short direct sentences and preserve Markdown."},{"id":"my-skill","title":"My skill","description":"Use the local style guide.","skillPath":"/absolute/path/to/style/SKILL.md"}]}'
```

`skillPath` accepts an absolute Markdown file or a directory containing
`SKILL.md`. A configured `styles` array replaces the defaults, so include any
built-in choices you want to keep.

`prefix+ctrl+m` remains an optional direct alias for the contextual action
plugin action. It captures the active pane when invoked and opens the same
Herdr popup. Missing, changed, truncated, or ambiguous pane/message context,
Copilot failures, cancellation, and clipboard failures remain visible in the
popup.

Press `x` on the main source screen to clear the complete capture queue while
keeping the picker open.

To open the latest complete agent response directly:

1. Wait for the focused agent to finish.
2. Press `prefix+shift+h`.

You can also press `prefix+ctrl+b`, select the current filtered conversation,
the latest assistant answer, or an explicit terminal snapshot, then press `Enter`.

### Retained continuation capture internals

The separate analysis action and popup are no longer registered in the
plugin. Use **Open current <harness> conversation (9)** in `prefix+ctrl+b`.
The following describes the retained continuation capture helpers for saved
drafts and internal callers, rather than a source-picker action.

Continuation capture does not require an idle/completed marker. It includes human user
messages and completed user-visible assistant answers; it excludes tools,
reasoning, commentary, internal instructions, and nested-agent traffic. A
pending user turn is not included after the last completed response. Coverage
notices report a partial trailing record, later activity, recorded compaction,
or unavailable attachment contents. Evidence IDs refer to stable source
records, not text equality.

The canonical evidence-ID scheme is
`msg-` plus the full lowercase SHA-256 digest of UTF-8 compact JSON
`[agent, sessionId, role, logicalKey]`. There is no event-type or `answer:`
prefix. Copilot and Codex use the first nonempty string from their message
payload's `messageId`, `message_id`, or `id`, then the enclosing event's
`uuid` or `id`. Claude users use event `uuid`, then message `id`; Claude
answers require a nonblank message `id`. Without a key, use `record:<recordIndex>`.
Keys are not trimmed or normalized. Malformed Unicode in identities or event
data is rejected before hashing; valid Unicode IDs keep their exact values.
Indexes are zero-based physical JSONL
line indexes, including blank lines. A legacy completion marker retains the
content record's index; an assembled Claude answer uses its last
fragment/end-turn record's index.

`test/fixtures/conversation-evidence-ids.json` contains language-neutral
records and exact expected IDs/order. A `null` record in that fixture means a
blank JSONL line, not a JSON `null` value. Both parsers must normalize these
fixtures independently; transporting Python-generated IDs through TypeScript
alone is not an ID-parity test.

The full transcript is read from a bounded, verified prefix. Append-only
growth is allowed; replacement, truncation, a changed prefix, malformed
complete records, links, and ambiguous identity fail closed. Host capture
uses the normal or explicitly configured harness home. Native capture stays
inside the selected profile home. Sandbox capture uses the exact validated
container/invocation bridge and releases its sealed export after reading it.
An old bridge reports that conversation export is unsupported.

### Capture queue editor

Press `e` to edit the capture queue on a separate screen. There, use `j`/`k`
or the arrow keys to select an item, `x` to remove that item, `a` to return to
the source list and add another, `c` to clear the complete queue, and `b` to
return without changing it. Press `Enter` to open the complete queue in `trx
guide`. Press `q` or `Esc` to close the picker from either screen. The queue
clears only after the guide popup opens.

## macOS selection-overlay protocol

The macOS overlay invokes one of two pane-context plugin actions:

- `trellage.guide-handoff.queue-add-selection` adds one selection and returns.
- `trellage.guide-handoff.queue-add-selection-open` adds one selection and
  opens the dedicated `queue-editor` plugin popup without clearing the queue.

Both actions use `overlay-action.ts`. The invocation source must be
`trellage-guide-overlay`. The action context `selected_text` contains only:

```text
trellage-guide-overlay-request:v1:<lowercase UUID>
```

The correlation ID must match the request UUID when it is present. Selected
text is never put in the action context. The matching one-use request is:

```text
~/Library/Application Support/Trellage/TRX Guide Overlay/requests/<uuid>.json
```

Request JSON uses this schema:

```json
{"schemaVersion":1,"requestId":"<uuid>","selection":"...","capturedAt":"<ISO-8601>","source":{"workspaceId":"...","tabId":"...","paneId":"...","cwd":"/absolute/path","agent":"optional","paneTitle":"optional"}}
```

The overlay parent and request directories use mode `0700`. Request files must
be atomic regular files owned by the current user, with mode `0600`, one link,
no symlink, and bounded size. The action unlinks a valid file before it reads
and validates the JSON. It rejects stale requests and removes safe request
files older than 24 hours.

The request workspace, tab, pane, working directory, and optional agent must
agree with `HERDR_PLUGIN_CONTEXT_JSON`. The request UUID becomes the queue item
ID, so retrying the same request is idempotent. Overlay queue items include
optional source metadata; queue files created before this metadata remain
readable.

Queue mutations use `proper-lockfile` with `realpath: false`, bounded retries,
a five-minute stale interval, lock-heartbeat updates, and compromised-lock
failure. The lock stays under the private plugin state directory. Queue JSON
replacement remains atomic and mode `0600`. After the guide pane opens, the
action removes only IDs from the queue snapshot it opened, so captures appended
during pane startup remain queued.

Action stdout is one compact result and never contains captured text:

```json
{"schemaVersion":1,"requestId":"<uuid>","queued":true,"opened":false,"queueCount":1}
```

If add-and-open queues the item but cannot open the queue editor, `queued`
remains `true`, `opened` is `false`, the diagnostic is written only to stderr,
and the action exits nonzero. Queue-editor launch has a 10-second timeout; on
timeout the plugin terminates and reaps only its Herdr CLI child, then reports
the same safe partial result.

If an atomic queue write succeeds but lock release later fails, the action
reads the queue snapshot and correlates the request UUID before reporting
status. A present UUID reports `queued: true`; a readable queue without it can
report `queued: false`. If queue state cannot be read, stdout stays empty so
the overlay treats the result as unresolved. Diagnostics never include the
captured text.

The popup does not offer **Current terminal**. A modal popup is temporary and
is not a safe host for a new agent. It keeps these guide outcomes:

- start the selected profile in the current Herdr workspace;
- create or reopen a Herdr worktree;
- copy the prepared prompt.

The handoff uses the original agent pane as the workspace caller and uses its
working directory for readiness and worktree checks.

## Text sources

The source picker avoids treating unrelated clipboard content as a current
selection. It shows the clipboard text before you choose it.

- **Open highlighted text** uses Herdr's copied mouse selection. It works for
  any terminal pane and does not require a completed agent.
- **Current agent conversation** uses the exact direct or Trellage Native
  session transcript. It includes human user messages and completed assistant
  responses, while excluding system/developer instructions, tool calls,
  reasoning, commentary, nested-agent traffic, and duplicate records. Recent
  messages are retained when the complete history exceeds the guide limit.
- **Open latest <harness> answer** uses the most recent completed assistant
  answer from an exactly identified Copilot, Codex, or Claude session.
- **Terminal snapshot** explicitly uses Herdr `agent.read` output with the
  `recent_unwrapped` source. It is a screen snapshot, not an exact semantic
  final-message source.

If the focused pane is a shell, the picker
lists eligible agents in the same tab, then the same workspace. It never
silently chooses between multiple completed agents.

Herdr's default `[ui] copy_on_select = true` setting is required for the drag
selection flow. If you set it to `false`, copy the retained selection before
opening the picker. A remote Herdr server cannot read a local client
clipboard.

Structured exact identity can come from:

1. Herdr's exact `agent_session` reference.
2. An exact session ID in the focused harness process arguments.
3. A Trellage Native session ID reported by that profile's SessionStart hook.
4. A Trellage Sandbox attachment ID mapped to the main session inside its
   private state volume.

If independent exact sources disagree, capture fails instead of choosing one.

Direct and Native transcript search is limited to the exact reported session
under the normal harness home or selected Native profile home under
`~/.local/share/trellage/profiles/`. It does not search arbitrary filesystem
roots or select a transcript by working directory or modification time.
Transcript files must be regular files, not symlinks.

Sandbox capture does not expose the Herdr socket or mount the container state
volume on the host. Each attachment gets a random invocation ID. The
container's SessionStart hook atomically maps that ID to its main session. A
fixed `trellage session final-message` command then validates the exact
container, profile, worktree, image, state volume, agent, mapping, and
transcript before it returns the final message. Copilot nested-agent records
and Claude subagent sessions are excluded.

**Open current conversation** supports direct and Native transcripts.
Sandbox panes can use exact final-message capture through the
`session final-message` protocol.

## Completion tracking for legacy result shortcuts

Herdr changes a completed pane from `done` to `idle` after you focus it. The
plugin records a small marker when it sees the preceding `done` event. The
marker contains only the pane ID, agent name, state sequence, and completion
time.

The plugin clears the marker when the agent starts working again or when the
pane closes. It rejects an idle pane if the marker does not match the current
agent state.

The plugin must be enabled before the agent finishes so it can observe this
event. A pane that finished before the plugin was linked can require one more
agent turn before the shortcut is available.

## Limits and fallback behavior

- Ordinary guide intents and copied captures retain the 60,000-character
  limit. Their legacy conversation excerpt behavior is unchanged.
- Next-steps capture does not use the 8 MiB tail reader or the 60,000-character
  formatter. Its validated policy is `lib/conversation-policy.json`: 64 MiB
  source bytes, 16 MiB per source record, 250,000 records, 100,000 normalized
  messages, 4 MiB per visible message, 32 MiB total visible text, and 64 MiB
  per private request. A limit failure is explicit; it never drops the start
  of the conversation to fit. Sandbox export also enforces its bridge limits.
- Markdown line breaks are preserved.
- The plugin does not silently shorten an answer.
- If Herdr reports a truncated terminal snapshot, the plugin stops. Highlight
  the required text and use **Open highlighted text** instead.
- Unsupported harnesses can use selected text or an explicitly selected
  terminal snapshot.
- Missing, conflicting, or ambiguous exact identity opens the source picker.
  The plugin never changes to terminal capture without a user choice.

## Local state and privacy

Source-picker choices and captured answers move through separate one-use JSON
files under `HERDR_PLUGIN_STATE_DIR`. Herdr action context contains only a
short opaque choice token, not the selected text or source identity.

The macOS selection overlay uses its separate Application Support request path
described above. Its action result and diagnostics contain request state only,
never selected text.

- Answer-bearing state subdirectories use mode `0700`.
- Choice and invocation files use mode `0600`.
- Each file is written atomically.
- The action deletes the choice file after reading it.
- The popup deletes the invocation file before it starts `trx guide`.
- The popup writes the answer to a separate mode-`0600` file under the
  mode-`0700` `guide-intents` directory.
- The launcher rejects links, wrong ownership, permissive modes, invalid
  paths, and oversized files. It unlinks a valid intent file before reading
  it.
- Popup termination removes an unconsumed intent, and the next invocation
  removes valid intent files older than 24 hours after an unavoidable crash.
- Completion markers do not contain answer text.
- Native hooks report only short identity tokens through display-only Herdr
  metadata. They do not report a restorable `agent_session`.
- Sandbox mappings stay mode `0600` inside the profile's private state volume.
  Only the random invocation ID enters that attachment's container
  environment.
- The opaque token crosses Herdr's standard `selected_text` action-context
  field.
- The Herdr socket and host harness homes are never mounted into a Sandbox
  container.

The final answer is not exposed in the process argument list or environment.
Only the private one-use file path enters the guide environment. Standard
input remains attached to the Herdr popup terminal so the Ink guide receives
every key normally. The guide's existing model provider behavior starts after
the launcher consumes the file.

### Retained continuation requests

`conversation-action.ts` stages the shared `ConversationSnapshot` only after
explicit selection. Requests use opaque UUID names:

```text
HERDR_PLUGIN_STATE_DIR/continuations/choices/<uuid>.json
HERDR_PLUGIN_STATE_DIR/continuations/requests/<uuid>.json
```

All continuation directories must be owned, real, mode-`0700` directories.
Files must be owned mode-`0600` regular files with one link. Writes are atomic
and locked. Unsafe paths and permissions are rejected, not repaired. The
shared validator and runtime enums come from the source exports of
`@trellage/guide-core`. Production capture lives in
`@trellage/conversation-source`; the plugin delegates to that package.
Bun runs the TypeScript directly, including its enums.

The former `analyze-conversation` action and `conversation` plugin pane are
unregistered. The retained `conversation-popup.ts` adapter starts:

```sh
mise run --raw trx -- guide --next-steps
```

`TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE`, `HERDR_PLUGIN_STATE_DIR`, and the
validated `TRELLAGE_GUIDE_HERDR_CONTEXT_JSON` popup metadata carry the
conversation handoff. `TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT` points to the
trusted checkout resolved from the configured plugin location, overriding any
inherited value. This lets installed `trx` profile guides use the real source
helper even when their parent directory has no `pocs` tree. The helper root
does not come from conversation text, model output, or the source working
directory. The popup context contains only `schemaVersion`, `surface`,
`workspaceId`, `paneId`, and `cwd`; canonical source/capture metadata stays in
the private snapshot. Transcript text is not placed in arguments, environment
variables, notifications, or diagnostics. Legacy inline context/intent
carriers are removed from the guide child's environment. The popup retains
the request; the guide owns durable draft creation and request
acknowledgment. A popup-open result is not proof of analysis or job launch.

The root helper rechecks the original exact pane without changing the
current focus:

```sh
bun --no-install --no-env-file --config=/dev/null pocs/herdr-trx-guide/conversation-source.ts --check /private/request.json
```

It accepts only an owned `continuations/requests/<UUID>.json` file under
`HERDR_PLUGIN_STATE_DIR` and returns only
`{"sameSource":true,"revision":"<sha256>","advanced":false}` plus an optional
safe message. `--refresh PATH` captures that same source again and returns
only `{"requestPath":"/private/new-request.json"}`. Neither command consumes
the old request. Saved snapshots stay embedded in durable drafts. The caller
must stage a private request copy before checking or refreshing a saved draft;
standalone snapshot paths and draft files are not transport inputs.

Both source operations accept cancellation from the parent runner. On
`SIGTERM`, `SIGINT`, or `SIGHUP`, the CLI aborts pending capture and Herdr
socket requests, permits the Sandbox adapter to release any known sealed
snapshot, and exits without output. The adapter receives the same
`AbortSignal` for its owned page subprocesses. Existing request and draft
files are preserved. Forced termination such as `SIGKILL` cannot run cleanup;
the bridge's bounded stale-export cleanup remains the fallback. The parent
runner retains its 60-second initial source-check limit.

The source key binds the server socket instance, workspace/tab/pane, surface,
harness, exact session, working directory, and applicable profile/container/
invocation. Changing agent status sequences does not invalidate a still-running
session. New human input and completed assistant answers change the revision.
Pending human input changes it even if the completed-response cutoff is
unchanged. Tool-only appends do not count as a new completed conversation. A
different source or rewritten captured history blocks handoff instead of
choosing another source.

## Troubleshooting

**The shortcut does nothing**

Check the configuration and reload the running server:

```sh
herdr config check
herdr server reload-config
```

Then confirm that `herdr status --json` reports a compatible 0.8.2 client and
server with `restart_needed` set to `false`.

The one-step latest-result shortcut keeps capture failures open in its popup
and shows the reason. Press any key to dismiss the warning. Use the source
picker when you want a terminal snapshot or highlighted-text fallback.

**The plugin says the result is not recorded as completed**

The plugin did not observe a matching `done` event. Confirm that it is enabled,
then finish one more turn in that pane.

**The highlighted text is missing or incorrect**

Confirm that `[ui] copy_on_select` is not set to `false`. Drag over the text
again before opening the picker. The picker shows the exact clipboard text
that it will send. Highlighted text appears first so `a` can queue it
immediately; always verify the preview before adding it.

**The plugin says the terminal output is truncated**

Highlight the required text, open the source picker, and choose
**Open highlighted text**.

**The popup reports that the Trellage checkout is not trusted**

Run `mise trust` from this Trellage worktree.

**The guide opens but does not accept keys**

Install the current source workspace dependencies and reload Herdr:

```sh
bash prepare.sh
herdr server reload-config
```

The current plugin keeps popup stdin attached to the terminal. An older version
that combines piped intent input with a separately opened `/dev/tty` can
display the guide without receiving normal popup keys.

**The plugin cannot offer an exact result**

Herdr did not provide an exact session reference, the harness process did not
contain one, the Native hook did not report metadata, the Sandbox bridge was
not available in the current image, or exact identity was conflicting. Choose
the clearly marked terminal snapshot only if its preview contains the full
result, or highlight the required text.

For Native profiles, reinstall the current launchers and run setup or repair
for the profile. Existing sessions must start a new turn after the hook is
installed. For Sandbox profiles, rebuild the image so it contains the session
bridge, then start a new attachment. Herdr metadata tokens are intentionally
ephemeral across a full Herdr server restart.

Inspect plugin command failures with:

```sh
herdr plugin log list --plugin trellage.guide-handoff
```

## Development checks

```sh
bun run --cwd pocs/herdr-trx-guide test
bun run --cwd pocs/herdr-trx-guide check
bun run --cwd packages/trellage-conversation-source test
bun run --cwd packages/trellage-conversation-source check
python3 tests/trellage_session_bridge_test.py
bun run --cwd packages/trellage-launcher test
bun run --cwd packages/trellage-launcher check
mise run trx-guide-test
make native-copilot-profiles native-claude-profile
make native-codex-auth-config-launch native-codex-installation native-codex-pstack
bash prototypes/trellage/tests/host_command_contract.sh
```

Unlink the local plugin with:

```sh
herdr plugin unlink trellage.guide-handoff
```
