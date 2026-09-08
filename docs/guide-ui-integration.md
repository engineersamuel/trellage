# Guide UI integration matrix

Run the matrix with mise:

```bash
mise run trx-guide-test
```

Normal runs take about 35 seconds. This task keeps the full case list and uses
a 60-second slow-test threshold because Vitest applies it to both individual
cases and the file total. Expected timings stay green. Test timeouts, failure
reporting, and the threshold for other launcher test commands are unchanged.

The tests send real keyboard input to `GuideApp` in a pseudo-terminal.
`@xterm/headless` interprets the terminal output. Assertions use the visible
screen and recorded command boundaries, not reducer calls or screen snapshots.

The fixture offers five ranked recommendations and the three pinned lenses:
Council, Research, and HVE RPI. Ranking currently permits at most five
recommendations. The mixed cases use all eight profiles without changing that
limit. Each profile generation produces three prompt candidates. Queueing one
of them creates one job, not three jobs.

## Implemented cases

Counts apply to each case, including each seed of a parameterized case.
Handoffs are recorded requests, not real harness launches.

| Interaction | Cases | Generated candidates | Queued jobs | Handoffs | Required outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| Select a Native or Sandbox profile and a non-default candidate; confirm this terminal | 2 | 3 | 0 | 1 | Exact launcher, prompt argument, cwd, and automation flag |
| Queue Council, Research, and HVE RPI; return to the main screen and press `L` | 1 | 9 | 3 | 3 | Correct skill frames and the HVE `--agent hve-core:rpi-agent` argument |
| Visit all five recommendations in seeded order; choose seeded candidates and press `L` | 2 | 15 | 5 | 5 | Every selected profile appears once, with its own prompt and launcher arguments |
| Queue all five recommendations and all three lenses; reopen a fork and press `L` | 1 | 24 | 8 | 8 | The global launch key dispatches the full queue, not only the active fork |
| Remove three seeded entries from an eight-job queue at 120 and 240 columns | 2 | 24 | 8 to 5 | 5 | The selected job stays visible; only retained job IDs launch, in queue order; profile and prompt pairs stay intact |
| Remove every entry; try `L` and Enter; cancel | 1 | 15 | 5 to 0 | 0 | Empty queues emit no allocation or launch command |
| Augment the draft with Research or Codebase before matching | 2 | 3 | 1 | 1 | The full augmented intent reaches matching, generation, optimization, and the final command |
| Augment from prompt review after one job is queued | 1 | 6 | 2 | 2 | Matching uses the new intent; the existing queued prompt does not change |
| Edit one queued prompt with multiline paste and individually typed shortcut keys | 1 | 9 | 3 | 3 | Only that job changes; typed `L`, `x`, digits, and backticks do not trigger shortcuts; quoted shell expressions stay literal |
| Reopen a queued fork and select another candidate | 1 | 3 | 1 | 1 | The existing job is replaced, with no duplicate job or extra generation |
| Mix a current-workspace pane, a new tab, and a new worktree | 1 | 9 | 3 | 3 | Exact allocation commands, branch, base ref, returned pane IDs, and launch directories |
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

For each handoff, independent expected commands specify the executable,
argument order, selected prompt, and destination. These expectations do not
call the production launch or workflow builders. Coverage includes the
different prompt arguments for `cdx`, `cpx`, `cldx`, `picx`, and Sandbox
`trellage`, plus the pinned HVE agent argument. Working-directory paths contain
spaces, and prompts contain quotes and newlines. Herdr command strings must
preserve them through shell quoting.

A live event journal checks that no pane, tab, worktree, or harness launch
request occurs before confirmation or `L`. Final results must contain exactly
the expected retained jobs and commands. Removed jobs must not launch.
Unexpected external commands fail instead of falling through to a real tool.

## Offline boundaries and maintenance

The real UI, guide parsing, prompt pipeline, queue, readiness handling, command
builders, and result execution run unchanged. Fixtures replace model replies,
native inventory, Sandbox doctor output, Git inspection, and Herdr responses.
Research writes a fixture note; Codebase writes a fixture repository pack and
returns a fixed enriched intent. Neither path starts its external tool.

Each case has a new UI process, workspace, HOME, and temporary directory. The
UI bundle is built once per suite, but no model artifact cache is used. Keep
`interactive: true` and `FORCE_COLOR=1` in the child so CI retains interactive
rendering and style-only queue-focus updates. Screen reads happen after the
terminal emulator has processed the output. Waits require the expected profile,
prompt, menu selection, or single highlighted queue job ID. Receipt of terminal
bytes alone is not a completed UI transition. There are no fixed sleeps.
For an ignored key such as `L` on an empty queue, the fixture records stdin
receipt before the next key is sent, so Ink cannot combine it with Enter.
Failures include keyboard input, the last screen, and recent raw terminal output.

These tests do not prove live provider compatibility, recommendation quality,
harness startup, real Docker or Herdr behavior, or the outer `trx` shell
router. They run on the existing Vitest `forks` pool; do not move `node-pty`
tests into worker threads.
