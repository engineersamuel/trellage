# Guide an existing customer engagement

Run these commands from the engagement's Git worktree:

```sh
trx guide --engagement
trx guide --engagement --intent "What's the next step in this engagement"
trx guide --engagement --intent "Prepare the next customer workshop"
```

The first command defaults to the next-step question. The intent is a question
about the engagement, not a prompt to optimize. No folder migration is required.
Ordinary Guide, its pinned lenses, and its JSON service are unchanged.

## One reviewed action at a time

1. **Select evidence.** Opening the view reads local file names and saved work,
   not a model. Use arrows and Space to select files, `e` to read a file, `+` to
   add a repository-relative path, `i` to change the question, and `c` to add
   context or correct the understanding.
2. **Allow model use.** Press `a` to capture the selected files locally. Review
   the model, source paths, byte counts, tracking state, and additional context.
   Press `s` to send that snapshot for assessment. Press Escape to cancel.
   Prompt Master is not prepared for this mode.
3. **Review the next action.** Guide separates documented statements, inferences,
   unknowns, and conflicts. It shows one recommended action, its reason,
   expected result, source lines, and reviewer role. It can suggest alternatives,
   human work, waiting, or no further action. If an answer materially changes the
   recommendation, it asks one question. Use `c` to answer or correct context,
   then confirm a new assessment. Use `e` to read the supplied evidence.
4. **Prepare one assignment.** Choose an action with `1`, `2`, or `3`, then press
   `p`. This saves the assignment and a full copy of the selected evidence under
   `engagement/work/`. It does not launch anything. There is no three-prompt
   comparison. The selected HVE workflow retains its authored instructions.
5. **Confirm execution separately.** For agent-supported work, press `l` to
   inspect the executable and argument vector. Press `y` to launch in the
   current terminal and current worktree. Readiness and source freshness are
   checked again before the interactive agent starts. Human-only actions have
   no agent launch.
6. **Review the actual result.** When the execution attempt ends, Guide returns
   to result review. Use `v` to read an output file and `n` to write a review.
   Include output paths, observations, unresolved questions, and the human
   decisions still needed. Press `s` to record the result or `x` to reject it.
   Neither choice grants customer signoff. Recording a review also writes its
   Markdown note. Use `e` to reload sources for the next assessment; if note
   publication failed, this retries only that local export.

Use Page Up/Page Down to read long text, Escape to return, and Ctrl+C to exit
after pending work is cleaned up. Editors accept multiline paste; shortcuts
remain text inside editors. `w` on the source screen reopens saved work,
including work from an earlier Guide session.

## Keep knowledge in its current location

Without a source map, Guide lists Git-tracked and unignored Markdown, MDX, text,
and YAML documents. It excludes common generated, dependency, instruction-adapter,
and skill directories. It also inspects the canonical HVE DT and MVE artifact
directories, including ignored files:

```text
.copilot-tracking/dt/<project>/coaching-state.md
.copilot-tracking/mve/<date>/<experiment>/
```

The initial selection prefers `docs/engagement/`, HVE artifacts, and recorded
Guide review notes. If none exist, it selects a root `README.md`, when present.
Selection is visible and can be changed before any model call. Discovery is
not an assertion that these files contain the whole engagement.

For an existing repository, optionally create `engagement/guide.json`:

```json
{
  "schemaVersion": 1,
  "sources": [
    "docs/customer-notes/current-engagement.md",
    "docs/decisions/workshop-scope.md",
    ".copilot-tracking/dt/onboarding/coaching-state.md"
  ]
}
```

Paths identify existing UTF-8 text files, not globs. This map selects sources;
it does not store engagement status. Recorded Guide review notes are added to
the visible selection. Use this map if default discovery is too broad. No
application code, instructions, evidence, or historical documents are moved.
New Guide directories are lowercase.

HVE owns its method state and artifact registry. Guide reads that state as
reported evidence; it does not rewrite the HVE schema or declare a method
complete. Keep relevant HVE artifacts under version control when the engagement
must be reproducible from a clone. Guide does not stage ignored artifacts.

## Persistence and authority

`engagement/work/<id>.json` holds a frozen question, evidence snapshot,
assessment, selected action, exact assignment, and execution/review record.
`engagement/work/<id>.md` holds the reviewed result note for later assessments.
No separate authoritative status file is created. A prepared assignment is not
an approved customer decision. A launched process, exit zero, or a recorded
review is not proof of customer value, implementation, or method completion.

Unknown launch outcomes are kept as unknown, including after review. Guide
does not retry them or allow another launch while such work is unresolved.
Inspect the live terminal and repository before closing that work. The review
records the earlier execution state. Reopening historical work remains possible
if a profile is no longer installed; launching still requires a current,
available workflow.

Source hashes identify content versions, not authentic customer approval.
Changed evidence, a changed Git revision, a changed workflow frame, or changed
saved metadata blocks a stale launch. Native agents can edit host files; this
is drift detection, not an OS security boundary.

Git status in result review includes pre-existing edits and excludes ignored
outputs. It is not an agent-owned diff. Inspect actual output files and retain
the distinction between proposals and accepted decisions.

## Limits and data handling

- Select 1-64 files, each at most 64,000 UTF-8 bytes, and at most 128,000 source
  bytes in total. Discovery is capped at 512 entries; HVE nesting is capped at
  eight levels. Exceeding a limit stops with a diagnostic; nothing is truncated.
- The engagement question and additional context each allow 8,000 characters.
  Model input must also fit the selected model's reported context capacity.
  `--model` and `--effort` apply to assessment, not the HVE agent's own model.
- Assessment uses the existing tool-denied model service. Quotes and line ranges
  must match the supplied sources. `@user-context` identifies your unverified
  clarification, not a file. Models cannot supply executable commands.
- Agent support currently uses the seven interactive Native HVE customer
  workflows. The model can still recommend a human action. No batch queue,
  Sandbox execution, Herdr popup, background handoff, or new-worktree transfer
  is provided in this mode. A normal Herdr terminal in the same worktree works.
- `--json`, `--next-steps`, `--profile`, and `--ui-variant` cannot be combined
  with `--engagement`. `--intent-stdin` can supply the question as plain text.
- Symlinks, hard links, unsafe paths, invalid UTF-8, control text, and malformed
  records are refused. Private path checks are case-insensitive. Managed folders
  with a case-only name collision are refused, not renamed. Ignored work-record
  paths block persistence. A write lock is not removed automatically after an
  interrupted writer; inspect it first.

Only select material you may send to the configured model and selected agent.
Preparing an assignment also copies it into repository-local work records.
Do not copy restricted customer material into Git. Guide does not establish
data access rights, redact secrets, enforce retention, transcribe meetings,
install MCAF governance, stage changes, commit, push, or publish reports.
