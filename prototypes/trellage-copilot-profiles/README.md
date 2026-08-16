# Lightweight Copilot Profiles

`cpx` runs host-native GitHub Copilot CLI profiles with isolated `COPILOT_HOME`
directories. It preserves the real `HOME`, working directory, terminal, Git,
SSH, and Herdr environment. Profiles separate configuration and state; they are
not a security boundary.

Copilot authentication is inherited through the CLI native credential mechanism; cpx never copies ~/.copilot into a profile home.

## Requirements

- GitHub Copilot CLI 1.0.74 or later, already authenticated
- `jq`
- `curl`

## Install

```bash
./install.sh
cpx setup --all
```

The installer creates `~/.local/bin/cpx` and records ownership of its runtime
under `~/.local/share/trellage/cpx`. Install and uninstall refuse unrelated or
symlinked runtime roots and unrelated commands. `./uninstall.sh` removes only
owned command and runtime files; profile homes and their sessions, permissions,
and authentication state remain.

Profile homes use this layout:

```text
~/.local/share/trellage/profiles/copilot/<profile>/home/
```

The checked-in profiles are `awesome`, `hve`, and `superpowers`.

## Commands

```bash
cpx list
cpx inventory hve --json
cpx setup awesome
cpx setup hve
cpx setup --all
cpx awesome --prompt "Suggest useful repository skills"
cpx hve
cpx superpowers --prompt "Review this repository"
cpx doctor awesome
cpx doctor hve
cpx update --check awesome
cpx update --check hve
cpx update --check --all
cpx update hve
cpx update --all
cpx repair hve
```

Use `cpx list --json` for the stable machine-readable catalog, including
launcher, harness, plugin, source, marketplace, standalone MCP metadata, and a
version-gated `headless` object. Exact prompt/text-json, `--no-ask-user`
hard-deny classification, and model-override publication are advertised only
for GitHub Copilot CLI `1.0.80`. Other versions stay discoverable, but they
fall back to conservative `headless` values instead of inferred support.
These are catalog declarations, not proof that profile setup or installed
plugin state is healthy. Use `cpx doctor PROFILE` for that validation.
`cpx inventory PROFILE --json` is read-only. It reports readiness, installed
plugins/versions, exact package skills counted as `SKILL.md` files beneath the
safely validated selected plugin root, broader CLI-visible inventory entries,
and MCP names. `visibleCount` reflects Copilot's enabled `skill list` entries;
that native surface may include commands, so Trellage does not call it a package
skill count.

After installing the native launchers and the
[`trx` router](../trellage-router/README.md), run `trx` for one flat Ink
harness/profile picker. Remaining arguments are forwarded to `cpx` unchanged
after selection; `trx` never performs setup, repair, or update.

Profile launches always pass `--autopilot --allow-all --no-ask-user`, so
Copilot runs autonomously without waiting for permission or user-input prompts.

`update --check` compares the installed plugin version reported by Copilot with
the official marketplace manifest. Launch self-heals a missing cataloged plugin
and removes forbidden Superpowers variants without updating healthy plugins.
Updates remain explicit and use native Copilot marketplace/plugin commands.

The checked-in [`catalog.json`](catalog.json) declares marketplaces, official
manifest URLs, plugins, and the empty standalone MCP lists. Installed Copilot
state is authoritative; there is no repository lock file. Built-in,
plugin-contributed, and repository-scoped capabilities remain available.

Profile homes isolate Copilot state, not host access. Selected agents and
plugins run with the host permissions available to Copilot and can read or
change the current repository and other reachable resources. Use trusted
repositories and plugins.

## Test

```bash
bash tests/contract.sh
```

Tests replace Copilot and network access with temporary fixtures. They do not
inspect or modify real user Copilot state.
