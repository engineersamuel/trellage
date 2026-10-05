# Native Claude Code profile

`cldx` runs the host-installed
[Claude Code](https://github.com/anthropics/claude-code) executable with
isolated profiles. It uses keyless `copilot-proxy-rs` at
`http://127.0.0.1:8080`. It defaults to `claude-sonnet-5.5` at `medium` effort
and uses `claude-opus-5.5` at `max` effort when started in plan mode.

Trellage Native isolates agent state but is not a container or security
boundary.

## Requirements

- `claude`
- `curl`
- `jq`
- `copilot-proxy-rs` listening on `http://127.0.0.1:8080`

No host model credential is copied. Launch removes ambient Anthropic, Claude
OAuth, Bedrock, Vertex, AWS, Google, Azure, OpenAI, Copilot, and GitHub token
variables before setting the local proxy endpoint and non-secret auth sentinel.

## Install and use

```bash
./install.sh
cldx setup
cldx doctor
cldx
cldx -p "Reply exactly CLDX_OK"
cldx --model claude-opus-5.5 -p "Reply exactly CLDX_OPUS_OK"
cldx repair
cldx harness-update
```

## Office profiles

```bash
cldx setup office
cldx doctor office
cldx office
```

`office` installs `document-skills@anthropic-agent-skills` from the
`anthropics/skills` marketplace in its isolated Claude home. It also installs
`academic-pptx` from `Gabberflast/academic-pptx-skill` for presentation content
and structure. The shared floating-skills manager installs this explicit
selection from `skills.json`; it does not run an unpinned `npx skills add`.
The profile retains all `native-common` skills.

The chart-heavy builder is opt-in through a separate profile:

```bash
cldx setup office-charts
cldx office-charts
```

`office-charts` includes everything in `office` plus `slide-maker` from
`addsumtech/slides_maker`. It has a separate home and sessions. Installing
`office` does not install or enable this builder.

Setup and repair install or enable the document plugin. Later launches reuse
the installed plugin and cached skills, and restore a missing or disabled
managed plugin. Install, validation, and skill fetch failures stop the launch.
`doctor` and `inventory` check the document plugin without installing it.
Use `trx skills update`, then `cldx skills-update office` (or
`office-charts`) to refresh the managed skill copies. Profile state lives at
`~/.local/share/trellage/profiles/claude/<profile>/home/`. No plugin or skill
is installed in your personal `~/.claude`.

All profiles use the same Sonnet 5.5 medium / Opus 5.5 max model policy.
The `opusplan` selector uses Sonnet for normal work and Opus in plan mode.
Use `cldx office --permission-mode plan` to start in plan mode; an explicit
permission mode takes precedence over the launcher's default bypass mode.
Canonical Claude model IDs map to the proxy's dotted IDs so Claude recognizes
the 5.5 model capabilities.
The Office profiles are available for interactive use. Their catalog
headless capabilities remain conservative until profile-specific live
evidence is recorded; existing `default` evidence does not validate the
document plugin combination.

`cldx harness-update` updates the shared host Claude Code executable with its
built-in updater. It takes no profile argument, requires no profile setup or
running proxy, and does not run an agent session. It uses the shared runtime's
credential-environment scrub without adding profile, model, or proxy settings.
Updater output and failure status pass through unchanged.

In `trx admin`, select `claude / default`, then press `U` and confirm with `y`.
Native Claude updates remain separate from Claude container updates.

`cldx skills-update default` copies and verifies only managed `native-common`
skills after `trx skills update` refreshes the shared cache. It requires an
existing owned profile. It preserves custom skills, authentication, settings,
output styles, and session hooks. Missing caches, invalid ownership, unsafe
paths, and name collisions fail closed. It never fetches, starts Claude, or
checks or starts the proxy.

The installer publishes `~/.local/bin/cldx` and owns its runtime beneath
`~/.local/share/trellage/cldx/`. Claude profile state lives at:

```text
~/.local/share/trellage/profiles/claude/default/home/
```

`CLAUDE_CONFIG_DIR` points to that home. Setup completes first-run onboarding
without managing the user's theme preference in `settings.json` or changing
unrelated state. Sessions remain isolated from direct `claude` use.

Bare and explicit launches are equivalent:

```bash
cldx
cldx default
```

If the arguments do not contain `--model` or `--model=...`, `cldx` adds
`--model opusplan`. Claude Code has no separate plan-mode model setting, so
`opusplan` is the only supported way to pair one model with plan mode and
another with normal turns: plan turns resolve through the Opus family
(`claude-opus-5.5`) and every other turn through the Sonnet family
(`claude-sonnet-5.5`). Explicit model selection wins. All other arguments and
the Claude process exit status pass through unchanged.

`setup`, `repair`, and every launch pin Sonnet's `medium` effort in
`settings.json`. Claude Code supports `max` only as a session effort, not
as a saved `modelSettings` value. Starting with `--permission-mode plan`
adds `--effort max` unless an explicit `--effort` argument is present.
If you switch an existing session into plan mode, use `/effort max`;
use `/effort medium` when you return to normal work. Automatic model switching
does not change session effort. Unrelated settings and model overrides stay
user-owned. The top-level `model` and `effortLevel` are managed.

By default, launches bypass permission prompts and disallow `AskUserQuestion`,
so profiles run without waiting for interactive user input.
An explicit `--permission-mode` takes precedence over bypass mode.

Every setup, doctor, repair, and launch checks proxy health and confirms that
both `claude-sonnet-5.5` and `claude-opus-5.5` are advertised.

## Uninstall

```bash
./uninstall.sh
```

Uninstall removes only the owned runtime and command symlink. Profile state and
sessions are preserved.

## Test

```bash
make native-claude-profile
```
