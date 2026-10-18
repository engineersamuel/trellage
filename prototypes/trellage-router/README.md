# Trellage Native profile router

**Trellage Native** is the host-native profile family. Its `trx` router
uses canonical harness adapters behind `trx run`. Bare `trx` opens the same
run composer as `trx run`, and `trx list` describes that composer's harnesses
and profiles.

## Install

Install the managed private backends, then install `trx`.

Prerequisites: Bash, the pinned Bun runtime, and `jq`. External agent tools can
also require Node.js. Install the root source workspace dependencies with
`bun install --frozen-lockfile` before using a development checkout.

```sh
(cd ../trellage-copilot-profiles && ./install.sh)
(cd ../trellage-agency-profiles && ./install.sh)
(cd ../trellage-claude-profiles && ./install.sh)
(cd ../trellage-jcode-profiles && ./install.sh)
(cd ../trellage-omp-profiles && ./install.sh)
(cd ../trellage-prime-profiles && ./install.sh)
./install.sh
```

`~/.local/bin` must be on `PATH`. The `trx` installer publishes
`~/.local/bin/trx` as a symlink to its managed runtime.
Successful installation publishes the current router ownership marker.
Older installers fail closed instead of replacing the managed runtime.

The router-specific owned paths are:

```text
~/.local/share/trellage/trx/
~/.local/bin/trx
```

It also publishes the shared floating-skill manager and revision-free catalog
under `~/.local/share/trellage/common/floating-skills-runtime/`. Retained
backend installers publish the same files. It refuses symlinked, redirected,
or unrelated paths instead of replacing them.

## Use

```sh
trx
trx run agency azure
trx run copilot hve -- --prompt "Reply exactly OK"
trx run copilot tufte-vdqi
trx run fx default
trx run fx default -- ask "explain this repository"
trx run fx default --plan
trx run claude default
trx run uji default
trx run uji default --model copilot-proxy-rs/gpt-4.1 --effort high
trx run --model gpt-5.6-terra
trx list
trx list --json
trx admin
trx upgrade all --dry-run
trx upgrade all
trx upgrade all --yes
trx guide
trx guide --intent "Write a technical LinkedIn post"
trx guide --intent "$(cat /tmp/large-prompt.md)" --ui-variant pager
trx skills status
trx skills check --json
trx skills update
```

From the repository root, run the current worktree router without replacing the
installed `trx`:

Source-mode launches prepare missing or stale worktree dependencies automatically
with the pinned Bun runtime and frozen lockfile. Ready worktrees do not reinstall
dependencies. Concurrent launches wait for preparation of the same worktree and
reuse its readiness result. Generated Native tool installations, caches and
version receipts are excluded from the source fingerprint, so a profile repair
does not invalidate the worktree runtime. Preparation errors and unsafe source
paths stop the launch. Installed
`trx` runtimes still require an explicit reinstall when their contents change.

```sh
mise run trx
mise run trx -- run agency azure
mise run trx -- run copilot tufte-vdqi
mise run trx -- run claude default
mise run trx -- run --model gpt-5.6-terra
mise run trx -- list --json
mise run trx -- guide --intent "Write a technical LinkedIn post"
mise run trx -- guide "$(cat /tmp/large-prompt.md)" --ui-variant split
```

`mise run trx -- run agency azure` launches Agency without opening the
composer. Remaining arguments are forwarded to Agency's managed Copilot CLI.

Direct runs use the selected harness adapter. For example,
`mise run trx -- run claude default` does not require `cpx` or `cldx` on
`PATH`, or a valid Copilot catalog.

`trx list` prints two tables. The first table maps each harness to its built-in
presets. The second lists config, shared, and special profiles with their
harness limits and whether they are always applied. `trx list --json` emits
schema version 2 with `harnesses` and `profiles` arrays. Each harness entry
includes every profile name that `trx run HARNESS [PROFILE...]` accepts. Both
forms use the run composer's catalog, are non-interactive, and work without a TTY.

Bare `trx` and `trx run` open the run composer. The composer selects a harness,
zero or more compatible profiles, a model, an effort level, flags, and agent
arguments. Enter launches in the current pane. In a Herdr pane, `H` launches
the composed command in a new pane.
`trx guide` is separate from the run composer. It loads the composition catalog
from `run-catalog.ts`, authored profile guides, and the Herdr compatibility
ledger. It uses `gpt-5.6-sol` with medium reasoning to rank five profiles,
drafts three task briefs with `gpt-5.6-luna` at medium, then uses
`gpt-5.6-sol` at medium for Prompt Master optimization and refinement. The model session has no tools, repository
attachments, or persistent history. `--model` forces one model across all
model-backed phases; `--effort` applies one effort level across the phase
route. Positional,
`--intent`, and stdin JSON intent input accepts up to 60,000 characters.
The guide starts profile matching immediately. Press `p` during matching or
recommendations to open the supplied prompt as rendered Markdown. The default
viewer is `dashboard`; `--ui-variant` selects one of five layouts:

- `pager`: a full-width paged document.
- `split`: a Markdown heading map beside the document.
- `focus`: a centered, narrow reading column.
- `bookends`: persistent start and end anchors around the document.
- `dashboard`: prompt metrics above the document.

All layouts use Page Up and Page Down for navigation. Press `e` to edit the
raw prompt. Enter re-runs matching when the prompt changed.

**Review changes** reviews the current body of work, not prompt wording
or the repository's entire history. Run it from the worktree you want to review:

```sh
trx guide --review
trx guide --review --base main --intent "Original task and constraints"
```

Choose **Committed and uncommitted changes** to go directly to the current
worktree's files. Guide detects the comparison base from local Git metadata:
the remote default branch (preferring `origin`), `origin/main` or `main`,
`origin/master` or `master`, then the primary worktree's branch. It makes no
network request and never compares a local branch with itself. The detected
base is shown with the files; use `b` or `--base` to override it.

The scope includes changes since the base's merge-base with HEAD, plus staged
and unstaged edits. A clean working tree can therefore still have work to review.
Only when no separate base can be detected does Guide require an explicit one.
A new repository without commits shows its current files.
**Uncommitted changes only** remains an explicit alternative. An empty scope
never expands into repository-wide cleanup or silently selects the last commit.

Confirm the files, choose reviewers, and approve model use for a **read-only
review**. All eligible changed files, including
untracked files, are selected initially. Use Space to exclude unrelated files
or select them again. Ignored files, submodules, and special files remain
excluded. Skill-only reviews can include binary patches and link-target metadata
without following links. Press `b` to change the base, `p` to inspect full paths and task context,
`h` to reopen saved reviews, or `r` to refresh. Ctrl+U clears the base editor.
Up/Down, `j`/`k`, and Tab/Shift-Tab navigate choices; Page Up/Page Down scroll
the consent screen and full report.

`--review` shows three checks, none selected: **Ponytail Review**,
**Fleet Review**, and **Matt Pocock Code Review**.

Reviewers use independent, restricted Copilot SDK sessions. They inspect projections
of one frozen target. A
coordinator reads the reports and replies; it must retain rejected proposals
and unresolved disagreement rather than force consensus.
Runs use one run ID, one history record, and one combined synthesis, not two
completed reviews followed by another synthesis. Ponytail and Matt reports have
a structured extraction step; original reports remain available. Findings without
checked source citations remain read-only. Fleet retains six guarded workers per batch,
model verification, required result reads, and paired Markdown/JSON reports.
Matt runs only Standards; task context is not a verified Spec.
Fleet Review defaults to `gpt-6.1-sol` with high effort. Its six specialists
retain their existing model assignments and low effort. The combined review
coordinator defaults to `gpt-6-astra` with max effort.
Ponytail Review defaults to `claude-opus-5.5` with high effort.
After consent, all selected reviews appear as tabs with their current status.
The first selected review opens immediately. Tab/Shift+Tab or Left/Right switch
between reviews, Overview and Synthesis. PgUp/PgDn scroll the full-height content
area. Fleet worker text stays in its review tab with source labels. Live text
is unverified and bounded to the latest 8,192 characters per review; full reports remain
saved privately. Selection and scroll positions remain when the run finishes.
Press `p` to toggle full saved reports or `f` to open findings. Esc cancels a
running review and saves partial evidence.
The skill master can ask four peer questions in each of two rounds; round two
requires new evidence. The consent screen shows models, workers and sharing scope.
`--model` and `--effort` override the review models; they do not change the
eventual Native profile.
Every model request supplies its report, challenge, or decision JSON schema
through the SDK's structured-output API. Challenge and decision requests list
the required finding IDs and constrain the response count and allowed IDs.
Local validation also checks that each finding appears exactly once; failures
identify missing, repeated, or unexpected IDs and the failed review stage.
An invalid response gets one correction attempt with its validation error.
Only failed responses are repeated; valid reports and replies are retained.
Corrections reread the frozen evidence and pass the same validation before
they can be accepted. Runtime, cancellation, and evidence-budget failures
are not retried. A second invalid response stops the review and blocks approval.

Version-2 reviews, full reports and snapshots are saved under
`<absolute-worktree-git-directory>/trellage-reviews/`, outside tracked
files, using private directories and atomic mode-0600 files. Press `h` from
scope or target selection to reopen them without a model call. Interrupted
runs retain their evidence; they do not resume automatically.
Existing `.trx-review-*` reports are not migrated or treated as editing authority.

A failed review opens a failure screen with no approval controls. Partial
proposals have no final verdict. Press `p` to read the saved report or `r` to
start a new review, which inspects the target again and returns through file
selection, reviewer selection, and model consent. No model calls run merely
from pressing `r`. The saved status `incomplete` means the process failed;
`unresolved` is a finding decision from a completed review that could not
resolve an objection.

Read the findings and full report (`p`), select recommended findings with
Space, and press Enter to **approve only that selection**. No finding starts
approved. Incomplete reviews and no-change outcomes cannot launch an editor.
Then choose a Native Copilot, Codex, or Claude profile and separately confirm
execution. Reviewer agreement is not proof that a proposal is correct or that
checks have run.

Alternatively, press `l` to plan fixes with Copilot `hve`, without edit approval.
Planning can use the current terminal or a clean new Herdr worktree at the
unchanged reviewed HEAD. Incomplete reports stay incomplete. Dirty files are not copied.
The explicit **Plan then implement approved findings** action uses Copilot `hve`
with full access in a same-worktree Herdr tab. It requires saved finding approval
and a separate automatic-execution confirmation. All editing actions share
freshness, readiness, writer, lock and one-use delivery checks.
Use Left/Right in live and saved report views to select Overview, checks or Synthesis.
Live text is unverified; only its display buffer is limited.

Ctrl-R from an empty intent and Herdr's `prefix+ctrl+b` → **Review changes**
open this same flow. An ordinary shell targets its current Git worktree; the
popup supplies the invoking worktree explicitly. Setup reads no conversation,
requires no source agent or session identity, makes no model calls, and does
not prepare Prompt Master. Direct Review changes
entries defer optional Copilot, Codex, and Claude profile discovery until a
handoff is requested.
There is no existing-conversation handoff.
Supply unwritten requirements with `--intent`; existing Guide intent and
approved constraints remain separate from the reviewers' instructions.

The fresh agent runs in the **same worktree**, through the normal Native launch
path: a new pane or tab in Herdr, or the current terminal outside a popup.
Queued Guide work blocks taking over the current terminal. The request
arrives as a startup prompt, not simulated keystrokes. No new worktree is
created. Current-terminal launches reconnect all streams to the controlling
terminal, including when the original intent came from stdin.
On macOS, redirected streams reconnect to the actual terminal device rather
than the `/dev/tty` proxy, which does not support `kqueue` input polling.
Review handoffs use the same canonical startup commands in the current terminal and
Herdr. A profile's non-interactive (`headless.prompt`)
capability does not disable these interactive launches.
Herdr handoffs preserve backslashes and source quotations in both Fish and
POSIX shells.
Before launch, confirm other agents and editors have stopped. Guide
checks the saved approval, file contents, related context, index, HEAD/base,
profile readiness, and known active
Herdr writers, including after preparation and pane allocation. An owned
per-worktree lock serializes submissions. A failed or uncertain launch is
never retried automatically and may leave its allocated pane open. A saved
launch reservation also blocks duplicate delivery after a restart.
Read-only profile checks can make Herdr temporarily label the Guide itself
as an agent. A standalone Guide excludes its own pane only when Herdr confirms
that this Guide process is in that pane's foreground process group. Popup
source agents, borrowed pane IDs, and other active agents remain checked.

The agent reads related repository code, instructions, documentation, and tests
for context. Only approved findings and their paths reach the editor; broader changes must be
reported instead of silently expanding scope. It must preserve behavior and
unrelated work, and must not stage, commit, stash, reset, or discard changes.
Selected paths constrain the request, not filesystem permissions; Native
profile permissions are unchanged. A launch receipt is not completed or
verified implementation work.

Escape returns without rewriting the Guide request, approved goal, forks,
or queue. Finish or discard a pending augmentation first. Saved forks and
queued jobs do not block read-only review. They must be finished or removed
before a new agent can take
over the terminal. Symlinks, special files, and submodules cannot be selected.

**Optimize** is separate from review. Press `o` in Guide to select skills
(**First principles**, **Behavior preservation**, **Improve codebase
architecture**, **UI and CSS** from [good-css.com](https://good-css.com)) and
run them on the whole repository, not on a change set. Run them in the Copilot
SDK in this terminal (all tools and permissions approved), or hand them to a
Copilot, Codex, or Claude harness in this terminal, a new Herdr tab, or a new
Herdr worktree. Harness runs are composed with only the selected skills'
managed skills through `trx run HARNESS --no-always --skill OWNER/REPO:NAME`. Harness runs keep the harness's own permission settings.
Skills are defined in `packages/trellage-launcher/src/guide-optimize.ts`.
The architecture skill downloads its managed bundle before each run.
`mise run trx-optimize-test -- --live` runs Optimize through the real Copilot SDK
on a throwaway repository.

The non-interactive API is side-effect-free:

```sh
trx guide --intent "Write a post about AI agents" --json
trx guide --intent "Write a post about AI agents" \
  --profile native:claude/social-media --json
printf '%s' \
  '{"schemaVersion":1,"intent":"Write a post about AI agents"}' \
  | trx guide --json
```

Without `--profile`, JSON mode returns the match phase. With an exact profile
reference, it returns the generation phase. The stdin object accepts
`schemaVersion`, `intent`, and optional `profile`, `model`, `effort`,
and `workflowId` fields. A supplied workflow must belong to
the selected profile. Current match output has five enriched recommendations; older cached
responses can contain three. Generation
output has the selected profile and exactly three prompt candidates with
path-free command previews. JSON mode never launches a profile or changes
Herdr. Interactive model failures can use deterministic literal/template
fallbacks. Interactive guide mode previews the exact command and requires
confirmation before current-terminal, Herdr-pane, or Herdr-worktree handoff.
For Copilot and Codex Herdr handoffs, the selected prompt is queued in the
harness's initial interactive command. Copilot workspace-trust and Codex
hook-trust requests cannot consume a later prompt injection. Trust decisions
remain interactive.

### Firstmate

`trx run claude firstmate` and `trx run pi firstmate` start Firstmate from its
own clone, not in the caller's repository. The guide hands the selected message
over for pasting instead of passing a prompt.

The composer starts on the first harness. The arrow keys move between fields
and choices. Select compatible profiles, then set the model, effort, isolation,
and agent arguments as needed. Enter launches the composed command in the
current pane. In Herdr, `H` opens a right-hand pane in the current Git worktree
and runs the same absolute `trx run` command there. Ctrl-C cancels with status
130. The composer does not run setup, update, or repair.

### Admin harness updates

Press `A` in `trx admin` to preview **Update all harness versions and skills**,
then confirm only the available managed updates. Admin reads the composition
catalog directly, so built-in presets and applicable optional `config.toml`
profiles all appear. Harness version checks are deduplicated per shared runtime.
Lifecycle-backed rows receive bounded startup inventory checks; selecting the
inventory view loads other compositions lazily with `trx inventory HARNESS
[PROFILE...] --json`. Discovery does not update installed runtimes or skills.
Source checks may use the network. Confirmation is disabled while discovery
runs.

Current harnesses and skills are hidden. Version changes show
`current -> target`; configured version and source pins remain in force.
Failed or incomplete checks appear separately, not as available updates or
as proof that an item is current. The confirmed selection is fixed when
you press `y`; floating releases can still advance before an updater runs.
When nothing is selected, `y` does not start a maintenance run.

Native skill-only changes do not invoke a harness updater. Selected Native harness updates retain a required final managed-skill sync
for their affected profiles; these dependencies are summarized rather than
shown as unrelated skill updates. Shared-cache-only changes can run without
profile copies. `U` remains the selected harness-only maintenance action.

In `trx admin`, select a profile, press `U`, then `y` to update its harness.
The confirmation names the affected surface and number of profiles. `U`
is available for supported harnesses even when installed or latest-version
data is missing, or the last check reported the harness as current.
Lowercase `u` only refreshes version data.

Press `o` to view doctor, repair, and setup output for the selected profile.
The scrollable view includes both stdout and stderr for the retained runs.
Use PageUp/PageDown to scroll and `q` or Esc to return to the list.
Output history is kept only for the current Admin session, not in a log file.

Copilot, Codex, and Claude update once per shared host binary. Oh My Pi, JCode,
Pi Coding Agent, and Prime use `trx upgrade HARNESS PROFILE` once per shared
runtime. Grok, Uji, Fx, Headlong, and Agency are externally managed: Admin shows
their installed version when the harness exposes one, but does not offer a fake
updater. Plugin updates are not used as a substitute.

Updates run sequentially within a group and report each profile's result.
A failed profile does not stop the remaining profiles. Version data is
refreshed afterward, once per shared native runtime.
A running group cannot be started a second time.

### Global harness and skills update command

`trx upgrade all` uses the same composition catalog, planner, and sequential
queue as Admin's `A` action. The `trellage-upgrade-all` skill uses this command
rather than a second update loop. It prints managed commands and externally
managed informational entries before it asks you to type `yes` at a terminal.
Piped input is not approval. Unlike Admin's updates-only selection, this command
remains a full maintenance run. Its dry-run does not fetch update availability.

```sh
trx upgrade all --dry-run  # Preview only; no updates or version checks.
trx upgrade all           # Preview, then require terminal confirmation.
trx upgrade all --yes     # Explicitly authorize non-interactive updates.
```

`--yes` and `--dry-run` cannot be combined. Help and invalid arguments are
handled before composition loading. Invalid configuration, guides, or
compatibility data stop the operation before any update starts.

The shared queue runs Trellage-managed harness updates first, once per runtime.
It then runs the current router's `trx skills update` once. Lifecycle-backed
profiles receive their managed skill copy and verification after harness
updates, because some harness updaters rewrite skills. Config-only compositions
consume the shared composed sources and do not receive a fake legacy profile
copy. No `repair`, `setup`, or plugin update is substituted for a skills update.
The router keeps its exact executable path, including from a source worktree.

All phases use the same exclusive queue as Admin's `A` action.

The command preserves each profile's version and source pins. It reports
progress, separate harness and Native skills results, and fresh installed
versions. Independent updates continue after command or version-read
failures. If any shared skill cache refresh fails, all Native profile
copies are skipped; old cached skills are not reported as current. A
per-profile copy or verification failure does not stop the other profiles.

Unknown update authorities are reported as failures rather than silently
skipped. Known externally managed harnesses are reported as informational and
do not make the overall result fail. Harness fallback remains a failure, not a
successful update of the old harness.

Any failed harness update, shared skill cache refresh, Native skill copy
or verification, unsupported profile, unreadable installed version, or
profile not run makes the exit status nonzero. Harness counts and Native
skill counts are reported separately. A dry-run also returns nonzero if it
finds unsupported profiles, and never refreshes caches or copies skills.
Cancellation returns `130`, stops active update commands and later phases,
and does not roll back completed updates.

Installing or upgrading Trellage itself is a separate operation; this
command does neither.

`trx` fails closed if a managed lifecycle harness is absent, does not resolve
to its owned runtime, or has an invalid catalog. The run composer resolves the
same harness and profile catalog as `trx list`.

`trx run HARNESS [PROFILE...] [OPTIONS] [-- ARGS...]` launches a composition
without opening the composer. Profiles after the harness are combined in order,
and arguments after `--` pass to the harness.

Uji is available directly as `trx run uji default`. It appears in the
harness-centric `trx list`, but it is not a managed lifecycle catalog entry.
Trellage writes an isolated Uji config with the selected skills and instructions.
It routes requests through the local `copilot-proxy-rs` OpenAI Responses
endpoint and stores sessions per composition. Uji keeps using its normal data directory for sign-in credentials.
The default model is `copilot-proxy-rs/gpt-6-astra`. The first launch loads Uji's
official skills pack. Use `--model copilot-proxy-rs/ID` to select another proxy
model. Trellage also provides `proxy_preflight` (local health and model-list
checks), `repo_brief` (Git status and diff summary without file contents), and
`knowledge_search` (approved search of the local `secondbrain` index).
Knowledge search asks for approval and searches only its `system`, `projects`,
`areas`, `wiki`, `actions`, and `outputs` collections. It does not query raw
sources or private notes. `repo_brief` returns file paths and diff statistics,
not file contents.
Uji starts with its tool policy set to `default = "allow"`, so built-in file
and command tools run without an approval prompt. This is unrestricted host
execution. Use Uji's policy configuration if you need approval prompts or
restrictions.

The Lua plugin source is tracked in
`packages/trellage-runtime/src/native-run/uji-tools.lua`. Each generated Uji
composition copies it into `plugin/`; its content hash is part of the generation
identity, so a refreshed Trellage runtime installs changed tools on the next
launch without a separate plugin update step.

The first setup or launch through any Native harness fetches the
`native-common` bundle from the approved repositories' current default
branches. The shared snapshot is then reused without network access.
`trx skills status` reports the installed names. `trx skills update` is the
cache refresh used by the unified operation. It refreshes the eight caches
listed above; a failed cache update keeps that cache's previous snapshot.
It does not copy the refreshed skills into every profile on its own.
`trx skills check --json` compares all eight existing caches with freshly fetched
sources without publishing caches or copying profile skills. It returns
`{"kind":"current"}`, `{"kind":"available"}`, or
`{"kind":"unknown","diagnostic":"..."}`. A known difference returns `available`;
any other incomplete checks remain in its diagnostic. Without a known difference,
missing caches or failed checks return `unknown`, never `current`.
The installed skills CLI is required; checks never install it. Disposable staging
is under the working directory and is removed after the check.

Admin exposes this result as `skills:shared`, including Guide Prompt Master
and architecture changes that need no Native profile copies. Older routers
without this command need a normal runtime refresh.

These commands do not require backend discovery, bootstrap development
dependencies, or start an agent.

Rows show `harness / profile`. The highlighted detail pane shows the canonical
command, absolute router path, and exact JSON argument vector, including
empty or space-containing arguments, before the composition metadata and
readiness status. Selecting inventory runs `trx inventory HARNESS [PROFILE...]
--json`. Inventory can report `busy` while a lifecycle runtime owns its mutation
lock. `doctor` remains the full runtime health diagnostic.

Trellage Native adds no containment. Canonical harnesses run their selected
agents directly on the host with the permissions and safety behavior documented
for each harness. Use only trusted repositories, profiles, plugins, and arguments.

### Clean runs

`trx run HARNESS clean` launches a harness with no skills, MCP servers,
instructions, hooks, plugins, memory, or settings from trx, the repository, or
the host. trx installs, refreshes, and downloads nothing for a clean run.

Clean runs support `claude`, `codex`, `copilot`, and `pi`. Other harnesses
refuse to launch and print the reason:

- `grok` loads repository instructions, skills, agents, and MCP servers in a trusted folder.
- `omp` installs managed skills and profile overlays before every launch.
- `agency` launches its managed Copilot profile.
- `jcode` discovers repository context and cannot switch it off.
- `prime` repairs its runtime before launch and keeps its native kernel.
- `fx` uses the host `HOME` and `~/.fx` by design.
- `uji` workspace and tool isolation has not been verified.

Some harnesses need more than flags:

- Claude turns off slash commands, so `/skills` is not available in a clean run.
- Codex lists the skills it still finds before launch and disables each one, so
  none appear in the `$` picker.
- Codex refuses inside a repository that has a `.codex` directory between the
  working directory and the repository root. Codex loads it in every writable
  workspace regardless of the trust setting.
- Copilot lists its skills and MCP servers before launch and disables each one
  by name. It also turns off custom instructions, built-in MCP servers, memory,
  and the agent tools.
- Copilot needs a trusted folder, and a trusted folder always runs repository
  hooks and agents. So Copilot refuses when `.github/hooks`, `.github/copilot`,
  `.github/agents`, `.claude/settings.json`, `.claude/settings.local.json`, or
  `.claude/agents` exists between the working directory and the repository root.

`clean` is a reserved profile name. A clean run never reads or writes
`~/.config/trellage/config.toml`, and it cannot be combined with other profiles
or `--skill`. Model routing through the local proxy stays. The harness's own
built-in behavior also stays, such as built-in tools, built-in subagents, and
managed policy.

### Optional Jev key

`trx guide` and `trx admin` can load an optional `TYPESAFE_API_KEY` for Jev
decisions from the Trellage Varlock environment (by default
`~/.config/trellage`). Put the key in a mode-`0600` `.env.local` file there.
You can declare it in `.env.schema` as `# @sensitive @optional`. The router
resolves only this key and hands it to the harness process under a private name. The
router removes that name from its environment at startup, so agents that the guide
launches do not inherit the key. This also resolves Varlock function values,
such as encrypted secrets. A `TYPESAFE_API_KEY` in the process environment or
the worktree `.env` wins. A missing key is a silent no-op. An unsafe source or a Varlock
failure prints `Jev decisions stay off` and the guide continues without Jev.
`TRELLAGE_ENVIRONMENT=off` disables the loading. See
[the Guide UI integration notes](../../docs/guide-ui-integration.md#jev-decisions-and-llm-cost-gates).

### Package feeds (Microsoft-managed hosts)

Native harnesses inherit the host package-manager configuration. On
Microsoft-managed devices, public PyPI/npm registries are blocked. Keep host
defaults on Central Feed Services (CFS), for example:

```text
npm  → https://packagefeedproxy.microsoft.io/npm/
pip  → https://packagefeedproxy.microsoft.io/pypi/simple/   (pip global.index-url)
uv   → UV_DEFAULT_INDEX=https://packagefeedproxy.microsoft.io/pypi/simple/
```

`trx` does not rewrite feeds. Configure the shell/MDM once so every native
harness sees the same CFS endpoints. See the repository root `Agents.md`
section “Package feeds on Microsoft-managed devices”.

## Uninstall

```sh
./uninstall.sh
```

Uninstall removes only the owned `trx` runtime and its exact command symlink.
The shared floating-skill runtime and cache, private backend runtimes, and all
profile homes are preserved because the backends use them.

## Test

```sh
bash tests/contract.sh
```
