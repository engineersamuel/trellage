# Lightweight Copilot Profiles

Public commands use the [`trx` router](../trellage-router/README.md). Install it alongside this canonically named private backend, which is not published on `PATH`.

`trx run copilot PROFILE` runs host-native GitHub Copilot CLI profiles with isolated `COPILOT_HOME`
directories. It preserves the real `HOME`, working directory, terminal, Git,
SSH, and Herdr environment. Profiles separate configuration and state; they are
not a security boundary.

Copilot authentication is inherited through the CLI native credential mechanism; copilot never copies ~/.copilot into a profile home.

## Requirements

- GitHub Copilot CLI 1.0.74 or later, already authenticated
- Python 3
- `jq`
- `curl`

## Install

```bash
./install.sh
trx setup copilot --all
```

The installer keeps `copilot` as a private backend and records ownership of its runtime
under `~/.local/share/trellage/copilot`. Install and uninstall refuse unrelated or
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
trx list
trx inventory copilot hve --json
trx setup copilot awesome
trx setup copilot compound-engineering
trx setup copilot hve
trx setup copilot plannotator
trx setup copilot tufte-vdqi
trx setup copilot --all
trx run copilot awesome --prompt "Suggest useful repository skills"
trx run copilot compound-engineering
trx run copilot compound-engineering --prompt "/ce-plan Design resumable uploads"
trx run copilot hve
trx run copilot plannotator --prompt "Create an implementation plan as a self-contained HTML artifact"
trx run copilot superpowers --prompt "Review this repository"
trx run copilot tufte-vdqi --prompt "Critique this chart, then rebuild it as a static SVG"
trx doctor copilot awesome
trx doctor copilot compound-engineering
trx doctor copilot hve
trx doctor copilot plannotator
trx doctor copilot tufte-vdqi
trx inventory copilot compound-engineering --json
trx inventory copilot plannotator --json
trx inventory copilot tufte-vdqi --json
trx upgrade copilot awesome --check
trx upgrade copilot compound-engineering --check
trx upgrade copilot hve --check
trx upgrade copilot plannotator --check
trx upgrade copilot tufte-vdqi --check
trx upgrade copilot --all --check
trx upgrade copilot compound-engineering
trx upgrade copilot hve
trx upgrade copilot tufte-vdqi
trx upgrade copilot --all
trx upgrade copilot hve --harness-only
trx repair copilot compound-engineering
trx repair copilot hve
trx repair copilot tufte-vdqi
```

Use `trx list --json` for the stable machine-readable catalog, including
launcher, harness, plugin, source, marketplace, standalone MCP metadata, and a
version-gated `headless` object. Exact prompt/text-json, `--no-ask-user`
hard-deny classification, and model-override publication are advertised only
for GitHub Copilot CLI `1.0.81`. Other versions stay discoverable, but they
fall back to conservative `headless` values instead of inferred support.
The installed Copilot version is cached across invocations and rechecked when
the executable or its package installation changes. `trx list --json` reads
that cache and reports conservative capabilities
on a miss. `trx guide` uses this mode at startup, then resolves current
capabilities after matching and before preparing launch commands.

These are catalog declarations, not proof that profile setup or installed
plugin state is healthy. Use `trx doctor copilot PROFILE` for that validation.
`trx inventory copilot PROFILE --json` is read-only. It reports readiness, installed
plugins/versions, exact package skills counted as `SKILL.md` files beneath the
safely validated selected plugin root, broader CLI-visible inventory entries,
and MCP names. `visibleCount` reflects Copilot's enabled `skill list` entries;
that native surface may include commands, so Trellage does not call it a package
skill count.

After installing the native launchers and the
[`trx` router](../trellage-router/README.md), run `trx` for one flat Ink
harness/profile picker. Remaining arguments are forwarded to `copilot` unchanged
after selection; the bare picker never performs setup, repair, or update.

Ordinary `trx run copilot PROFILE` launches pass `--autopilot --allow-all --no-ask-user`, so
Copilot runs autonomously without waiting for permission or user-input prompts.
Pass `--plan` immediately after the profile name to start in approval-gated
plan mode instead; this launch does not pass Autopilot or automatic approval
flags. `trx guide --review` uses this option for Copilot review handoffs.
Every profile defaults to `--model gpt-6-astra --effort low`. Plan mode uses
`gpt-6-astra` with `max` effort. Setup, repair, and launch refresh only the
managed `model`, `effortLevel`, `planModel`, and `planEffortLevel` keys in the
profile's `settings.json`, preserving other settings. Copilot restores the
session's default model and effort when you leave plan mode. Caller arguments
follow these defaults, so `--model` and `--effort` (or `--reasoning-effort`)
can select a different model or reasoning level for one launch. Lifecycle
commands do not add model or reasoning arguments.

### Interactive HVE customer workflows

Use the explicit mode for workflows that need questions and human decisions:

```sh
trx workflow-check copilot hve --agent hve-core:dt-coach \
  --require-skill dt-coaching-foundation --require-skill dt-methods \
  --require-skill dt-rpi-integration
trx run copilot hve --interactive --agent hve-core:dt-coach \
  --require-skill dt-coaching-foundation --require-skill dt-methods \
  --require-skill dt-rpi-integration -i "Help us discover the customer problem."
```

This mode requires Copilot CLI 1.0.81 or later, Python 3, a managed HVE profile,
and a terminal for both input and output. It checks the installed `plugin.json`
for a unique agent and each required skill, verifies safe nonempty entry files,
and confirms that Copilot exposes each skill as enabled from that same plugin
path. Missing, disabled, ambiguous, or symlinked entries block launch.
`workflow-check` returns JSON evidence without preparing or changing the
profile. It does not contact a model or prove the workflow ran successfully.

`interactive` checks before and after normal managed-profile preparation.
It uses the usual model and effort defaults but does **not** add `--autopilot`,
`--allow-all`, or `--no-ask-user`. Copilot's normal permission settings still
apply. It accepts only `--agent`, repeated `--require-skill`, `-i`, `--model`,
and `--effort`; headless and autonomous options are rejected. Piped input and
unattended batch use are rejected. Ordinary `trx run copilot hve` remains autonomous.

Use [the Native HVE guide](../../profile-guides/native/copilot/hve.md) for the
Discovery, Experiment, BRD, PRD, UX, architecture, and planning mappings.
Those agents retain their own references and approval rules. Meeting ingestion,
publishing, tracker mutation, and automatic customer signoff are not part of
this launch contract.

`update --check` compares the installed plugin version reported by Copilot with
the official marketplace manifest. Launch self-heals a missing cataloged plugin
and removes forbidden Superpowers variants without updating healthy plugins.
Cataloged retired plugin identities are removed during setup, launch, update,
and repair. Updates remain explicit and use native Copilot
marketplace/plugin commands.

`trx upgrade copilot hve --harness-only` updates the host Copilot CLI shared by all `copilot`
profiles. It runs Copilot's own `update stable` command, preserves its
output and exit status, and does not change profile homes or plugins.
It is separate from `trx upgrade copilot PROFILE`, which updates plugins only.

`trx upgrade copilot PROFILE --skills-only` copies and verifies only the existing shared
`native-common` skill cache. Run `trx skills update` first to refresh it.
The profile and its managed skill state must already exist. Custom skills
are preserved; unsafe paths, invalid ownership, and name collisions fail
closed. This command never fetches, runs Copilot, changes plugins, or changes
authentication files or permissions.

The `plannotator` profile installs
`plannotator-effective-html@effective-html` from
[`plannotator/effective-html`](https://github.com/plannotator/effective-html).
Its health check requires the six Effective HTML package skills:
`design-artifact`, `html`, `html-diagram`, `html-plan`, `html-prototype`, and
`html-wireframe`. The plugin does not print a version in `copilot plugin list`,
so `copilot` reads its validated installed `.codex-plugin/plugin.json` for local
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
`copilot` launcher and shared `native-common` skills, but the plugin itself is
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
