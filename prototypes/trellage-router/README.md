# Trellage Native profile router

**Trellage Native** is the host-native profile family. Its `trx` router
discovers the installed launchers `cpx`, `cdx`, `cldx`, `grx`, `jcx`, `omp`,
`picx`, and `prx`,
validates each launcher's machine-readable catalog, and presents one
flat interactive list.

## Install

Install the eight native launchers first. Their commands must resolve from
`PATH` to their owned runtimes under `~/.local/share/trellage/`.

Prerequisites: Bash, Node.js, and `jq`.

```sh
(cd ../trellage-codex-profiles && ./install.sh)
(cd ../trellage-copilot-profiles && ./install.sh)
(cd ../trellage-claude-profiles && ./install.sh)
(cd ../trellage-grok-profiles && ./install.sh)
(cd ../trellage-jcode-profiles && ./install.sh)
(cd ../trellage-omp-profiles && ./install.sh)
(cd ../trellage-picx-profiles && ./install.sh)
(cd ../trellage-prime-profiles && ./install.sh)
./install.sh
```

`~/.local/bin` must be on `PATH`. The `trx` installer publishes
`~/.local/bin/trx` as a symlink to its managed runtime.

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
trx --model gpt-5.6-terra
trx list
trx list --json
trx guide
trx guide --intent "Write a technical LinkedIn post"
trx skills status
trx skills update
```

From the repository root, run the current worktree router without replacing the
installed `trx`:

```sh
mise run trx
mise run trx -- --model gpt-5.6-terra
mise run trx -- list --json
mise run trx -- guide --intent "Write a technical LinkedIn post"
```

`trx list` prints one `launcher/profile` and catalog description per line.
`trx list --json` emits a schema-versioned `profiles` array whose entries contain
`launcher`, `harness`, `name`, `description`, `guide`, `headless`, `sandbox`,
and `herdrCompatibility`. The nested guide is projected from the installed
Markdown registry; Markdown remains the authored source. `trx` copies each
launcher's `headless` object unchanged;
it does not infer headless support from launcher names. Both forms are
non-interactive and work without a TTY. They validate all eight owned launchers
and their catalogs before producing output, so missing, redirected, or invalid
launchers fail closed.

`trx guide` is separate from the search-first bare launcher. It loads the
native and Sandbox JSON catalogs, uses `gpt-5.6-sol` with medium reasoning to
rank five profiles, drafts three prompt candidates with `gpt-5.6-luna` at
medium, then uses `gpt-5.6-sol` at medium for Prompt Master optimization and
refinement. The model session has no tools, repository attachments, or
persistent history. `--model` forces one model across all model-backed phases;
`--effort` applies one effort level across the phase route.

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

The first sorted row is selected when the launcher opens. Start typing to filter
by profile, harness, or description; no leading `/` is required. The arrow keys
move within the filtered results. Enter launches the selected profile directly
from filter mode, Escape leaves filter mode, and `/` re-enters it. From command
mode, `S` sorts, `D` opens full details, and `M` selects an advertised or custom
model for launchers that support overrides. `H`
launches the selection in a new Herdr pane when available. Ctrl-C cancels from
any mode; Escape cancels after filter mode is left. Cancellation exits with
status 130. Remaining arguments are forwarded unchanged after the selected
launcher profile. `trx` never runs setup, update, or repair.

`trx` fails closed if a launcher is absent, does not resolve to its owned
runtime, or has an invalid catalog. The selected native launcher performs its
own launch-time readiness checks and handles not-setup or unhealthy profiles.
Interactive use requires stdin and stderr attached to a TTY; a non-TTY
invocation exits `1`.

The first setup or launch through any native launcher fetches the
`native-common` bundle from the approved repositories' current default
branches. The shared snapshot is then reused without network access.
`trx skills status` reports the installed names. `trx skills update` performs
the only normal refresh and atomically replaces the shared snapshot. A failed
update keeps the previous snapshot. These two commands do not require launcher
discovery and do not start an agent.

Rows show `harness / profile`. The highlighted detail pane shows the resolved
launcher alias, absolute binary path, and exact JSON argument vector—including
empty or space-containing arguments—before the full catalog metadata and
readiness status. Diagnostic inventory remains available directly from
launchers that support `inventory PROFILE --json`; `trx` does not collect it on
the launch path. Inventory can report `busy` while a launcher owns its mutation
lock. `doctor` remains the full runtime health diagnostic.

`trx` adds no containment. `cpx`, `cdx`, `cldx`, `grx`, `jcx`, `omp`, `picx`,
and `prx`
still run
their selected agents directly on the host with the permissions and safety
behavior documented by each launcher. Use only trusted repositories, profiles,
plugins, and arguments.

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
