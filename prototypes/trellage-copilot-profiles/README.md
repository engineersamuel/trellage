# Lightweight Copilot Profiles

`cpx` runs host-native GitHub Copilot CLI profiles with isolated `COPILOT_HOME`
directories. It preserves the real `HOME`, working directory, terminal, Git,
SSH, and Herdr environment. Profiles separate configuration and state; they are
not a security boundary.

Copilot authentication is inherited through the CLI native credential mechanism; cpx never copies ~/.copilot into a profile home.

## Requirements

- GitHub Copilot CLI 1.0.74 or later, already authenticated
- Python 3
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

The checked-in profiles are `awesome`, `compound-engineering`, `hve`,
`plannotator`, `superpowers`, and `tufte-vdqi`.

## Commands

```bash
cpx list
cpx inventory hve --json
cpx setup awesome
cpx setup compound-engineering
cpx setup hve
cpx setup plannotator
cpx setup tufte-vdqi
cpx setup --all
cpx awesome --prompt "Suggest useful repository skills"
cpx compound-engineering
cpx compound-engineering --prompt "/ce-plan Design resumable uploads"
cpx hve
cpx plannotator --prompt "Create an implementation plan as a self-contained HTML artifact"
cpx superpowers --prompt "Review this repository"
cpx tufte-vdqi --prompt "Critique this chart, then rebuild it as a static SVG"
cpx doctor awesome
cpx doctor compound-engineering
cpx doctor hve
cpx doctor plannotator
cpx doctor tufte-vdqi
cpx inventory compound-engineering --json
cpx inventory plannotator --json
cpx inventory tufte-vdqi --json
cpx update --check awesome
cpx update --check compound-engineering
cpx update --check hve
cpx update --check plannotator
cpx update --check tufte-vdqi
cpx update --check --all
cpx update compound-engineering
cpx update hve
cpx update tufte-vdqi
cpx update --all
cpx repair compound-engineering
cpx repair hve
cpx repair tufte-vdqi
```

Use `cpx list --json` for the stable machine-readable catalog, including
launcher, harness, plugin, source, marketplace, standalone MCP metadata, and a
version-gated `headless` object. Exact prompt/text-json, `--no-ask-user`
hard-deny classification, and model-override publication are advertised only
for GitHub Copilot CLI `1.0.81`. Other versions stay discoverable, but they
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
Cataloged retired plugin identities are removed during setup, launch, update,
and repair. Updates remain explicit and use native Copilot
marketplace/plugin commands.

The `plannotator` profile installs
`plannotator-effective-html@effective-html` from
[`plannotator/effective-html`](https://github.com/plannotator/effective-html).
Its health check requires the six Effective HTML package skills:
`design-artifact`, `html`, `html-diagram`, `html-plan`, `html-prototype`, and
`html-wireframe`. The plugin does not print a version in `copilot plugin list`,
so `cpx` reads its validated installed `.codex-plugin/plugin.json` for local
version state and uses the matching upstream manifest for update checks.

The opt-in `compound-engineering` profile installs
`compound-engineering@compound-engineering-plugin` from
[`EveryInc/compound-engineering-plugin`](https://github.com/EveryInc/compound-engineering-plugin).
It supplies the 33-skill brainstorm-plan-work-simplify-review-compound loop:
create repository-informed plans, ship requirements-ready work hands-off to an
open pull request with `/lfg`, and capture verified solutions so each change
makes the next easier. For best results, run `/ce-setup` once per repository,
brainstorm vague product work interactively, and give `/lfg` approved
requirements or an implementation-ready plan instead of a one-line idea.
Version checks read the validated installed `.codex-plugin/plugin.json`.
Health requires all 33 upstream runtime skills to be present and enabled. The
profile does not provision optional MCP integrations. It uses the existing
`cpx` launcher and shared `native-common` skills, but the plugin itself is
opt-in and is not part of `native-common`.

The `tufte-vdqi` profile installs
`tufte-vdqi@tufte-vdqi-marketplace` from
[`gnurio/tufte-vdqi-plugin`](https://github.com/gnurio/tufte-vdqi-plugin).
It critiques and rebuilds quantitative charts with Tufte's VDQI principles,
including lie-factor checks, chartjunk classification, chart-genre selection,
and direct labeling. Its health check requires the `tufte-chart` and
`tufte-critique` package skills. Python 3 standard-library scripts create
static SVG time series, small multiples, quartile plots, and range-frame
scatterplots, with an optional offline HTML wrapper. See the upstream
[common workflows](https://github.com/gnurio/tufte-vdqi-plugin#common-workflows).
It is not an interactive plotting system and does not provide PNG or PDF
export. The upstream repository has no root license as of this profile's
addition; Trellage links to the marketplace and does not vendor its source.

The checked-in [`catalog.json`](catalog.json) declares marketplaces, official
manifest URLs, plugins, and the empty standalone MCP lists. Installed Copilot
state is authoritative; there is no repository lock file. Built-in,
plugin-contributed, and repository-scoped capabilities remain available.

Profile homes isolate Copilot state, not host access. Selected agents and
plugins run with the host permissions available to Copilot and can read or
change the current repository and other reachable resources. Use trusted
repositories and plugins. In particular, `compound-engineering` has full host
access, and `/lfg` can commit, push, and open a pull request without an
approval pause.

## Test

```bash
bash tests/contract.sh
```

Tests replace Copilot and network access with temporary fixtures. They do not
inspect or modify real user Copilot state.
