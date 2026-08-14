# Trellage Native profile router

**Trellage Native** is the host-native profile family. Its `trx` router
discovers the installed launchers `cpx`, `cdx`, `cldx`, `grx`, `jcx`, `omp`,
and `prx`,
validates each launcher's machine-readable catalog, and presents one
flat interactive list.

## Install

Install the seven native launchers first. Their commands must resolve from
`PATH` to their owned runtimes under `~/.local/share/trellage/`.

Prerequisites: Bash, Node.js, and `jq`.

```sh
(cd ../trellage-codex-profiles && ./install.sh)
(cd ../trellage-copilot-profiles && ./install.sh)
(cd ../trellage-claude-profiles && ./install.sh)
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
trx --no-memory
trx --model gpt-5.6-terra
trx list
trx list --json
trx memory status
trx memory sync
```

From the repository root, run the current worktree router without replacing the
installed `trx`:

```sh
mise run trx
mise run trx -- --no-memory
mise run trx -- --model gpt-5.6-terra
mise run trx -- list --json
mise run trx -- memory status
mise run trx -- memory sync
```

`trx list` prints one `launcher/profile` and catalog description per line.
`trx list --json` emits a schema-versioned `profiles` array whose entries contain
`launcher`, `harness`, `name`, and `description`. Both forms are non-interactive
and work without a TTY. They validate all seven owned launchers and their catalogs
before producing output, so missing, redirected, or invalid launchers fail
closed.

Use the arrow keys and Enter to select a profile. `/` filters, `S` sorts, `D`
opens full details, and `M` selects an advertised or custom model for launchers
that support overrides. `H` launches the selection in a new Herdr pane when
available. Escape or Ctrl-C cancels with status 130. Remaining arguments are
forwarded unchanged after the selected launcher profile. `trx` never runs setup,
update, or repair.

`trx --no-memory` disables Deja only for the selected interactive launch. The
router removes this option before it builds picker arguments or starts the
launcher. It sets `TRELLAGE_MEMORY=off` for the selected launcher, including
Herdr-pane launches.

`trx memory status` reports the content-free Deja state for every catalog
profile in fixed launcher and catalog order. `trx memory sync` runs Deja
`prepare` then `finalize` for each profile in that same serial order. Each
profile has one result line. The summary reports all successes, failures, and
memory-off profiles; status exits nonzero for an unavailable profile and sync
exits nonzero when any profile fails. These commands use only the owned helper at
`~/.local/share/trellage/deja/deja-memory`; they do not search `PATH` for Deja.
They force `DEJA_RECALL=safe`.

Deja is enabled by default. Its shared runtime is global only to this OS user
account; every selected launcher still uses its isolated profile home and index.
`sync` does not call a model. Redacted exchange batches can still contain
sensitive prose, so treat the owner-readable local exchange as sensitive data.
`TRELLAGE_MEMORY=off` disables all Deja work; `--no-memory` is the
per-interactive-launch form. See [the Deja memory policy](../../docs/deja-memory.md)
for local-only forget and tombstones, v1 retention limits, and Deja SSH
multi-machine sync. `trx` adds no mount and no Weavekit transport.

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

`trx` adds no containment. `cpx`, `cdx`, `cldx`, `grx`, `jcx`, `omp`, and `prx`
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
Native launcher runtimes, all profile homes, the shared Deja runtime, and all
Deja state are preserved. Removing `trx` must not break direct launcher use.

## Test

```sh
bash tests/contract.sh
```
