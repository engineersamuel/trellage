# Guide UI integration matrix

With Bun 1.3.3 and Python 3 available, prepare the source workspace and run the
matrix from the repository root:

```bash
scripts/install-source-runtime.sh --prepare
mise run trx-guide-test
```

Preparation installs frozen dependencies, validates source ownership and bin
permissions, and records the readiness receipt. A raw Bun install is not
equivalent. Native installation fixtures must use the same prepared-source
contract; missing readiness must remain a refusal, not an implicit install.

This task keeps all 31 cases and uses a 60-second slow-test reporting threshold
because Vitest applies it to both individual cases and the file total. That
threshold does not change test timeouts or failure reporting.

The tests send real keyboard input to `GuideApp` through the Python
standard-library POSIX PTY bridge in `tests/helpers/posix-pty.py`. Both the
Vitest workers and the TS/TSX fixture children run under Bun; Python provides
terminal transport, not application execution. `@xterm/headless` interprets
the terminal output. Assertions use the visible screen and recorded command
boundaries, not reducer calls or screen snapshots. No `node-pty` addon,
application bundle, or `dist` is required.

The fixture offers five ranked recommendations and the three pinned lenses:
Council, Research, and HVE RPI. Ranking currently permits at most five
recommendations. The mixed cases use all eight profiles without changing that
limit. Each profile generation produces three prompt candidates. Queueing one
of them creates one job, not three jobs.

Short approved goals instead have two eligible profiles: Native Codex
`planner` and Native Claude `default`. The long Unicode goal excludes Claude
when the fixed condition cannot fit its 4,000-character limit. A separate
Graph case adds one Sandbox `claude-graph-of-loops` fixture; it does not change
the ordinary matrix's eight-profile catalog or five recommendations.

Run only the goal PTY cases with the existing runner:

```bash
cd packages/trellage-launcher
FORCE_COLOR=1 bun run test test/guide-ui.integration.test.ts -t 'goal|interview|long questions'
```

## Implemented cases

Counts apply to each case, including each seed of a parameterized case.
Handoffs are recorded requests, not real harness launches.

| Interaction | Cases | Generated candidates | Queued jobs | Handoffs | Required outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| Select a Native or Sandbox profile and a non-default candidate; confirm this terminal | 2 | 3 | 0 | 1 | Exact launcher, prompt argument, cwd, and automation flag |
| Park a pending readiness probe, change the main selection, and reopen the fork | 1 | 3 | 0 | 0 | Exactly one inventory request survives parking; release reaches destination selection; cancellation launches nothing |
| Queue Council, Research, and HVE RPI; return to the main screen and press `L` | 1 | 9 | 3 | 3 | Correct skill frames and the HVE `--agent hve-core:rpi-agent` argument |
| Visit all five recommendations in seeded order; choose seeded candidates and press `L` | 2 | 15 | 5 | 5 | Every selected profile appears once, with its own prompt and launcher arguments |
| Queue all five recommendations and all three lenses; reopen a fork and press `L` | 1 | 24 | 8 | 8 | The global launch key dispatches the full queue, not only the active fork |
| Remove three seeded entries from an eight-job queue at 120 and 240 columns | 2 | 24 | 8 to 5 | 5 | The selected job stays visible; only retained job IDs launch, in queue order; profile and prompt pairs stay intact |
| Remove every entry; try `L` and Enter; cancel | 1 | 15 | 5 to 0 | 0 | Empty queues emit no allocation or launch command |
| Augment the draft with Research or Codebase before matching | 2 | 3 | 1 | 1 | The full augmented intent reaches matching, generation, optimization, and the final command |
| Augment from prompt review after one job is queued | 1 | 6 | 2 | 2 | Matching uses the new intent; the existing queued prompt does not change |
| Open Goal me with `p` then `a`; answer, park, edit the source, revise, and approve | 1 | 6 | 2 | 2 | One interview carries choice and text answers; replacement of the newer prompt needs confirmation; the old ordinary job stays unchanged and the new Codex goal needs native input |
| Review all three Codex `/goal` candidates, edit one approach, and print | 1 | 3 | 0 | 0 | The exact approved goal and score bar survive; the editor receives only the approach; typed shortcut keys remain text |
| Select a pinned lens from an approved goal; return with `b` and `Esc`, then choose `n` | 1 | 6 | 0 | 0 | No generation before the explicit normal-flow choice; the reference fork gets goal facts without execution mode; the main goal stays attached |
| Read a long Unicode goal at 88 columns, edit its approach, and print | 1 | 3 | 0 | 0 | Only compatible Codex is ranked; the task tail and criteria remain accessible; full Unicode text survives without truncation |
| Select the dedicated Graph goal fixture and visit all three candidates | 1 | 3 | 0 | 0 | `/graph-of-loops` is the only controller; authored gates and approved criteria survive without `/goal` or the generic progress protocol |
| Confirm a Codex or Claude goal in this terminal | 2 | 3 | 0 | 1 | Codex starts with no argv goal and needs native input; Claude uses the exact `-p` condition after read-only readiness |
| Queue a Claude goal for Herdr | 1 | 3 | 1 | 1 | The session stays interactive with no startup prompt; the result retains its full condition and reports `needs-input` |
| Edit a queued goal approach, keep cancelled main changes, reapprove a new goal, then choose normal prompt mode | 1 | 6 | 2 | 2 | Old forks and jobs retain their goal; both queued conditions stay distinct and are reported as needing input, not activated |
| Press `a` to accept current and later Goal-me recommendations; answer a manual question, park, revise, and approve | 1 | 0 | 0 | 0 | Exact marked choices reach one session; missing recommendations wait for input; typed `a` stays text; final approval remains manual |
| Retry a failed Goal-me interview | 1 | 0 | 0 | 0 | Completed answers remain visible and seed an explicit retry; cancelling applies no result |
| Read a long Goal-me question at 64 columns and 20 rows; type, park, discard, restart, and exit | 1 | 0 | 0 | 0 | The full question and answer controls remain usable; the answer draft survives parking; discard stops the old interview and applies no result |
| Edit one queued prompt with multiline paste and individually typed shortcut keys | 1 | 9 | 3 | 3 | Only that job changes; typed `L`, `x`, digits, and backticks do not trigger shortcuts; quoted shell expressions stay literal |
| Reopen a queued fork and select another candidate | 1 | 3 | 1 | 1 | The existing job is replaced, with no duplicate job or extra generation |
| Mix a current-workspace pane, a new tab, and a new worktree | 1 | 9 | 3 | 3 | Exact allocation commands, branch, base ref, returned pane IDs, and launch directories |
| Queue HVE, Sandbox, and HVE again; reject a duplicate; correct and reopen | 1 | 9 | 3 | 3 | Exact profile names and `-2` suffix; duplicate causes no Git inspection or allocation and no open-existing offer; reopening preserves branch and job ID |
| Confirm a dirty checkout or reuse an existing worktree | 2 | 3 | 1 | 1 | Both dirty-checkout confirmations are required; reuse opens rather than creates, and uses Herdr's returned canonical cwd |

The recommendation cases use seeds `17` and `73`. Queue removal uses seed `41`
at 120 columns and seed `97` at 240 columns, both with 40 rows. The wide case
exposes multiline command previews even when temporary paths are long. Both
cases require the selected job to stay visible before opening or removing it.
Other multi-profile cases also have fixed seeds. A failure is repeatable; the
test does not use ambient randomness.

## Input and output contracts

For each generated profile, the driver visits all three candidates, checks
their complete rendered prompt text, checks navigation back to the first
candidate, and then selects the requested candidate. Provider records must
show the expected intent, profile, workflow, optimization target, and exactly
three candidates per generation. Skill prefixes and suffixes must survive
optimization.

Goal records also carry the approved structured snapshot through matching,
generation, and optimization. Fake model replies contain short approaches,
not copies of the protected goal. Goal matching accepts only the supplied
eligible profiles; ordinary matching still asserts the complete catalog and
five ranked results. The goal cases page through each candidate's task,
criteria, and approach, then compare the full selected prompt and frozen
metadata with an independent expected value. They retain the exact original
Goal-me document for review while excluding its generic execution protocol.
Goal-mode requests also use the real Copilot request serializer with an
injected SDK client. Assertions inspect the outgoing task-only intent and
structured artifact, task, criteria, and score bar. The full approved document
stays in `input.goal.prompt`, not the model payload. No SDK runtime starts.

For each handoff, independent expected commands specify the executable,
argument order, selected prompt, and destination. These expectations do not
call the production launch or workflow builders. Coverage includes the
different prompt arguments for `cdx`, `cpx`, `cldx`, `picx`, and Sandbox
`trellage`, plus the pinned HVE agent argument. Working-directory paths contain
spaces, and prompts contain quotes and newlines. Herdr command strings must
preserve them through shell quoting.

Codex goal handoffs are different from ordinary argv prompts. Read-only
version and feature probes use fixture replies. Goal readiness is checked
again in the allocated destination before its profile starts. The interactive command
contains only the selected profile, and no automated pane paste follows it.
Queued goal results use `needs-input` and retain each job's condition, pane,
workspace, and directory. The expected manual step is to type `/goal `, then
paste the body and submit it. Printed command text, a started session, and an
exit code do not prove native goal activation or completion. Claude uses `-p`
in this terminal, but interactive Herdr needs native input. Its readiness
checks receive in-memory trust and hook settings, local-settings paths, and
fixture runtime/model-inventory replies. The journal records exact settings
requests before and after allocation; no host Claude settings are inspected.

A live event journal checks that no pane, tab, worktree, or harness launch
request occurs before confirmation or `L`. Final results must contain exactly
the expected retained jobs and commands. Removed jobs must not launch.
Unexpected external commands fail instead of falling through to a real tool.

Worktree expectations are independent constants for each profile and numeric
variant. The fixture accepts only those branches and records each allocation
at its requested branch path. It does not call the production name formatter.
Unit and reducer tests also cover the 40-character limit, long profile hashes,
multi-digit suffixes, trimmed conflicts, replacement self-exclusion, released
reservations, and the final queue check after inspection.

## Offline boundaries and maintenance

The real UI, guide parsing, prompt pipeline, queue, readiness handling, command
builders, and result execution run unchanged. Fixtures replace model replies,
native inventory, Sandbox doctor output, Git inspection, and Herdr responses.
Native Codex version/features and Claude runtime/model-inventory checks also
use the recording runner. The injected readiness services cover both UI
preflight and result execution; they reject unexpected paths instead of
reading host configuration. No real `codex`, `cldx`, or `curl` process runs.
Research writes a fixture note; Codebase writes a fixture repository pack and
returns a fixed enriched intent. Neither path starts its external tool.
Goal me uses a fake interview provider with the real request controller and
Ink question/review controls. It records exact answers, freeform flags, review
decisions, and session IDs. Goal reviews use the same Markdown renderer as
prompt previews, without changing the approved goal text. Separate fake-SDK
tests cover the real `onUserInputRequest` contract, the fixed `gpt-6-astra` /
`max` model policy, opt-in recommended answers, tool restrictions, human
waits, and cleanup. Controlled-time cases keep one session through automatic
answer rounds beyond the old total deadline, renew the limit after revision,
and retain the timeout for stalled work. Controller coverage includes
ambiguous recommendations, queued requests, stopping automation, and
cancellation.
Neither layer makes a paid model call or writes a project goal file.

Each case has a new Bun UI process, workspace, HOME, and temporary directory.
The package script executes Vitest explicitly through Bun with
`--configLoader native`; a Node shebang must not select the test runtime.
The fixture runs TypeScript and TSX source directly; no UI bundle is built and
no model artifact cache is used. The PTY adapter applies the public
`sourceEnvironment()` helper before Python starts, preserving
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` in isolated child environments. Keep
`interactive: true` and `FORCE_COLOR=1` in the child so CI retains interactive
rendering and style-only queue-focus updates. Screen reads happen after the
terminal emulator has processed the output.

Before sending the first key, both the Guide and continuation UI drivers wait
for the initial screen and the terminal emulator's current
`modes.bracketedPasteMode`. Ink enables it with `ESC[?2004h` and disables it
with `ESC[?2004l`; finding an old enable marker in the output history is not
enough. The initial render can precede Ink's input effects. Without this
readiness check, terminal echo can satisfy a text assertion even though the
UI has not consumed the input. This initial-editor check retains the existing
5-second wait bound. It is not a requirement for later menus, where bracketed
paste can legitimately be disabled.

The native transport and readiness regressions run separately with:

```bash
cd packages/trellage-launcher
bun run test test/source-pty.test.ts test/guide-terminal-readiness.test.ts
```

They verify real Bun and child process identity, raw Unicode and control
input, terminal dimensions and resize, exit codes and signals, and refusal
of revoked input readiness. Two isolated-environment cases import real guide
source and require an empty temporary HOME with the transpiler cache disabled,
even when the caller omits or overrides the cache setting.

Subsequent waits require the expected profile,
prompt, menu selection, or single highlighted queue job ID. Receipt of terminal
bytes alone is not a completed UI transition. There are no fixed sleeps.
For an ignored key such as `L` on an empty queue, the fixture records stdin
receipt before the next key is sent, so Ink cannot combine it with Enter.
Failures include keyboard input, the last screen, and recent raw terminal output.
Batch failures also print their captured summary, so an unexpected exit code
does not hide the failed operation's diagnostic.

These tests do not prove live provider compatibility, recommendation quality,
harness startup, real Docker or Herdr behavior, or the outer `trx` shell
router. They run on the existing Vitest `forks` pool.
`packages/trellage-launcher/vitest.config.ts` caps
the launcher suite at two workers. Each PTY case starts another Bun process,
and `make test` already runs four targets in parallel by default. Keep this
cap to limit nested process concurrency rather than increasing timing bounds
to compensate for full-suite load.
