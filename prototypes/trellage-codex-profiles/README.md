# Isolated Codex profiles

`cdx` runs the host Codex CLI with named, isolated user-state homes. The
catalog contains `hve` and `superpowers`.

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
cdx inventory hve --json
cdx setup hve
cdx setup superpowers
cdx setup --all
cdx hve
cdx superpowers -p "Review this repository"
cdx --native-auth hve exec "Review this repository"
cdx doctor hve
cdx update --check hve
cdx update --check --all
cdx update hve
cdx update --all
cdx repair hve
```

Use `cdx list --json` for the stable machine-readable catalog, including
launcher, harness, plugin, source, marketplace, and standalone MCP metadata.
These are catalog declarations, not proof that profile setup or installed
plugin state is healthy. Use `cdx doctor PROFILE` for that validation.
`cdx inventory PROFILE --json` is read-only. It reports readiness, installed
plugins/versions, exact package skills counted as `SKILL.md` files beneath the
selected plugin's validated cache paths, broader CLI-visible entries from static
`debug prompt-input`, and MCP names. Unrelated marketplace caches are never
scanned.

After installing every launcher required by the
[`trx` router](../trellage-router/README.md), run `trx -i` for one flat
harness/profile picker. `trx` forwards remaining arguments to `cdx` unchanged
after selection and never performs setup, repair, or update.

Profile launch always passes
`--dangerously-bypass-approvals-and-sandbox`. This disables Codex approvals and
sandboxing. Plugin code and Codex commands can access and change any host data
available to the process. Use `cdx` only with trusted repositories and plugins.
Lifecycle commands do not add the bypass flag.

`setup` creates managed profile policy and installs the selected cataloged
plugin. Launch never installs, updates, or repairs anything. `doctor` validates
policy, marketplace, and plugin identity.
Doctor performs no native marketplace/plugin mutation, but may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.
`repair` restores
managed policy and a missing cataloged plugin while preserving profile-local
user state. `update --check` reads official manifests. Superpowers update uses
the native marketplace upgrade. HVE update deliberately removes and reinstalls
only `hve-core-all@hve-core`; a failed reinstall remains visible and repairable.

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

## HVE adapter boundary

Trellage owns only the small local marketplace adapter shipped at
`marketplaces/hve-core/.agents/plugins/marketplace.json`. It points Codex at the
official whole-repository Git source `https://github.com/microsoft/hve-core.git`
on `main`, with `.github/skills` fallback metadata. Trellage does not vendor or
rewrite HVE's skills. Install and reinstall publish the adapter bytes, launcher,
catalog, Fish config, and command through sequential atomic renames with guarded
rollback if a later rename or interruption fails.

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
