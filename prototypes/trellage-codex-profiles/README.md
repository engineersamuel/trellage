# Isolated Codex profiles

`cdx` runs the host Codex CLI with named, isolated user-state homes. The
catalog contains `pstack` and `superpowers`.

## Install

Prerequisites are Codex CLI 0.146.0 or later, `jq`, `curl`, Fish with
`fish_indent`, and an existing readable, writable, regular
non-symlink `~/.config/fish/config.fish`. Install with:

```sh
./install.sh
```

The installer publishes `~/.local/bin/cdx` as a symlink to the owned runtime at
`~/.local/share/trellage/cdx/`. `~/.local/bin` must already be on `PATH`.

Trellage's three native profile roots are:

```text
~/.local/share/trellage/profiles/codex/<profile>/home/
~/.local/share/trellage/profiles/copilot/<profile>/home/
~/.local/share/trellage/profiles/grok/<profile>/home/
```

Installation removes only this exact legacy Fish line when it is present:

```fish
alias cdx="codex --dangerously-bypass-approvals-and-sandbox"
```

If no explicit literal `cdx` alias or function exists, installation preserves
the Fish config bytes and mode and records that no line was removed. It
syntax-checks the file without executing it and refuses any other explicit
literal `cdx` alias or function in that file. Dynamic or escaped alias/function names
following a literal `alias` or `function` command are fail-closed as ambiguous.
Dynamic command names, `eval`, sourced files, and runtime function calls are outside
the installer analysis boundary. Reload Fish after install; an existing shell may
retain the old function until it reloads.

## Commands

```sh
cdx list
cdx inventory superpowers --json
cdx setup superpowers
cdx setup pstack
cdx setup --all
cdx superpowers
cdx pstack -p "Review this repository"
cdx --native-auth superpowers exec "Review this repository"
cdx doctor superpowers
cdx update --check superpowers
cdx update --check --all
cdx update superpowers
cdx update --all
cdx repair superpowers
```

Use `cdx list --json` for the stable machine-readable catalog, including
launcher, harness, plugin, source, marketplace, standalone MCP metadata, and a
conservative `headless` object. Trellage has no recorded live headless matrix
for Codex yet, so `cdx list --json` intentionally does not claim prompt,
question-tool control, or model-override support from the installed version.
These are catalog declarations, not proof that profile setup or installed
plugin state is healthy. Use `cdx doctor PROFILE` for that validation.
`cdx inventory PROFILE --json` is read-only. It reports readiness, installed
plugins/versions, exact package skills counted as `SKILL.md` files beneath the
selected plugin's validated cache paths, broader CLI-visible entries from static
`debug prompt-input`, and MCP names. Unrelated marketplace caches are never
scanned.

After installing the native launchers and the
[`trx` router](../trellage-router/README.md), run `trx` for one flat Ink
harness/profile picker. Remaining arguments are forwarded to `cdx` unchanged
after selection; `trx` never performs setup, repair, or update.

Profile launch always passes `--sandbox workspace-write -c
sandbox_workspace_write.network_access=true` and disables
`default_mode_request_user_input`. Interactive launches use
`--ask-for-approval on-request`, which lets Codex request permission for Git
metadata writes and other commands that must cross the workspace sandbox
boundary. Non-interactive launches use `--ask-for-approval never` so automation
cannot hang waiting for input. Codex's native OS-level sandbox (Seatbelt on
macOS, Landlock+bubblewrap on Linux) restricts writes to the workspace and temp
directories while still allowing reads and network access. Plugin code and
Codex commands can still read any host data available to the process and reach
the network. Use `cdx` only with trusted repositories and plugins. Lifecycle
commands do not add these launch flags.

Hook trust uses contextual `--dangerously-bypass-hook-trust`:

| Mode | When |
| --- | --- |
| `auto` (default) | Bypass when stdin/stdout/stderr are not a full TTY, or when `CI`, `TRELLAGE_AUTOMATION`, or `CDX_AUTOMATION=1` is set. Full interactive TTY omits the flag so Codex can use persisted `[hooks.state]` trust (and prompt once for new/changed hooks). |
| `bypass` | Always pass the flag (`CDX_HOOK_TRUST=bypass`). |
| `prompt` | Never pass the flag (`CDX_HOOK_TRUST=prompt`). |

Automated/`trx`/non-TTY launches stay unblocked. Interactive humans avoid the
permanent bypass warning when profile hook hashes are already trusted.

`setup` creates managed profile policy and installs the selected cataloged
plugin. Launch self-heals repairable managed policy, marketplace, plugin, and
cache drift while preserving profile-local state. `doctor` remains a strict
diagnostic for policy, marketplace, and plugin identity.
Doctor performs no native marketplace/plugin mutation, but may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.
`repair` restores
managed policy and a missing cataloged plugin while preserving profile-local
user state. `update --check` reads official manifests. Superpowers update uses
the native marketplace upgrade.

Default `cdx PROFILE ...` launches use the configured local `copilotproxy` and
do not require or copy `~/.codex/auth.json`.

Use `cdx --native-auth PROFILE ...` to opt into native OpenAI authentication
for one launch. This requires a valid host `codex login`, atomically refreshes
only the selected profile's `auth.json`, and does not change managed proxy configuration.
Missing or invalid native auth fails without proxy fallback. Sessions,
configuration, and other profile state remain isolated.

MCP servers are profile-local. `cdx` does not import host MCP definitions from
`~/.codex/config.toml`, and one profile's MCPs are not shared with another.
Configure MCPs by launching the selected profile explicitly.

Multiple `cdx PROFILE` Codex sessions may run at the same time against one
shared profile home, matching bare `codex` multi-instance use. The profile lock
is only held for brief prepare/cleanup windows and for lifecycle commands
(`setup`, `doctor`, `update`, `repair`). Post-exit cleanup strips only
Codex-generated project-trust stanzas from the live `config.toml` and keeps
other concurrent writes (hooks, marketplace metadata, TUI notices). If a
lifecycle command or brief prepare/cleanup must wait, `cdx` reports the
blocking PID so a wait is never silent.

Launch skips the Codex directory-trust prompt with one ephemeral
`-c 'projects={...}'` inline-table override for the launch cwd, `git`
toplevel, and main repository root (dirname of the common `.git`, required for
linked worktrees). Current Codex ignores dotted
`projects."path".trust_level=` overrides for this gate.

Launch does not write trust into `config.toml`. If Codex itself appends
project-trust during the session, post-exit cleanup removes those generated
stanzas.

On exit, cleanup strips generated project-trust stanzas and keeps normal Codex
session-live native writes (`hooks.state`, `tui.model_availability_nux`).
Marketplace/plugin/managed mutations still fail cleanup and leave live bytes
unchanged so unexpected drift stays visible.

## Uninstall

```sh
./uninstall.sh
```

Uninstall restores the exact original Fish config only if the file still has
the post-install hash recorded by the installer. When installation found no
`cdx` definition, uninstall preserves that state and does not add a line. If
the user edited Fish config, uninstall refuses and leaves both the runtime and
recovery data intact. On success it removes only the Trellage-owned `cdx`
symlink/runtime and restores the original Fish bytes and mode.
It preserves every Codex profile home, including authentication, configuration, MCPs, plugins,
sessions, memory, and permissions. When the legacy alias was restored, reload
Fish to make it visible in an existing shell.

## Tests

```sh
bash tests/contract.sh
```

The contract uses fixture homes only. It does not install into the live home or
modify the host Fish configuration.
