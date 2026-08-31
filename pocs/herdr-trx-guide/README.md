# Herdr to Trellage guide handoff

This proof-of-concept Herdr plugin opens highlighted terminal text or the final
answer from the focused, completed agent as the intent in a modal `trx guide`
popup.

It follows the selection flow used by
[Herdr Annotate](https://github.com/plannotator/herdr-annotate): Herdr copies a
mouse selection to the system clipboard, then a compact popup previews the
text and asks what to send. The guide can recommend a profile and workflow,
prepare a prompt, and hand the work to a Herdr workspace or worktree.

## Requirements

- Herdr 0.8.2 or newer
- Node.js 22 or newer
- Python 3
- `mise`
- A local Trellage checkout with a trusted `mise.toml`
- Docker for Trellage Sandbox capture

This plugin runs `mise run trx -- guide` from the Trellage checkout that
contains this directory. It is a local proof of concept, not a standalone
release package.

## Link the plugin

From the Trellage repository root:

```sh
mise trust
npm run build --prefix packages/trellage-launcher
herdr plugin link pocs/herdr-trx-guide --enabled
herdr integration install copilot
herdr integration install codex
herdr integration install claude
```

The Herdr integrations apply only to direct harnesses in their normal default
homes. Trellage Native profiles use separate display-only metadata hooks so
Herdr does not cold-restore a scoped profile as a raw harness.

Add these bindings to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+h"
type = "popup"
command = "node /absolute/path/to/trellage/pocs/herdr-trx-guide/latest-popup.mjs"
description = "Open latest agent result in Trellage guide"
width = "90%"
height = "90%"

[[keys.command]]
key = "prefix+shift+b"
type = "popup"
command = "node /absolute/path/to/trellage/pocs/herdr-trx-guide/custom-popup.mjs"
description = "Choose highlighted text or latest agent result for Trellage guide"
width = 88
height = 20
```

Reload the Herdr configuration after you save it.

## Use it

To collect highlighted text before opening the guide:

1. Drag to highlight terminal text. Herdr copies it to the clipboard.
2. Press `prefix+shift+b`.
3. **Open highlighted text** is selected first. Verify the preview, then press
   `a` to add it to the capture queue. The picker stays open and selects
   **Open capture queue in trx guide (N)** so you can press `Enter` immediately
   if finished.
4. Press `q` or `Esc` when you want to close the picker and collect another
   highlighted section or exact agent result.
5. Press `prefix+shift+b` again, move to **Open capture queue in trx guide
   (N)**, and press `Enter`. The full guide opens with every captured item in
   insertion order. The capture queue clears only after the guide popup opens.

When the capture queue is empty, `Enter` still opens the currently selected
source immediately. Use the arrow keys or `j`/`k` to choose highlighted text,
an exact result, a terminal snapshot, or the accumulated queue. Press `a` to
queue the selected source or `Enter` to open it directly.

Press `x` on the main source screen to clear the complete capture queue while
keeping the picker open.

To open the latest complete agent response directly:

1. Wait for the focused agent to finish.
2. Press `prefix+shift+h`.

You can also press `prefix+shift+b`, select an exact agent result or an
explicit terminal snapshot, then press `Enter`.

Press `e` to edit the capture queue on a separate screen. There, use `j`/`k`
or the arrow keys to select an item, `x` to remove that item, `a` to return to
the source list and add another, and `b` to return without changing it. Press
`q` or `Esc` to close the picker from either screen.

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
- **Exact agent result** uses a structured final answer from a safely
  identified Copilot, Codex, or Claude session.
- **Terminal snapshot** explicitly uses Herdr `agent.read` output with the
  `recent_unwrapped` source. It is a screen snapshot, not an exact semantic
  final-message source.

If the focused pane is a shell, the picker lists eligible agents in the same
tab, then the same workspace. It never silently chooses between multiple
completed agents.

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

## Completion tracking

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

- The guide intent limit is 60,000 characters.
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

Rebuild the launcher and reload Herdr:

```sh
npm run build --prefix packages/trellage-launcher
herdr server reload-config
```

The current plugin keeps popup stdin attached to the terminal. An older build
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
node --test pocs/herdr-trx-guide/test/*.test.mjs
python3 tests/trellage_session_bridge_test.py
npm test --prefix packages/trellage-launcher
npm run check --prefix packages/trellage-launcher
npm run build --prefix packages/trellage-launcher
make native-copilot-profiles native-claude-profile
make native-codex-auth-config-launch native-codex-installation native-codex-pstack
bash prototypes/trellage/tests/host_command_contract.sh
```

Unlink the local plugin with:

```sh
herdr plugin unlink trellage.guide-handoff
```
