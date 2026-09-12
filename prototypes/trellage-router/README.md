# Trellage Native profile router

**Trellage Native** is the host-native profile family. Its `trx` router
discovers the installed launchers `agx`, `cpx`, `cdx`, `cldx`, `fmx`, `grx`,
`jcx`, `omp`, `picx`, and `prx`,
validates each launcher's machine-readable catalog, and presents one
flat interactive list.

## Install

Install the ten native launchers first. Their commands must resolve from
`PATH` to their owned runtimes under `~/.local/share/trellage/`.

Prerequisites: Bash, the pinned Bun runtime, and `jq`. External agent tools can
also require Node.js. Install the root source workspace dependencies with
`bun install --frozen-lockfile` before using a development checkout.

```sh
(cd ../trellage-codex-profiles && ./install.sh)
(cd ../trellage-copilot-profiles && ./install.sh)
(cd ../trellage-agency-profiles && ./install.sh)
(cd ../trellage-claude-profiles && ./install.sh)
(cd ../trellage-firstmate-profiles && ./install.sh)
(cd ../trellage-grok-profiles && ./install.sh)
(cd ../trellage-jcode-profiles && ./install.sh)
(cd ../trellage-omp-profiles && ./install.sh)
(cd ../trellage-picx-profiles && ./install.sh)
(cd ../trellage-prime-profiles && ./install.sh)
./install.sh
```

`~/.local/bin` must be on `PATH`. The `trx` installer publishes
`~/.local/bin/trx` as a symlink to its managed runtime.
Successful installation migrates the router runtime to ownership generation
v2. Older v1 worktree installers then fail closed instead of replacing newer
profile guides or launcher compatibility data.

The router-specific owned paths are:

```text
~/.local/share/trellage/trx/
~/.local/bin/trx
```

It also publishes the shared floating-skill manager and revision-free catalog
under `~/.local/share/trellage/common/floating-skills-runtime/`. Native
launcher installers publish the same files. It refuses symlinked, redirected,
or unrelated paths instead of replacing them.

## Use

```sh
trx
trx --profile agency
trx run cpx hve -- --prompt "Reply exactly OK"
trx run cpx tufte-vdqi
trx run cldx default
trx --model gpt-5.6-terra
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

```sh
mise run trx
mise run trx -- --profile agency
mise run trx -- run cpx tufte-vdqi
mise run trx -- run cldx default
mise run trx -- --model gpt-5.6-terra
mise run trx -- list --json
mise run trx -- guide --intent "Write a technical LinkedIn post"
mise run trx -- guide "$(cat /tmp/large-prompt.md)" --ui-variant split
```

`mise run trx -- --profile agency` directly launches
`agx/trellage-azure` without opening the picker. Remaining arguments are
forwarded to Agency's managed Copilot CLI.

`trx list` prints one `launcher/profile` and catalog description per line.
`trx list --json` emits a schema-versioned `profiles` array whose entries contain
`launcher`, `harness`, `name`, `description`, `guide`, `headless`, `sandbox`,
and `herdrCompatibility`. The nested guide is projected from the installed
Markdown registry; Markdown remains the authored source. `trx` copies each
launcher's `headless` object unchanged;
it does not infer headless support from launcher names. Both forms are
non-interactive and work without a TTY. They validate all ten owned launchers
and their catalogs before producing output, so missing, redirected, or invalid
launchers fail closed.

`trx guide` is separate from the search-first bare launcher. It loads the
native and Sandbox JSON catalogs, uses `gpt-5.6-sol` with medium reasoning to
rank five profiles, drafts three prompt candidates with `gpt-5.6-luna` at
medium, then uses `gpt-5.6-sol` at medium for Prompt Master optimization and
refinement. The model session has no tools, repository attachments, or
persistent history. `--model` forces one model across all model-backed phases;
`--effort` applies one effort level across the phase route. Positional,
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

The non-interactive API is side-effect-free:

```sh
trx guide --intent "Write a post about AI agents" --json
trx guide --intent "Write a post about AI agents" \
  --profile sandbox:claude-social-media --json
printf '%s' \
  '{"schemaVersion":1,"intent":"Write a post about AI agents"}' \
  | trx guide --json
```

Without `--profile`, JSON mode returns the match phase. With an exact profile
reference, it returns the generation phase. The stdin object accepts
`schemaVersion`, `intent`, and optional `profile`, `model`, and `effort`
fields. Current match output has five enriched recommendations; older cached
responses can contain three. Generation
output has the selected profile and exactly three prompt candidates with
path-free command previews. JSON mode never launches a profile or changes
Herdr. Interactive model failures can use deterministic literal/template
fallbacks. Interactive guide mode previews the exact command and requires
confirmation before current-terminal, Herdr-pane, or Herdr-worktree handoff.
Before a Sandbox handoff, the guide checks the development resolution and
image. It automatically builds a missing or stale profile and confirms the
repaired state before it starts the destination session.
For `cpx` and `cdx` Herdr handoffs, the selected prompt is queued in the
harness's initial interactive command. Copilot workspace-trust and Codex
hook-trust requests cannot consume a later prompt injection. Trust decisions
remain interactive.

The first sorted row is selected when the launcher opens. Start typing to filter
by profile, harness, or description; no leading `/` is required. The arrow keys
move within the filtered results. Enter launches the selected profile directly
from filter mode, Escape leaves filter mode, and `/` re-enters it. From command
mode, `S` sorts, `D` opens full details, and `M` selects an advertised or custom
model for launchers that support overrides. `H`
launches the selection in a new Herdr pane when available. Ctrl-C cancels from
any mode; Escape cancels after filter mode is left. Cancellation exits with
status 130. Remaining arguments are forwarded unchanged after the selected
launcher profile. The bare picker never runs setup, update, or repair.

### Admin harness updates

Press `A` in `trx admin` to preview **Update all harness versions and skills**,
then confirm only the available updates. Discovery checks the full Native
and Container catalog, including profiles hidden by filters. It refreshes
harness version observations and checks skill availability without updating
installed runtimes, profile skills, or images. Source checks may use the network.
Confirmation is disabled while discovery runs.

Discovery uses `LAUNCHER skills-check PROFILE` for Native profiles,
`trellage skills-check PROFILE` for Containers, and `trx skills check --json`
for the shared caches. Installed launchers and the compiler must support
these commands; old installations produce incomplete-check diagnostics.
Container checks inspect an exact local image ID through an owned temporary
stopped container. They never start its entrypoint or attach host mounts.
Missing images and ambiguous ownership in older images remain unknown.

Current harnesses and skills are hidden. Version changes show
`current -> target`; configured version and source pins remain in force.
Failed or incomplete checks appear separately, not as available updates or
as proof that an item is current. The confirmed selection is fixed when
you press `y`; floating releases can still advance before an updater runs.
When nothing is selected, `y` does not start a maintenance run.

Native skill-only changes do not invoke a harness updater. A Container with
changed skills is selected for a rebuild even if its harness version matches.
Selected Native harness updates retain a required final managed-skill sync
for their affected profiles; these dependencies are summarized rather than
shown as unrelated skill updates. Shared-cache-only changes can run without
profile copies. `U` remains the selected harness-only maintenance action.

In `trx admin`, select a profile, press `U`, then `y` to update its harness.
The confirmation names the affected surface and number of profiles. `U`
is available for supported harnesses even when installed or latest-version
data is missing, or the last check reported the harness as current.
Lowercase `u` only refreshes version data.

Container updates run `trellage upgrade PROFILE --strict-harness` for every discovered
container profile with the same harness, including profiles hidden by the
current filter. This covers Claude, Codex, Copilot, Oh My Pi (`pi`),
Prime, and Headlong. Existing version pins are preserved. Failed package
resolution is reported as a failure, not as an update using the old harness.

Native updates remain separate from container updates. Copilot, Codex, Grok,
and Claude use `cpx harness-update`, `cdx harness-update`, `grx harness-update`,
and `cldx harness-update` once per shared host binary. Selecting either Codex
`youtube` or `superpowers` updates the same Codex binary for all native Codex profiles.
Grok updates the stable channel. Oh My Pi, jcode, Pi Coding Agent, and Prime
use their launcher's `update` command once per shared runtime. Firstmate
runs `fmx update PROFILE` for each profile to apply its catalog-pinned
source and overlay. Native launchers without a harness update command
do not offer this action; plugin updates are not used as a substitute.

Updates run sequentially within a group and report each profile's result.
A failed profile does not stop the remaining profiles. Version data is
refreshed afterward, once per shared native runtime or per container and
Firstmate profile. A running group cannot be started a second time.

### Global harness and skills update command

`trx upgrade all` uses the same full catalog, planner, and sequential update
queue as Admin's `A` action. The `trellage-upgrade-all` skill uses this command
rather than a second update loop. The operation updates harness versions
**and skills**. It prints the profiles, commands, unsupported entries, and
update counts before it asks you to type `yes` at a terminal. Piped input is
not approval. The catalog input and confirmation terminal are separate.
Unlike Admin's updates-only selection, this command remains a full maintenance
run. Its dry-run does not fetch update availability.

```sh
trx upgrade all --dry-run  # Preview only; no updates or version checks.
trx upgrade all           # Preview, then require terminal confirmation.
trx upgrade all --yes     # Explicitly authorize non-interactive updates.
```

`--yes` and `--dry-run` cannot be combined. Help and invalid arguments are
handled before launcher discovery. Missing, invalid, or incomplete catalogs
stop the operation before any update starts.

The shared queue runs Native harness updates first. It then runs the current
router's `trx skills update` once, refreshing all five Native skill caches:
`native-common`, Codex standard, Codex YouTube, Oh My Pi community, and guide Prompt Master.
Every Native profile, including Agency, then receives `skills-update PROFILE`
to copy and verify its configured skills. This final copy follows harness
updates because some harness updaters rewrite skills. No `repair`, `setup`,
or plugin update is substituted for a skills update. The router keeps its
exact executable path, including when it runs from a source worktree.

Container harness builds run afterward and refresh their configured skills
through the existing build path. There is no separate Container skill
mutation. All phases use the same exclusive queue as Admin's `A` action.

The command preserves each profile's version and source pins. It reports
progress, separate harness and Native skills results, and fresh installed
versions. Independent updates continue after command or version-read
failures. If any Native skill cache refresh fails, all Native profile
copies are skipped; old cached skills are not reported as current. A
per-profile copy or verification failure does not stop the other profiles
or Container updates.

Unsupported harnesses are reported rather than silently skipped. Agency
still receives skills even when its harness updater is unsupported; that
unsupported harness still makes the overall result incomplete. Container
harness fallback is a failure, not a successful rebuild of the old harness.

Any failed harness update, shared skill cache refresh, Native skill copy
or verification, unsupported profile, unreadable installed version, or
profile not run makes the exit status nonzero. Harness counts and Native
skill counts are reported separately. A dry-run also returns nonzero if it
finds unsupported profiles, and never refreshes caches or copies skills.
Cancellation returns `130`, stops active update commands and later phases,
and does not roll back completed updates.

`trellage upgrade all` remains Container-only. Installing or upgrading
Trellage itself is a separate operation; this command does neither.

`trx` fails closed if a launcher is absent, does not resolve to its owned
runtime, or has an invalid catalog. The selected native launcher performs its
own launch-time readiness checks and handles not-setup or unhealthy profiles.
The bare picker requires stdin and stderr attached to a TTY; a non-TTY
invocation exits `1`.

`trx run LAUNCHER PROFILE [-- ARGS...]` is the non-interactive routing
surface. It performs the same owned-runtime discovery and full catalog
validation as the picker, rejects unknown launcher/profile pairs, then
executes the exact owned launcher with the selected profile and unchanged
arguments. Arguments must follow `--` so router options cannot be confused
with launcher options.

The picker’s **HARNESS** and **PROFILE** columns are display labels, not a
single command-line profile name. Use the exact **Run** command in the selected
row’s detail pane. For example, `copilot / tufte-vdqi` runs as
`trx run cpx tufte-vdqi`, while `claude / default` runs as
`trx run cldx default`. From this repository, prefix the same route with
`mise run trx --`, such as `mise run trx -- run cpx tufte-vdqi`.
`--profile agency` is the only direct profile alias. Use `trx run` for exact
launcher/profile pairs.

The first setup or launch through any native launcher fetches the
`native-common` bundle from the approved repositories' current default
branches. The shared snapshot is then reused without network access.
`trx skills status` reports the installed names. `trx skills update` is the
cache refresh used by the unified operation. It refreshes the five caches
listed above; a failed cache update keeps that cache's previous snapshot.
It does not copy the refreshed skills into every profile on its own.
`trx skills check --json` compares all five existing caches with freshly fetched
sources without publishing caches or copying profile skills. It returns
`{"kind":"current"}`, `{"kind":"available"}`, or
`{"kind":"unknown","diagnostic":"..."}`. A known difference returns `available`;
any other incomplete checks remain in its diagnostic. Without a known difference,
missing caches or failed checks return `unknown`, never `current`.
The installed skills CLI is required; checks never install it. Disposable staging
is under the working directory and is removed after the check.

Admin exposes this result as `skills:shared`, including guide Prompt Master
changes that need no Native profile copies. Older routers without this command
need a normal launcher refresh.

These commands do not require launcher discovery, bootstrap development
dependencies, or start an agent.

Rows show `harness / profile`. The highlighted detail pane shows the resolved
launcher alias, absolute binary path, and exact JSON argument vector—including
empty or space-containing arguments—before the full catalog metadata and
readiness status. Diagnostic inventory remains available directly from
launchers that support `inventory PROFILE --json`; `trx` does not collect it on
the launch path. Inventory can report `busy` while a launcher owns its mutation
lock. `doctor` remains the full runtime health diagnostic.

`trx` adds no containment. `cpx`, `cdx`, `cldx`, `fmx`, `grx`, `jcx`, `omp`,
`picx`, and `prx` still run their selected agents directly on the host with
the permissions and safety behavior documented by each launcher. Use only
trusted repositories, profiles, plugins, and arguments.

### Package feeds (Microsoft-managed hosts)

Native launchers inherit the host package-manager configuration. On
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
The shared floating-skill runtime and cache, native launcher runtimes, and all
profile homes are preserved because other launchers use them.

## Test

```sh
bash tests/contract.sh
```
