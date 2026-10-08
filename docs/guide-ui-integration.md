# Guide UI integration matrix

With Bun 1.4.2 and Python 3 available, prepare the source workspace and run the
matrix from the repository root:

```bash
scripts/install-source-runtime.sh --prepare
mise run trx-guide-test
```

Preparation installs frozen dependencies, validates source ownership and bin
permissions, and records the readiness receipt. A raw Bun install is not
equivalent. Native installation fixtures must use the same prepared-source
contract; missing readiness must remain a refusal, not an implicit install.

The matrix uses a 60-second slow-test reporting threshold
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

The shared Review changes action has a scope, target, six-check selection,
model consent, saved report, explicit finding approval, and fresh-agent flow.
Committed plus current work opens the current worktree directly with a
detected comparison base; `b` provides an explicit override. Uncommitted-only
review remains a separate choice. It preserves the main intent and does not call
matching, generation, prompt optimization, or conversation capture. Its fixture
records selected files, comparison base, original task, reviewers, approval,
and selected profile. The model boundary is injected; no paid calls are made.
All eligible changed files start selected, including untracked files. Space
excludes individual files; ignored files and unsafe paths remain excluded.
Existing forks, goals, and queued jobs are unchanged. Real-Git tests cover clean
committed work, staged and unstaged changes, path selection, and stale snapshots.
Execution tests cover readiness, concurrent writers, normal startup-prompt
delivery, unchanged staging, durable approval, related-context changes, and
uncertain launch outcomes. Engine contracts cover frozen text tools, budgets,
citation validation, exact quotes copied from read source ranges, numbered
source pages and unread-range feedback, partial failures, cancellation,
no-change results, and preserved disagreement. Missing, repeated, and unknown
finding IDs fail validation before approval. Failed reviews retain their
partial reports and offer a new review through target inspection and fresh
model consent. The architecture option reads managed skill content through
the floating manager; skill resolution has an offline fixture.

## Headless Optimize goal

The PTY matrix uses injected model responses. The separate acceptance command
uses the same production review engine with real Copilot SDK calls:

```sh
mise run trx-optimize-check -- --live
```

Use this goal: **Complete a read-only Optimize run over all eligible changes
in the specified worktree, with all three reviewers, without changing source,
approving findings, or launching an editor.**

Its measurable pass condition is exit `0` and one JSON result with
`passed: true`, `status: "complete"`, `reports: 3`,
`worktreeUnchanged: true`, `approvedFindings: 0`, and
`execution: "not-started"`. When findings exist, require `challenges: 3` and
one decision per finding. A no-change result has zero challenges and decisions.
The saved `reviewId` and `evidenceFingerprint` identify the evidence. Logs on
stderr show progress; the full report can be reopened in Guide without new
model calls.

Live use requires explicit approval and can consume paid quota. Set the
allowed number of runs before giving this goal to an agent; do not retry
indefinitely, narrow the scope to pass, weaken evidence checks, or require a
fixed number of suggestions. The command performs one review, with at most
one correction request per invalid model response. The 14-request bound for all
three built-in reviewers applies to a single evidence batch; larger snapshots
have a saved, expanded call budget. Corrections stay within their request
deadline. Model-capacity preflight can select fresh batches before inference;
runtime and exhausted evidence-budget failures are not retried. Keep live use outside
the offline test suite.

## Other Guide fixtures

Separate customer fixtures replace the HVE RPI entry with checked Discovery.
They drive the local brief, approval, protected generation context, direct
launch, and queue refusal at 88 columns. Direct Herdr cases cover panes,
tabs, new worktrees, and existing worktrees with a readiness recheck in each
destination. They do not change the ordinary eight-profile matrix or execute
a real HVE agent.

Repository engagement cases use the separate `EngagementApp`, real temporary
Git repositories, the production source reader and work store, and an injected
assessment/agent boundary. They cover local-only opening, explicit source-use
consent, one saved assignment, separate launch confirmation, return for result
review, result-file inspection, persistent reopening, clarification with
multiline paste at 64 columns, and human-only result rejection. They make no
model calls and start no real coding agent.
The launch fixture also starts a harmless Bun child through redirected parent
streams. The interactive transport must reconnect all child streams to the
controlling terminal, so a piped Guide intent does not break HVE's TTY checks.
Separate terminal-input contracts require the child to read and acknowledge
real keyboard input with both inherited and redirected parent streams.
On macOS, the handoff opens the actual controlling device because
the `/dev/tty` proxy cannot be polled with `kqueue`.

## Jev decisions and LLM cost gates

When `TYPESAFE_API_KEY` is available in the environment or the worktree's
`.env`, Jev can make narrow decisions before expensive generation calls:

- Guide checks all three generated prompt candidates in one request. It skips
  Prompt Master only when every candidate has at most 0.03 probability of
  needing a material improvement. Approved goals still use the full optimizer.
- Codebase augmentation checks the intent before it packs the repository. It
  keeps the original intent and skips both packing and rewriting only when
  Jev assigns at most 0.02 probability that repository facts are needed.
- Doctor diagnosis can return a fixed, non-executing category explanation when
  Jev selects a known cause with at least 0.94 confidence, and the captured
  output is at most 16 KB. Otherwise it uses the existing diagnosis model.
- Conversation continuation can skip its final assessment only when the source
  history is complete, the decision input is at most 16 KB, and Jev assigns at
  least 0.995 probability to there being no useful follow-up. Long or incomplete
  histories continue through the full assessment path.

Each decision uses one TypeSafe request with retries disabled. If a decision
request fails, Guide, augmentation, and diagnosis use their existing LLM path;
continuation also uses its full assessment path. These checks do not run tools,
change files, authorize repairs, verify completion, or bypass deterministic
validation. Jev receives the prompt candidates for the optimization check, the
intent for the repository-context check, and captured doctor output for the
diagnosis check. The API key is not included in request state. Track quality,
fallback rate, cost, and tail latency before changing the thresholds.

Jev matching and these decision gates use one key loader. It reads the key
from these sources, in this order:

1. `TYPESAFE_API_KEY` in the process environment.
2. `TYPESAFE_API_KEY` in the worktree's `.env`.
3. The value that `trx guide` and `trx admin` resolve through Varlock from the
   Trellage user environment.
4. A plain value in the private `.env.local`, then `.env`, in
   `$XDG_CONFIG_HOME/trellage` or `~/.config/trellage`.

Source 3 also resolves Varlock function values, such as encrypted secrets,
which source 4 skips. Put the key in `~/.config/trellage/.env.local` (or the
`[environment] path` in `config.toml`) and set that file to mode `0600`. You can
also declare it in `.env.schema` as an optional sensitive item:

```dotenv
# @sensitive @optional
TYPESAFE_API_KEY=
```

The router resolves only this key and gives it to the launcher under a private
name. The launcher removes that name from its environment at startup, so agents
that the guide launches do not inherit the key. The key is optional: if it is
absent, the guide runs without Jev and shows no message. If the environment
source is unsafe or Varlock cannot load it, the router does not load the key,
prints one `Jev decisions stay off` line, and the guide continues on its
existing LLM paths. `TRELLAGE_ENVIRONMENT=off` disables this loading.

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

## Live review integration tests

Review capture no longer uses a 384 KiB model-input limit. The shared service
captures each Git layer once, keeps staged and unstaged evidence (including
staged changes undone in the worktree), and identifies a net base-to-worktree
view. When the net view equals an existing layer, it reuses that source.
Saved patch projections contain source IDs, not a second copy of the patch.

`review-evidence.ts` is the frozen-evidence entry point. The check catalog
determines HEAD requirements, related-source versus patch projections, and
required skill sources. Capture, stored-record validation, and per-check source
plans use that same definition. Built-in line ranges and skill UTF-16 ranges
keep their existing coordinates while sharing batch packing and a cumulative
read ledger. Repeated reads consume budget; overlapping reads do not fill gaps.

Shared review execution, display, planning, and approvals use `ReviewRun`
directly. Only the legacy-record adapter converts schema-version-1 records,
preserving their original approval digests and document rendering. Saved-record
namespaces determine authority before adaptation; an ambiguous ID or malformed
record cannot fall back to another namespace. Both authorities retain one-use
execution reservations.

Model budgets use discovered context, prompt, and output capacities. UTF-8
bytes are used as a conservative token upper bound, not as an exact token
count. Instructions, tool protocol, and output space are reserved. Missing or
invalid capacity metadata fails before skill inference.

Skill reviewers use a manifest and paged, read-only frozen snapshot tool.
Ponytail must read every assigned range. Fleet and Standards workers receive
the bounded assigned patch through the trusted task hook. A review that exceeds
one context uses fresh batches and an additional cross-file check. Built-in
checks also use complete evidence batches and cross-file consolidation.
Synthesis receives reports and source IDs rather than another complete patch.
Each batch must finish; missing reads or failed workers cannot produce a
complete review. Batch reports and intermediate worker evidence are retained.
Fleet workers have separate read budgets; their reads do not consume the
coordinator's context allowance. Workers may load the selected Fleet skill and
read its frozen report references, but cannot delegate, write reports, or access
live files. Only the coordinator's skill invocation satisfies the required
installed-skill check. If extraction cites unread lines, one fresh
correction can read the range or select a smaller checked range. An ungrounded
finding remains read-only, and a second coverage failure stops normalization.

Local safety limits remain separate from model capacity: 32 MB of frozen
evidence, 128 skill batches, 1 MiB per saved report artifact, 4096 intermediate
artifacts (32 MB combined), and the existing per-check finding bounds. Built-in snapshots retain
their per-file and file-count bounds. Exceeding a bound fails explicitly; no
patch text is silently truncated. Large reviews can use more calls and time.
Automatic model conversation compaction remains disabled.
Combined synthesis has a 15-minute default deadline, including startup and
repair, so high-reasoning coordinators can process multiple completed reports.
Explicit caller deadlines remain unchanged. Peer debate retains its shorter
deadline within the synthesis budget; no extra model calls are added.

Run real reviews without a terminal UI:

```sh
mise run trx-review-test -- --live --fixture
mise run trx-review-test -- --live --fixture --all
mise run trx-review-test -- --live --fixture --fixture-bytes 420000 --check first-principles --check ponytail --check fleet
mise run trx-review-test -- --live --cwd /absolute/worktree --uncommitted --check ponytail
mise run trx-review-test -- --live --cwd /absolute/worktree --base main --check ponytail --check fleet
```

The first command creates a small, real Git repository with a committed baseline
and an uncommitted complexity regression. Only this synthetic source is reviewed.
`--fixture-bytes N` adds at least N bytes of synthetic source in files below the
per-file snapshot limit (maximum 8,000,000). It works with isolated `--all`
cases or a combined selection. Use 420000 to exceed the former patch limit,
or 1200000 to also exercise capture above the default command-output limit.
Only `--cwd` commands send the selected worktree's code to the models. `--live` and
exactly one target (`--fixture` or `--cwd`) are required. These commands consume
quota. They are not part of `make test`, the offline Guide matrix, or CI.

The harness calls `createGuideOptimizeServices().inspect()` and `.review()`,
the same service methods used by `trx guide --review`. It does not substitute
SDK clients, model responses, prompts, skills, extraction schemas, or validators.
The production coordinator captures frozen Git evidence, loads the installed
floating skills, runs the selected checks, extracts findings, runs synthesis,
closes sessions, and saves the normal private review record. The harness then
reads that record through `SharedReviewStore` and compares it with the result
returned to the TUI. Rendering, interactive consent, and implementation handoff
are outside this test; `--live` supplies consent. No profile discovery is needed
because this path never approves or launches implementation.

Ponytail is selected by default. `--all` runs every check from the TUI catalog
as a separate case, in sequence: First principles, Behavior preservation,
Improve codebase architecture, Ponytail, Fleet, and Matt Pocock Code Review.
Each case calls the same service with only its own reviewer selected and runs
its normal synthesis. Fleet still runs its six real workers; Matt still runs
Standards and explicitly skips Spec because Guide has no verified spec input.
The fixture is recreated for each case. Each case gets its own evidence directory
and `summary.json`; the parent `summary.json` records every case, total calls,
and the aggregate result. A case failure does not skip later cases. Cancellation
stops the matrix, marks remaining cases `notRun`, and cannot pass. The timeout
applies per case. This sequential matrix can take much longer and use more quota
than one Ponytail run.

Repeat `--check ID` to use any combination from
the shared review catalog. The usual review model defaults and
`TRELLAGE_GUIDE_MODEL` / `TRELLAGE_GUIDE_EFFORT` overrides apply. Repeat
`--path FILE` to select specific changed paths; otherwise all eligible regular
and deleted files are selected. With `--cwd`, scope defaults to the current
branch plus edits, as in Guide. The fixture always uses uncommitted scope.

Each invocation runs once and returns one JSON summary on stdout. Exit `0`
means all selected checks and synthesis completed, nonempty reports were saved,
the saved result matches the service result, and the worktree stayed unchanged
with no approval or implementation. Exit `1` means failure, including partial
coverage; cancellation returns `130`. A report alone is not success. Finding
counts are not fixed because model output varies. Grounded finding counts are
reported separately; completion does not mean every finding can be approved.
The production validators and approval rules remain unchanged.

Evidence is retained in a fresh private `run-*` directory under
`$XDG_STATE_HOME/trellage/review-live-tests` (default:
`~/.local/state/trellage/review-live-tests`). `--output DIR` changes the parent;
it must be outside the reviewed worktree. The harness prints the directory
before starting. It stores:

- `request.json`: target, selected paths, model assignments, and coordinator.
- `events.ndjson`: timestamped production events, bounded to 16 MiB; artifact
  events contain IDs and digests, not duplicate report bodies.
- `review.json`: validated saved run, including frozen evidence, skill
  references, reports, findings, and safe provider diagnostics, when returned.
- `summary.json`: outcome, checks, call count, unchanged-worktree result, and
  failures. Setup failures remain failures, not skips or empty passes.

The fixture and its normal Git-private review record are retained with the
evidence. For an existing worktree, the normal record stays in that worktree's
Git directory. These files can contain source and model output; keep them
private. `--timeout-seconds N` bounds one attempt (default 1800, maximum 7200).
SIGINT, SIGTERM, and the deadline use the production cancellation/cleanup path.
A goal loop can run the same command again after a code change, inspect the
summary and saved review, and stop only on exit `0`. The harness neither retries
whole reviews nor changes code. It retains each attempt separately.
Use `--all` for independent per-reviewer acceptance; repeated `--check` values
instead test those reviewers together in one review. Do not combine the two.

Offline contracts for argument guards, outcome assertions, fixture capture,
and cancellation run with:

```sh
cd packages/trellage-launcher
bun run test test/review-live-test.test.ts
```

## Review terminal contracts

`test/review-ui-terminal.test.ts` checks one-Enter review selection (including
all three skills), empty selection, separate bounded live output at 80x18,
result access, and cancellation without model calls. It checks confirmation before
continuing in the current terminal or a Herdr tab, and uses a local child
process to check that the Review screen exits before the child inherits
terminal input. It blocks a new worktree for uncommitted changes.
`test/review-continuation.test.ts` checks the
Copilot plan-mode handoff prompt and arguments, selected destination, and clean-HEAD worktree guard
without starting an agent. Enter during an active review cannot start
another paid run. The fake SDK backend checks assistant
text streaming, Fleet child progress, and suppression of duplicate final
messages and master JSON. The Guide
matrix also checks that Ctrl-R opens Review only from an empty intent and
does not discard an existing draft. The direct `trx guide --review` router
path accepts the same context/base/model arguments as `--optimize`, avoids required
full profile discovery and Prompt Master preparation, and supplies an optional
Native catalog on fd 3. Both flags, the embedded action and popup use the same flow.
Ctrl-R stays inside Guide so intent, goals, forks and queued jobs survive returning.
The current-terminal continuation launches through
`mise run trx -- run cpx hve -- --plan -i` in a source worktree, or
`trx run cpx hve -- --plan -i`
for an installed router. The source router prepares stale runtime readiness
before dispatch; neither route launches the saved absolute `cpx` path directly.
The selection screen includes Matt Pocock Code Review as a separate option
alongside Ponytail and Fleet. It shows one worker because the current Guide
flow has no verified spec input. A missing spec must be shown as a skipped
Spec axis, not a second worker
or a completed Spec review.
The shared reports view opens the first selected check. All selected checks,
Overview and Synthesis have bordered tabs as soon as the run is queued.
The active tab has a double border and a `›` marker; inactive tabs have neutral
rounded borders. Friendly labels retain explicit queued, running, complete,
partial or failed status. Short terminals show one row of tabs; tall terminals
show up to two. The strip pages to keep the active tab visible, with its position
shown as “Tab N/total” in the report header. All eight tabs remain reachable
when all six checks are selected at 80×24. Tab/Shift+Tab
and Left/Right switch tabs; PgUp/PgDn scroll the active report. The viewport
is a full-width bordered panel with a title, status, source notice, and padded
content. It uses the remaining terminal height after tab borders, header rows,
and footer controls, including after a resize. The footer stays visible. Selection and
each tab's scroll position survive streaming and completion. Fleet child
messages stay in Fleet and show their source. Live text is unverified and
limited to the latest 8,192 characters per check. Built-in checks show readable
phase and batch progress, not raw structured-response tokens. Repeated SDK
progress messages are shown once per phase; completed findings remain in the
saved report. At completion, `p` toggles full saved
reports and `f` opens findings; neither starts a new model call.
Full saved artifacts, including partial
reports and synthesis questions, remain in the private version-2 history record.
Each new record saves synthesis status separately from overall completeness.
A completed synthesis stays complete when a source check fails; approval remains
blocked. Older records infer completed synthesis from their saved synthesis
artifact. Failed source reports are labelled unvalidated and read-only.
Intermediate reports are captured before synthesis and again after cleanup,
without duplicate artifact IDs. Skill-review execution owns workspace preparation,
normalization, artifact retention, provider shutdown, and workspace removal.
Artifact ownership is supplied by the producing check, never inferred from a
filename; Fleet, Ponytail, and Matt reports remain attached to their source tabs.
Unregistered artifacts in a mixed-check workspace fail capture rather than
being assigned to synthesis. Synthesis receives saved failed reports as unvalidated
evidence, not accepted findings.

Synthesis receives separate, explicit ID lists for source decisions and combined
findings. These lists come from the same function used by the validator and are
repeated in a repair request. Every review and normalized finding needs a
decision, but a combined finding must cite the specific finding IDs when they
exist, not the top-level review or report artifact ID. Invalid IDs still fail
validation; repair does not invent or silently replace them.

Ponytail and Standards finding extraction can retry once from the saved report,
using the same selected model and frozen evidence. Each attempt has a two-minute
limit and counts against the confirmed call budget. Cancellation, cleanup
failure, known schema/authentication/quota errors, and malformed JSON or shape
do not retry. A valid-shaped result with unread citations has one bounded
coverage correction, as described above. The extraction schema represents optional severity as `anyOf` with a
string enum and a separate null branch. Copilot's structured-output validator
rejects the equivalent nullable type-array plus enum form with HTTP 400.
The accepted severities and local validation are unchanged.
Runtime diagnostics retain the stage, model, allowlisted error category
and code, HTTP error status, and an allowlisted validation classification
(unsupported schema keyword, missing schema type, invalid schema, or unsupported
response format). Provider messages, stacks, and arbitrary diagnostic fields are
not saved. Error and cleanup events cannot emit successful response progress.
Extraction sends explicit nullable types and a strict shape-only schema.
Numeric and array bounds are described in the wire schema and enforced locally,
along with exact report excerpts, selected paths, and checked source citations.
This follows the [Claude raw schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).
The pinned Copilot SDK forwards the RPC schema without the Anthropic SDK's
constraint transformation. The saved HTTP 400 alone does not prove which schema
field the provider rejected; no live model call is part of the regression tests.
The saved-report viewport renders fenced `diff` lines with distinct
added, removed, and hunk colors without changing saved Markdown or the
ordinary prompt Markdown renderer. The PTY fixture checks the actual
terminal colors and hidden fences.
The backend also checks that a failed master retains each completed review
and its raw reply, and that a failed-reviewer challenge is repaired
without restarting Fleet. The master can challenge one original active reviewer
per recipient per round using cited evidence from a different successful
review. Guide sends the question to that reviewer's existing SDK session.
There are at most two rounds; a second round needs new evidence from a
first-round reply. Private `docs/review` evidence retains questions, replies,
master decisions, and the final synthesis; unresolved challenges mark the
combined review incomplete.
Fleet's worker prompt explicitly covers
uncommitted changes with equal base and HEAD; a fake SDK checks the
15-minute Fleet budget including startup, the reserved two-minute recovery
window, per-attempt limits, cancellation, and expiry without new requests.
The recovery window also applies when the primary model request times out or
reaches idle without final text. An existing report pair is validated even when
final text is absent. Otherwise, at most two recovery requests use the same six
workers, deadline, and call budget. Empty recovery replies consume an attempt;
oversized replies, cancellation, and boundary failures are not recoverable.
Timeout recovery first aborts the request and waits for the SDK call to settle; it
never overlaps requests or starts new workers. Repair prompts include report
validation errors. The first two rejected JSON submissions retain the matching
Markdown revision and validation error in private artifacts. Corrected reports
still pass the full schema, coverage, and worker-result checks.
Completed `read_agent` results are saved once per approved worker in private
mode-0600 `fleet-worker-N.json` artifacts. Each artifact records the worker ID,
lens, pinned model, and read source. These writes must settle before report
success, artifact capture, and workspace removal. Write failures block approval;
saved worker text remains evidence, not a validated report or all-clear.
The entry point keeps the original error in the message
alongside the retained workspace path.
Snapshot tests also cover a worktree behind or diverged from main: only
changes since the common ancestor and local edits enter the patch, and a
changed main tip invalidates confirmation before model work. The review
screen labels the main tip and the effective review base separately.
Entry tests cover detached-HEAD labels without swallowing unrelated Git errors.
Capture tests cover the 1,024-path cap, shared 60-second deadline, symlink
patches without target reads, and unsupported entries. Skill tests cover
entry/depth/byte limits, the 30-second freeze pass, refresh budget resets,
and cooperative five-second cleanup with retained-path diagnostics.
The Review PTY fixture uses production choices and IDs, so its 80-column
compact-tab assertions exercise the same identifiers as the real selector.
The fake SDK also verifies that Fleet JSON with `pr: null` and an abbreviated
Markdown field is bound to the trusted base/HEAD, actual run timestamps,
and saved full Markdown,
while invalid worker or finding data remains rejected.
Report-tool contracts route differing reviewer-suggested filenames to one
owned pair, reject traversal and oversize content, and allow an identical
Markdown or JSON retry without rewriting it; conflicting retries fail.
The backend also prompts for an unread completed Fleet worker before saving,
checks each lens's dispatched model, and rejects contradictory Markdown counts.
Its SDK fixtures deliver `read_agent` tool events without post-tool hooks,
as the live runtime can do, and distinguish a worker's result from a
still-running or status-only reply.

## Implemented cases

Counts apply to each case, including each seed of a parameterized case.
Handoffs are recorded requests, not real harness launches.

| Interaction | Cases | Generated candidates | Queued jobs | Handoffs | Required outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| Assess repository evidence, prepare one assignment, confirm execution, review, and reopen it | 1 | 1 assignment | 0 | 1 | No assessment before source consent; no launch before a separate confirmation; exit zero still requires human review |
| Answer one engagement question with multiline paste at 64 columns and 20 rows | 1 | 0 | 0 | 0 | The answer stays local until renewed consent and reaches the next assessment unchanged |
| Prepare a human-only engagement action and reject its result | 1 | 1 assignment | 0 | 0 | No launch control; the explicit rejection is durable |
| Select sources at 64 columns and 20 rows, then exclude one before assessment | 1 | 0 | 0 | 0 | The focused path stays visible; only checked files reach the model |
| Select a Native or Sandbox profile and a non-default candidate; confirm this terminal | 2 | 3 | 0 | 1 | Exact launcher, prompt argument, cwd, and automation flag |
| Park a pending readiness probe, change the main selection, and reopen the fork | 1 | 3 | 0 | 0 | Exactly one inventory request survives parking; release reaches destination selection; cancellation launches nothing |
| Prepare customer context, pause, leave unknowns blank, review, apply, and choose Discovery | 1 | 3 | 0 | 1 | No model or command before approval; original request and exact source labels survive; queue entry is refused; both readiness checks retain the agent and required skills |
| Send Discovery directly to a Herdr pane, tab, new worktree, or existing worktree | 4 | 3 | 0 | 1 | No batch queue; exact interactive command; installed requirements rechecked in the selected directory before launch |
| Queue Council, Research, and HVE RPI; return to the main screen and press `L` | 1 | 9 | 3 | 3 | Correct skill frames and the HVE `--agent hve-core:rpi-agent` argument |
| Visit all five recommendations in seeded order; choose seeded candidates and press `L` | 2 | 15 | 5 | 5 | Every selected profile appears once, with its own prompt and launcher arguments |
| Queue all five recommendations and all three lenses; reopen a fork and press `L` | 1 | 24 | 8 | 8 | The global launch key dispatches the full queue, not only the active fork |
| Remove three seeded entries from an eight-job queue at 120 and 240 columns | 2 | 24 | 8 to 5 | 5 | The selected job stays visible; only retained job IDs launch, in queue order; profile and prompt pairs stay intact |
| Remove every entry; try `L` and Enter; cancel | 1 | 15 | 5 to 0 | 0 | Empty queues emit no allocation or launch command |
| Augment the draft with Research or Codebase before matching | 2 | 3 | 1 | 1 | The full augmented intent reaches matching, generation, optimization, and the final command |
| Augment from prompt review after one job is queued | 1 | 6 | 2 | 2 | Matching uses the new intent; the existing queued prompt does not change |
| Preview and cancel Optimize at 80x24 and 120x40 | 2 | 0 | 0 | 0 | Target, reviewers, and consent remain readable; no review before consent; cancellation preserves the original request |
| Review with a saved standalone fork | 1 | 3 | 0 | 0 | Read-only review is available; taking over the terminal stays blocked; returning to the fork does not regenerate it |
| Optimize current changes after one job is queued | 1 | 3 | 1 | 1 | All files start selected; exclusions survive back navigation; only explicitly approved findings reach the fresh agent; the queued prompt is unchanged; `L` is inactive in Optimize |
| Select a branch base, keep all files selected, then choose a fresh agent | 1 | 0 | 0 | 1 | Both tracked and untracked paths, the confirmed base, and the original task reach the selected Native profile in the same worktree |
| Open Optimize directly at 80x24 | 1 | 0 | 0 | 1 | The committed-and-uncommitted choice inspects the current branch without a base editor; no matching, generation, or source-conversation dependency |
| Correct an invalid comparison base | 1 | 0 | 0 | 0 | The failure remains visible, Enter does not submit, and `b` plus Ctrl+U allows a valid replacement |
| Confirm an empty change set | 1 | 0 | 0 | 0 | The review stays empty and never expands into repository-wide work |
| Choose uncommitted-only review | 1 | 0 | 0 | 0 | The scope excludes committed history only after that choice is explicit |
| Start the real CLI with a missing Prompt Master and traps for model/Herdr commands, standalone or with unusable Herdr context | 2 | 0 | 0 | 0 | Automatic and explicit bases select committed, staged, unstaged, and untracked files; links stay unselected and ignored files are absent; no session lookup or model initialization occurs |
| Add Matt Pocock's architecture reviewer at 80x24 | 1 | 0 | 0 | 0 | Its role is selected explicitly; a long summary cannot hide approval controls; the full report remains accessible; approval stays separate from implementation |
| Reopen a saved no-change review; inspect and restart a failed challenge at 80x24 | 2 | 0 | 0 | 0 | Failed runs have no approval controls; partial evidence remains readable; restart rechecks the target and requires model consent; reopening history makes no model calls |
| Cancel active reviewers at 80x24 | 1 | 0 | 0 | 0 | Calls are aborted; cancellation is saved; implementation stays blocked |
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
| Open Review with Ctrl-R from an empty intent or preserve a typed draft | 2 | 0 | 0 | 0 | Empty intent opens the separate review screen without matching; a draft remains unchanged with an explicit error |

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
eligible profiles; ordinary matching asserts all task-specific workflows and
five ranked results. Broad Council, Research, and HVE RPI workflows stay
available as explicit lenses, not automatic matches. The goal cases page through each candidate's task,
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
Customer workflow checks use recorded manifest/skill evidence. The separate
native `cpx` contract uses a fixture PTY and real argument/file validation,
including missing, disabled, and symlinked skills, missing agents, rejected
autonomous flags, literal leading-flag prompts, and non-terminal refusal.
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
bun run test test/source-pty.test.ts test/guide-terminal-readiness.test.ts test/guide-terminal-input.test.ts
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
and the explicit full `make test` suite runs four targets in parallel. Keep this
cap to limit nested process concurrency rather than increasing timing bounds
to compensate for full-suite load.
