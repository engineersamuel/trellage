# Conversation next steps

Status: implemented; see the operating and validation notes below.

## Purpose

Analyze the focused harness conversation and recommend five distinct, ranked
next actions informed by available Trellage profiles. A next action is not
necessarily unfinished work: completed work or an existing plan can benefit
from visualization, explanation, a second opinion, or independent review.

The model chooses the mix without fixed action categories. It must distinguish
required follow-up from optional exploration, recognize when no further work is
needed, and request clarification rather than invent unsupported actions.

## Entry point and source

- Add **Analyze conversation for next steps** to `prefix+ctrl+b`.
- Leave TRX Guide Overlay and the latest-result shortcut unchanged.
- Bind the source to the pane focused when the popup opens.
- Use only that pane's exactly identified conversation. Do not offer another
  pane picker or fall back to another agent, recent session, working-directory
  match, or terminal snapshot.
- Explain missing, unsupported, or conflicting session identity.
- Initial coverage includes Copilot, Codex, and Claude on the host, through
  Trellage Native, and through Trellage Sandbox.
- Reuse exact-session identification where available. Sandbox requires a
  container-side conversation export, not host access to private container
  state.

## Conversation snapshot

Include human user messages and completed, user-visible assistant answers.
Exclude system/developer instructions, reasoning, tool calls and results, and
nested-agent traffic. Treat transcript content as evidence, not instructions
that override the analyzer.

An active harness may be analyzed without interruption. Capture through the
last completed assistant response, exclude partial responses, and display the
cutoff. A later launch must warn if the source conversation has advanced.

Use the complete filtered conversation when it fits. For longer conversations,
summarize older sections while retaining original goals, decisions, corrections,
and unresolved questions; keep recent messages verbatim. Disclose summarization
and the cutoff. Never present an incomplete excerpt as the full conversation.

## Continuation assessment

Show:

- Current goal.
- Reported progress, explicitly distinguished from independently verified work.
- Unresolved work and blockers.
- Five distinct, ranked next actions when supported by the evidence.

Each action explains why it is useful now, its expected result, and its
supporting conversation evidence. The assessment sees profile descriptions and
capabilities before generating recommendations. It must not invent profiles or
capabilities and must distinguish a suitable profile from one ready to launch.

The initial assessment uses only the filtered conversation and profile catalog.
It does not inspect repository files or run verification commands. It may
recommend those activities as actions for the user to select.

## Model execution

Use the existing guide model settings, show the selected model before analysis,
and allow an override. Start inference only when the user explicitly chooses
analysis, not merely when the source picker opens.

Analysis is cancellable. Disclose additional summarization calls when required
for long conversations.

## Selection and handoff

The flow is:

```text
Focused conversation
  -> snapshot
  -> continuation assessment
  -> five ranked actions
  -> select and edit actions
  -> existing guide profile/workflow/prompt refinement
  -> explicit launch
```

The user can select, edit, and queue any subset of the actions. Nothing launches
automatically.

Each selected action gets an editable brief containing its goal, relevant
decisions and evidence, constraints, expected output, and requested action.
Do not include the entire conversation by default. The complete outgoing prompt
must be inspectable before launch.

Independent actions may run in parallel. Default concurrent code-changing
actions to separate worktrees; reviews may share read-only access. Show
destinations and require an explicit choice for shared writable state.

Dependent actions show their prerequisites and remain waiting rather than
starting prematurely. Automatic dependency scheduling is outside the first
version.

## Drafts and recovery

Keep a private local draft tied to the source snapshot. Closing the popup or a
failed launch must not lose the assessment, edits, or queued actions.

Reopening offers **Resume assessment** or **Analyze latest conversation** within
the focused source's context. Provide explicit discard.

Do not remove queued actions merely because a popup opened. Preserve them on
failure.

## Using the feature

Open `prefix+ctrl+b` while the source conversation is focused, then choose
**Analyze conversation for next steps**. Check the source, cutoff, coverage,
model, effort, and call estimate before choosing Analyze. Opening the picker,
review screen, or an existing assessment makes no inference calls.

Select the useful actions and edit each action's brief, profile, and workflow.
Preparation generates and optimizes three prompt choices for that action.
Choose a candidate explicitly, inspect its complete prompt, and edit it if
needed. Candidate commands are not restored from disk; the launcher constructs
commands from the current catalog.

The screen shows its available keys. Destination controls include explicit
prerequisite, shared-writable, and committed-only worktree confirmations.
A new worktree does not contain uncommitted source changes. No files are
automatically copied, committed, or stashed.

The initial release conservatively treats every chosen launcher as writable.
A model's "read-only" label does not establish a permission boundary. Use a
new worktree, or explicitly confirm shared writable access.

Launch is a separate confirmation. "Launched" means prompt delivery was
acknowledged, not that the resulting task is complete. If delivery is unknown,
inspect the recorded destination before taking further action. The guide
does not resend unknown attempts or automatically run dependent actions.

## Storage, transport, and installation

Continuation state is separate from the copied-text queue and the ordinary
repository `.trx-guide` cache. It lives beneath
`HERDR_PLUGIN_STATE_DIR/continuations`, with `0700` directories and `0600`
files. Unsafe paths fail instead of being repaired. Draft saves use revision
checks and a process lock. Successful history summaries are saved before the
next model call, including when a later call is cancelled.

The plugin passes only a private request filename to `trx guide --next-steps`.
The outgoing action prompt is delivered through the owned Herdr Unix socket,
not shell arguments. This mode requires the popup context and is not a
standalone JSON/stdin guide mode.

Rebuild `packages/trellage-guide-core` and the tracked launcher bundle after
source changes. The linked plugin uses its checkout directly; the installed
router must include `--next-steps` forwarding. Keep that checkout available
while the shortcut commands point to it.

Sandbox conversation export uses `trellage session export-conversation`,
`describe-conversation`, and `release-conversation`, through the same exact
container validation as final-message export. The compiler copies the bridge
into profile images. Rebuild an older profile image and start a new container
to use the new export commands; re-attaching to an old container alone does not
update its bridge. Unsupported containers fail explicitly rather than use
terminal text or another conversation. Existing sessions are not rebuilt or
interrupted automatically.

## Limits and verification

Capture and analysis have separate limits. Host/Native capture allows a
64 MiB raw source and 32 MiB filtered text. The analysis policy permits up to
32 MiB, 20,000 messages, 24 older-history chunks, and 64 model calls, including
bounded repairs. Exceeding a limit stops with an error; it does not silently
discard the beginning of the conversation. The review screen displays the
actual call plan before inference.

Synthetic tests cover the nine harness/surface combinations, source changes,
completed-turn filtering, paging, private storage, cancellation, prompt
choices, source-bound recovery, and launch isolation. Run the POC tests,
guide-core and launcher suites, Python bridge contracts, and
`mise run trx-guide-test` after changes. Live model calls are not part of
these checks.
