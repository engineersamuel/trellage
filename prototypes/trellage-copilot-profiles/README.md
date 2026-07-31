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

`update --check` compares the installed plugin version reported by Copilot with
the official marketplace manifest. Launch and check never install or update a
plugin. Updates are explicit and use native Copilot marketplace/plugin commands.

The checked-in [`catalog.json`](catalog.json) declares marketplaces, official
manifest URLs, plugins, and the empty standalone MCP lists. Installed Copilot
state is authoritative; there is no repository lock file. Built-in,
plugin-contributed, and repository-scoped capabilities remain available.

## Test

```bash
bash tests/contract.sh
```

Tests replace Copilot and network access with temporary fixtures. They do not
inspect or modify real user Copilot state.
