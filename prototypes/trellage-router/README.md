# Trellage Native profile router

**Trellage Native** is the host-native profile family. Its `trx` router
discovers the installed launchers `cpx`, `cdx`, `grx`, `jcx`, `omp`, and `prx`,
validates each launcher's machine-readable catalog, and presents one
flat interactive list.

## Install

Install the six native launchers first. Their commands must resolve from
`PATH` to their owned runtimes under `~/.local/share/trellage/`.

Prerequisites: Bash, Node.js, and `jq`.

```sh
(cd ../trellage-codex-profiles && ./install.sh)
(cd ../trellage-copilot-profiles && ./install.sh)
(cd ../trellage-grok-profiles && ./install.sh)
(cd ../trellage-jcode-profiles && ./install.sh)
(cd ../trellage-omp-profiles && ./install.sh)
(cd ../trellage-prime-profiles && ./install.sh)
./install.sh
```

`~/.local/bin` must be on `PATH`. The `trx` installer publishes
`~/.local/bin/trx` as a symlink to its managed runtime.

The installer owns only:

```text
~/.local/share/trellage/trx/
~/.local/bin/trx
```

It refuses symlinked, redirected, or unrelated paths instead of replacing
them.

## Use

```sh
trx
trx --model gpt-5.6-terra
trx list
trx list --json
```

From the repository root, run the current worktree router without replacing the
installed `trx`:

```sh
mise run trx
mise run trx -- --model gpt-5.6-terra
mise run trx -- list --json
```

`trx list` prints one `launcher/profile` and catalog description per line.
`trx list --json` emits a schema-versioned `profiles` array whose entries contain
`launcher`, `harness`, `name`, and `description`. Both forms are non-interactive
and work without a TTY. They validate all six owned launchers and their catalogs
before producing output, so missing, redirected, or invalid launchers fail
closed.

Use the arrow keys and Enter to select a profile. `/` filters, `S` sorts, `D`
opens full details, and `M` selects an advertised or custom model for launchers
that support overrides. `H` launches the selection in a new Herdr pane when
available. Escape or Ctrl-C cancels with status 130. Remaining arguments are
forwarded unchanged after the selected launcher profile. `trx` never runs setup,
update, or repair.

`trx` fails closed if a launcher is absent, does not resolve to its owned
runtime, or has an invalid catalog. The selected native launcher performs its
own launch-time readiness checks and handles not-setup or unhealthy profiles.
Interactive use requires stdin and stderr attached to a TTY; a non-TTY
invocation exits `1`.

Rows show `harness / profile`. The highlighted detail pane shows the resolved
launcher alias, absolute binary path, and exact JSON argument vector—including
empty or space-containing arguments—before the full catalog metadata and
readiness status. Diagnostic inventory remains available directly from
launchers that support `inventory PROFILE --json`; `trx` does not collect it on
the launch path. `doctor` remains the full runtime health diagnostic.

`trx` adds no containment. `cpx`, `cdx`, `grx`, `jcx`, `omp`, and `prx` still run
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
Native launcher runtimes and all profile homes are preserved.

## Test

```sh
bash tests/contract.sh
```
