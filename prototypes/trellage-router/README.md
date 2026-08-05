# Trellage Native profile router

**Trellage Native** is the host-native profile family. Its `trx` router
discovers the installed launchers `cpx`, `cdx`, `grx`, and `omp`, validates
each launcher's machine-readable catalog, and presents one
flat interactive list.

## Install

Install the four native launchers first. Their commands must resolve from
`PATH` to their owned runtimes under `~/.local/share/trellage/`.

Prerequisites: Bash, Node.js, and `jq`.

```sh
(cd ../trellage-codex-profiles && ./install.sh)
(cd ../trellage-copilot-profiles && ./install.sh)
(cd ../trellage-grok-profiles && ./install.sh)
(cd ../trellage-omp-profiles && ./install.sh)
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
trx -i
trx --interactive --model gpt-5
```

Use the arrow keys and Enter to select a profile. Escape or Ctrl-C cancels with
status 130. Every argument after `-i` or `--interactive` is forwarded unchanged
after the selected launcher's profile name. `trx` never runs setup, update, or
repair. The selected launcher replaces `trx`, so child exit status and signals
remain unchanged.

`trx` fails closed if a launcher is absent, does not resolve to its owned
runtime, or has an invalid catalog. The selected native launcher performs its
own launch-time readiness checks and handles not-setup or unhealthy profiles.
Interactive use requires stdin and stderr attached to a TTY; a non-TTY
invocation exits `1`.

Rows contain only `harness / profile`. The highlighted detail pane shows the
full catalog description and that the selected launcher checks readiness before
starting. Diagnostic inventory remains available directly from launchers that
support `inventory PROFILE --json`; `trx` does not collect it on the launch
path. `doctor` remains the full runtime health diagnostic.

`trx` adds no containment. `cpx`, `cdx`, `grx`, and `omp` still run their
selected agents directly on the host with the permissions and safety behavior
documented by each launcher. Use only trusted repositories, profiles, plugins,
and arguments.

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
