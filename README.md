# Trellage

Trellage resolves development agent profiles from approved floating stable
sources and runs them in isolated Docker sandboxes while preserving host
worktree and Herdr workflows. Harnesses, plugins, skills, packages, and base
images resolve when first needed or during an explicit upgrade. Trellage keeps
the last complete local result for offline reuse. Exact portable locks are an
explicit release artifact, not normal development state. Install the CLI from
`prototypes/trellage`; it defaults to `~/.local/bin/trellage`.

## Fresh Machine Setup (macOS)

These are the one-time prerequisites for a Mac that has never run Trellage. Skip anything already installed.

```bash
# 1. Docker Desktop — install from https://www.docker.com/products/docker-desktop/,
#    then launch it and wait until it reports "running".
open -a Docker
docker info >/dev/null && echo "Docker is running"

# 2. mise (task runner / tool version manager)
brew install mise

# 3. Bun (Trellage source runtime) and Node.js (external agent tools)
mise use --global bun@1.4.2
brew install node

# 4. GitHub CLI, authenticated — Trellage forwards this token into containers
brew install gh
gh auth login

# 5. GitHub Copilot CLI, authenticated — required by profiles that use
#    native Copilot auth (e.g. copilot-hve) or the shared model catalog mount
brew install copilot-cli
copilot -p "Reply exactly OK"

# 6. Shared Copilot model catalog file — every Trellage profile mounts this
#    read-only, so it must exist even as an empty JSON object
mkdir -p ~/.copilot
[ -f ~/.copilot/models.json ] || printf '{}\n' > ~/.copilot/models.json
```

## Trellage Quick Start

Prepare the locked source workspace once from the repository root:

```bash
mise trust
mise install
scripts/install-source-runtime.sh --prepare
```

Trellage runs TypeScript and TSX source through Bun. It does not need a generated
launcher bundle, guide-core output, or a profile-compiler build. Type checking
remains separate. Preparation installs frozen dependencies and records runtime
readiness; a raw `bun install` alone does not prepare a usable runtime.
See the [source-runtime decision](docs/adr/0005-bun-source-runtime.md).

```bash
cd prototypes/trellage
mise trust
mise run install-trellage
trellage validate /absolute/path/to/profile.toml
trellage build /absolute/path/to/profile.toml
trellage lock /absolute/path/to/profile.toml
trellage build --locked /absolute/path/to/profile.toml
trellage ci-verify /absolute/path/to/profile.toml
trellage
trellage --profile /absolute/path/to/profile.toml
trellage resume --profile /absolute/path/to/profile.toml
trellage resume --profile /absolute/path/to/profile.toml SESSION_ID
trellage list --json --full
trellage doctor --profile /absolute/path/to/profile.toml
trellage destroy --profile /absolute/path/to/profile.toml
trellage upgrade /absolute/path/to/profile.toml
trellage upgrade all
```

First run in a repo worktree, end to end with a bundled profile:

```bash
mise trust
mise run trellage -- validate copilot-hve
mise run trellage -- --profile copilot-hve
```

Codex native, Sandbox, and comparison profiles use the upstream Pro preset:
`gpt-6-astra` with `medium` reasoning, Luna execution subagents with `max`
reasoning, and an Astra reviewer with `low` reasoning. Up to four subagents
can run concurrently. Copilot retains Astra with `low` reasoning. Plan mode
uses Astra with `max` reasoning; Claude Graph of Loops retains its dedicated
Astra/`max` reviewer. Explicit harness model and reasoning arguments override
the default mode settings. Sandbox profiles set plan effort with
`harness.codex.plan_mode_reasoning_effort` or
`harness.copilot.plan_mode_reasoning_effort`.

## Fresh Azure VM Acceptance

Create an isolated Ubuntu 24.04 ARM64 VM, clone this repository inside the VM,
install Trellage and
[`engineersamuel/copilot-proxy-rs`](https://github.com/engineersamuel/copilot-proxy-rs)
from clean clones, and run the complete Azure acceptance matrix:

```bash
mise run azure-fresh-install -- plan
mise run azure-fresh-install -- all
mise run azure-fresh-install -- ssh
mise run azure-fresh-install -- down
```

The default VM is `Standard_D4ps_v5` in `westus2` with a 128 GiB Premium SSD.
SSH is key-only and the network security group permits port 22 only from the
detected public IPv4 address. Set `TRELLAGE_AZURE_SSH_SOURCE` to an explicit
CIDR when automatic address detection is unsuitable.

Bootstrap installs the pinned Bun runtime and prepares source dependencies on
the VM; it does not build first-party JavaScript. To test unmerged changes, set
`TRELLAGE_AZURE_APPLY_LOCAL_CHANGES=1`. This stages the complete selected source
workspace, without host `node_modules` or `dist`, then prepares dependencies
and installs the Native launchers from that source on the VM.

The acceptance workflow requires an Azure CLI login,
`COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `gh auth token`) for Native Copilot
and Firstmate GitHub access, and `COPILOT_PROXY_GITHUB_TOKEN` (or the safe
mode-0600 `~/.config/copilot-proxy-rs/github_token`) for
`copilot-proxy-rs`. It streams the tokens to the remote process and writes
them only to mode-0600 files under VM `/dev/shm`. The temporary GitHub CLI
file is removed when acceptance exits. The proxy mounts its separate tmpfs
path read-only, binds its host port to `127.0.0.1`, and disables failed
request-body logging. No host credential file is copied.

The workflow verifies one exact `OK` response from each Native pair through
`trx run`: `copilot/hve`, `codex/pstack`, `claude/default`, composed `grok/superpowers`,
`jcode/default`, `omp/default`, `pi/default`, and `prime/default`. It then builds
and verifies `trellage --profile claude-council`. For Firstmate, it avoids a
vacuous paid fleet prompt and instead verifies setup, doctor, healthy routed
inventory, the exact Firstmate source pin, and the managed overlay for both
profiles. `trx run` performs the same owned-runtime and catalog validation as
the interactive picker before it executes the selected launcher.

On Linux, installing a tool with `mise use -g` is not enough for non-login SSH
commands. The shell must also evaluate `mise activate bash` (or use the
equivalent activation for its shell) so tools such as `uv` are on `PATH`.
The Azure workflow activates mise explicitly in every remote phase.
The Linux Native Grok sandbox also requires `bubblewrap`; the workflow installs
it during cloud initialization and loads a dedicated AppArmor profile that
permits user namespaces only for `/usr/bin/bwrap`.

Each remote stage has bounded retries or timeouts. On success, evidence is
downloaded beneath
`~/.local/state/trellage-azure-fresh/evidence/<resource-group>/` and the owned
Azure resource group is deleted. On failure, the group remains available for
`ssh`, `bootstrap`, or `accept`; delete it explicitly with `down` after
diagnosis because the VM and disk remain billable.

An advertised headless prompt also builds the image automatically on first use
(this can take several minutes), runs one non-TTY prompt, and returns the
harness status. Check `trellage list --json --full` first.

Four resolution commands, four different jobs:

- `trellage build <profile>` resolves approved stable development inputs into
  a local receipt and rebuilds the image. It does not write generated lock data
  beside `profile.toml`.
- `trellage upgrade <profile>` refreshes floating inputs, builds a candidate,
  and atomically adopts the new local receipt and image. Failure preserves the
  last good installation. Add `--strict-harness` to fail if package resolution
  would retain the previous harness instead.
- `trellage lock <profile>` creates an exact portable release snapshot beside
  the profile. This is the only normal command that writes a release lock.
- `trellage build --locked <profile>` and `trellage ci-verify <profile>`
  require that exact release snapshot. They never fall back to floating
  development resolution.
- Prime is development-only for this policy today. Its `lock`,
  `build --locked`, and `ci-verify` commands fail closed until Trellage can
  lock and install the complete Prime npm and Python bootstrap closures
  offline.

Skill sources and bundles are approved in [`config.toml`](config.toml).
Profiles select bundle names with `skill_bundles`; they do not store skill
refs or digests. Wildcard sources may declare an `exclude` list for skills
that must never enter any consuming bundle and a `required` list that makes
materialization fail if an expected skill is absent. The `engineersamuel`
source requires `ui-guidelines`, and that source is part of `sandbox-common`,
`native-common`, and `comparison-common`. A skill-bearing rebuild is therefore
not byte-reproducible.

All three common bundles install
[`antislop`](https://github.com/miqdadbadjuber/anti-slop) as an always-on filter,
plus its UI, copywriting, accessibility, responsive-layout, and code-comment
skills for task-specific loading. The source uses explicit skill selections so
new upstream skills do not enter profiles automatically.

All three common bundles also include
[`i-have-adhd`](https://github.com/ayghri/i-have-adhd) for manual activation only.
Trellage preserves its manual-invocation metadata and installs the portable skill,
not the upstream plugin, hooks, or extensions. It does not add this skill to
automatic instructions. Use your harness's explicit skill interface; command
syntax differs between harnesses.

| Harness | Command in the harness conversation |
| --- | --- |
| Codex | `$i-have-adhd` |
| Claude Code, Firstmate, Grok | `/i-have-adhd` |
| Copilot, Agency | `/i-have-adhd`, subject to the compatibility note below |
| Oh My Pi, Pi, Prime | `/skill:i-have-adhd` |

On Copilot versions affected by
[github/copilot-cli#4438](https://github.com/github/copilot-cli/issues/4438),
explicitly ask the agent to read and apply the profile's
`skills/i-have-adhd/SKILL.md` file instead of using its `skill` tool. Keep the
manual-only metadata; removing it would permit automatic activation.

JCode does not enforce the upstream manual-only metadata. Its adapter therefore keeps
this skill outside JCode's automatic discovery paths. Use
`trx skill jcode i-have-adhd "PROMPT"` for a one-shot request with the skill applied.
See the [JCode manual skill instructions](prototypes/trellage-jcode-profiles/README.md#manual-output-skill)
for use in an existing interactive session. After explicit activation, the
upstream mode lasts for that session until you request `stop adhd mode` or
`normal mode`.

Headlong also ignores the manual-only metadata. Its copy stays in the private
managed store, outside both identity skill registries. In the Headlong
conversation, explicitly ask it to read and apply
`/home/agent/.headlong/.trellage/skills/i-have-adhd/SKILL.md`.
It is not registered with Headlong's `skills show` command.

Launching handles the common case on its own: `trellage --profile <profile>`
resolves and builds on first use, then reuses the matching local receipt and
image. Harness updates do not need a profile edit: profiles declare
`version = "latest"`, and `trellage upgrade <profile>` (or `upgrade all`)
re-resolves that selector, builds a candidate image, and adopts the receipt and
image atomically.

When a harness exits, Trellage stops a Sandbox container after its last harness exits.
The retained container and profile state volume are reused by the next launch.

Bundled profiles can also be selected by directory name:

```bash
trellage validate claude-research
trellage build claude-research
trellage --profile claude-research
trellage validate claude-social-media
trellage build claude-social-media
trellage --profile claude-social-media
trellage validate prime-agent
trellage build prime-agent
trellage --profile prime-agent
```

A bare profile name checks the current worktree first at
`profiles/<name>/profile.toml`, then falls back to the profile bundled with the
deployed Trellage source. Use a value ending in `.toml` or containing a path
separator for an explicit path.

# List sandbox profiles (selection catalog)

```bash
trellage list
trellage list --json
trellage list --json-full
```

Both JSON forms include a nested `guide` object for each profile. The examples,
workflows, prerequisites, and prompt templates are authored in
`profile-guides/sandbox/*.md`; JSON is only the runtime projection. Human list
output stays concise. A worktree-local `profiles/<name>/profile.toml` must pair
with `profile-guides/sandbox/<name>.md` in that worktree before it can appear in
JSON or guide mode.

The repository-root `mise.toml` prepends `prototypes/trellage` to `PATH`, so an
activated mise shell resolves a worktree-local `trellage` without changing
directories. Trust the config once per worktree; mise trust is keyed by its
absolute path:

```bash
mise trust
mise run trellage -- validate prime-agent
trellage validate prime-agent
```

`mise run trellage --` is the explicit root-level escape hatch when a shell has
not refreshed its mise environment. The installed `trellage` symlink provides
the non-mise fallback: inside a linked Trellage worktree it automatically uses
that worktree's `prototypes/trellage/trellage` and reports the selected path on
stderr. Outside linked Trellage worktrees, it continues to use its deployed
source tree. Prepare application dependencies explicitly with
`scripts/install-source-runtime.sh --prepare` in that source workspace.
Normal execution does not install missing application packages or build
compiler output.

The root mise config also installs missing declared tools when an activated shell enters the
repository. Source-tree `trellage` and `trx` launches schedule the same dependency check in the
background, so tool detection and the `uvx yt-dlp` cache warm-up do not delay startup. Concurrent
checks share a PID lock. Diagnostics are written to
`${XDG_STATE_HOME:-$HOME/.local/state}/trellage/dependency-bootstrap.log`.

`trellage upgrade all` discovers every valid bundled and current-worktree
profile, applies current-worktree name overrides, and upgrades profiles
sequentially in name order. Each profile refreshes its approved source channels
and `latest` harness selector, builds a candidate image, and atomically adopts
the matching local receipt and image. A failed profile keeps its prior receipt
and image; remaining profiles continue, and the command exits nonzero after
reporting all failures.

Run bare `trellage` to open the Ink profile launcher:

```bash
trellage
```

The picker combines valid profiles bundled with the installed Trellage source
tree and valid `<current-worktree>/profiles/<directory>/profile.toml` files into
one harness-sorted list. A current-worktree profile with the same declared name
replaces the bundled choice. A context banner distinguishes isolated Trellage
Sandbox containers from fast host-native launchers and states the native
security tradeoff. Rows stay concise while the highlighted detail card wraps
the description, harness version, active model, plugins, skills, and MCPs.
Press `D` for a scrollable full-detail view; no profile metadata is
ellipsis-truncated there. The profile remains the source of truth for those
declarations; they are not installed inventory.

Interactive selection requires a terminal. Escape or Ctrl-C cancels with status
`130`. Selection does not install, update, lock, or build a profile; the chosen
profile continues through the normal launch checks. Use `S` to sort, `/` to
filter, `M` to choose an advertised model or enter a custom model ID, `D` for
full details, and `H` to launch in a new Herdr pane. `claude-qwen-local` is the
only pinned model.

Bare profile launches open the harness TUI. Headless prompt, structured output,
resume, and override support are version-gated. Inspect
`trellage list --json --full` before using them. Trellage rejects an unsupported
request before Docker mutation and never downgrades JSONL to text.

```bash
trellage list --json --full
trellage --profile VERIFIED_PROFILE -p "hello"
trellage --profile VERIFIED_PROFILE --output-format jsonl -p "hello"
trellage resume SESSION_ID --profile VERIFIED_PROFILE -p "continue"
```

Add `--trellage-events` to a JSONL launch only when the inventory publishes
`trellage-headless-v1`. Native JSONL remains unchanged; Trellage adds one
session event and one terminal evidence event. See
[`docs/headless-contract.md`](docs/headless-contract.md).

### Claude council

`claude-council` runs Claude Sonnet 5.5 through `copilot-proxy-rs` with two Claude
Code marketplace plugins enabled by default:

- [`0xNyk/council-of-high-intelligence`](https://github.com/0xNyk/council-of-high-intelligence) (`council`) for multi-persona deliberation (`/council`)
- [`JuliusBrussee/caveman`](https://github.com/JuliusBrussee/caveman) (`caveman`) for compressed communication mode

```bash
trellage --profile claude-council
```

Claude profiles default their Opus, Sonnet, and Haiku routes to
`claude-opus-5.5`, `claude-sonnet-5.5`, and `claude-haiku-4.5`, and bake
`claude-sonnet-5.5` at `medium` effort into the container session settings.
When the resolved headless inventory publishes `modelOverride: true`, `--model`
overrides only the Opus route for that new, prompt, or resumed launch.

Requires the external `copilot-proxy-rs_default` Docker network, same as other
proxy-backed Claude profiles.

### Claude ECC

`claude-ecc` runs Claude Sonnet 5.5 through `copilot-proxy-rs` with the official
[`affaan-m/ECC`](https://github.com/affaan-m/ECC) marketplace plugin. It provides
ECC's plugin-discovered engineering skills, commands, agents, and hooks for
broad planning, implementation, debugging, review, and verification work.

```bash
trellage validate claude-ecc
trellage build claude-ecc
trellage --profile claude-ecc
make claude-ecc-image-probe
```

ECC hooks are enabled with the `minimal` profile. This preserves essential
lifecycle and safety behavior without the automatic tmux, formatting,
type-checking, and strict reminder hooks. The image therefore does not add
`tmux`.

Large plugin seeds are synchronized into persistent Claude state as one
rollback-safe transaction. The launcher reports progress when at least 1,000
managed files must be updated.

The profile installs the Claude plugin surface only. It does not import ECC's
repository `rules/` or `contexts/`, and `include_mcp = false` excludes the
root `.mcp.json` so its unpinned sample Chrome DevTools MCP cannot run. Use
`/ecc:ecc-guide` to inspect the installed catalog, `/ecc:plan` before a
substantial change, `/ecc:tdd-workflow` during implementation, and
`/ecc:code-review` plus `/ecc:verification-loop` before delivery.

Like other proxy-backed Claude profiles, it requires the external
`copilot-proxy-rs_default` Docker network.

### Claude social media skills

`claude-social-media` installs every skill from
[`charlie947/social-media-skills`](https://github.com/charlie947/social-media-skills)
through Claude Code's native marketplace plugin flow. Core skills need no credentials.
`APIFY_API_TOKEN` optionally enables Apify-backed workflows, and
`GOOGLE_AI_API_KEY` optionally enables API-backed Google AI workflows.

Set values securely outside the repository, export the variable names, then launch:

```bash
export APIFY_API_TOKEN
export GOOGLE_AI_API_KEY
trellage --profile claude-social-media
```

Trellage forwards only variables that are present to the final Claude process;
neither variable is required or stored in the profile or lock.

Trellage also completes Claude Code's first-run onboarding without managing the
user's theme preference in `settings.json`. Theme choices and unrelated Claude user
state are preserved. The current mounted worktree is pre-approved as trusted inside
the isolated container.
## Automatic Varlock Environment Loading

Trellage bundles Varlock and uses it automatically for Sandbox new, prompt,
and resume launches and for Native profile launches that declare required
environment variables. Invoke `trellage` or `trx` directly:

```bash
trellage --profile claude-research
trx run codex youtube
trx
trellage list --json --full
```

Prompt and resume launches use the same loading only when the selected profile
publishes those capabilities.

Do not prefix these commands with `varlock`. This keeps the same interface for terminals, scripts, editors, Herdr, and other applications invoking Trellage.

### Default files

The default environment directory is `$XDG_CONFIG_HOME/trellage`, or `~/.config/trellage` when `XDG_CONFIG_HOME` is unset:

```text
~/.config/trellage/
├── config.toml
├── .env.schema
└── .env.local
```

No `config.toml` is required for the default behavior. If the directory has no `.env` files, Trellage continues without Varlock. To supply the Claude Research browser extension token:

```dotenv
# ~/.config/trellage/.env.schema
# @sensitive
PLAYWRIGHT_MCP_EXTENSION_TOKEN=
```

```dotenv
# ~/.config/trellage/.env.local
PLAYWRIGHT_MCP_EXTENSION_TOKEN=replace-with-token
```

Protect the directory and value file:

```bash
chmod 700 ~/.config/trellage
chmod 600 ~/.config/trellage/.env.local
```

On launch, Trellage resolves the Varlock source before it captures host credentials. The resolved `PLAYWRIGHT_MCP_EXTENSION_TOKEN` is then forwarded only to the final Claude process, allowing the profile to expose both Playwright and Obscura. Existing process environment values take precedence over file values, so explicit credentials supplied by automation remain authoritative.

The Native `trx run codex youtube` profile uses the same source and policy. Add
`TRANSCRIPT_API_KEY` to the schema and value file:

```dotenv
# ~/.config/trellage/.env.schema
# @sensitive
TRANSCRIPT_API_KEY=
```

```dotenv
# ~/.config/trellage/.env.local
TRANSCRIPT_API_KEY=replace-with-token
```

The Codex adapter asks Varlock to inject only the environment names required by the
selected profile. It then removes the key from the launcher environment before
setup, skill, Git, Node, inventory, and other helper subprocesses run.

### Configuration

Keep secret values out of `config.toml`; it controls loading policy only:

```toml
[environment]
provider = "varlock"
enabled = true
path = "~/.config/trellage"
required = false
strict_permissions = true
```

- `enabled`: enables automatic loading. Defaults to `true`.
- `path`: selects a Varlock file or directory. Relative paths resolve from `config.toml`.
- `required`: fails the launch when the source is absent or has no `.env` files. Defaults to `false`.
- `strict_permissions`: rejects insecure directories and secret-bearing files. Defaults to `true`.

Trellage rejects symlinked sources, non-regular `.env` entries, group/world-writable configuration, and group/world-accessible secret-bearing files. For unattended applications, provision values before launch; do not use `varlock(prompt)`. Device-local encryption or a noninteractive Varlock secret-provider plugin can protect values at rest.

Use `TRELLAGE_CONFIG` to select another config file. Use `TRELLAGE_ENVIRONMENT=off` for a per-process bypass or `TRELLAGE_ENVIRONMENT=on` to override `enabled = false`. Compiler and lifecycle commands do not load secrets.

Check the resolved state without printing values:

```bash
trellage doctor --profile claude-research
```

Doctor reports `environment: varlock (ready)` when `.env.local` is available and secure. See the [prototype guide](prototypes/trellage/README.md#automatic-environment-loading) for the complete runtime details.

### Native runtime composition (`trx run`)

```fish
trx run                                   # selector: harness, profiles, model, effort
trx run pi superpowers office             # stack profiles on top of the always-on ones
trx run pi --no-always                    # clean harness without always-on profiles
trx run claude superpowers --model NAME --effort high
trx run claude superpowers --continue     # resume the latest conversation
trx run claude superpowers --resume       # pick a conversation (--resume=ID for one)
trx run grok superpowers                    # defaults to grok-4.7 with medium effort
trx run pi superpowers --dry-run          # prepare and show the launch plan only
```

Each launch composes the selected skills into a clean, content-addressed
generation under `~/.local/share/trellage/native-run` and points the harness at
it. Unpinned sources are checked every launch; a failed refresh warns and uses
the last good cache, and no cache plus no network stops the launch. Selections
are remembered per worktree, then repository, then globally.
Launch presets backed by persistent homes allow one active composed session per
harness/preset, across all worktrees. Other presets remain independent. Setup,
repair, skill updates, and runtime upgrades reject a busy preset so they cannot
replace skills used by a running session. Finish the owning operation or shut
down its session, then retry; `trx shutdown prime default` remains available.
Firstmate retains its existing per-instance fleet admission, so distinct instance
UUIDs can run concurrently while fleet and shared-resource mutations remain guarded.
Only Pi has proven selected-only isolation; Copilot, Claude, Codex, and Grok launch by
default even though unselected repository or host skills may load; pass
`--require-proven-isolation` to refuse instead. Grok still uses its native
`workspace` OS sandbox even though repository resource discovery remains visible.

Resume: conversations live in a per-composition `state/` folder that every new
generation links to, so `--continue`, `--resume` and `--resume=ID` keep working
across skill updates. Use the same harness and profiles (model and effort may
differ). After the harness exits, `trx` prints the exact resume command.
The model picker lists Frontier models first, from `http://127.0.0.1:8080/v1/models`
(override with `TRELLAGE_MODELS_URL`), cached in `~/.cache/trellage/native-run/models.json`.

Profiles with `always = true` join every run (optionally limited with
`harnesses = ["pi"]`), so one profile such as `base` holds the default skills.
A profile can also list `instructions = ["rundown"]`; each id maps to a Markdown
file declared under `[native.instructions.ID]` (`file` is relative to the config
directory). The text is written to the harness's user-instruction file: Pi
`APPEND_SYSTEM.md`, Copilot `copilot-instructions.md`, Claude `CLAUDE.md`, Codex
`AGENTS.md`, Grok `Agents.md`. See `docs/examples/trellage-config.toml`.

Grok uses `grok` from `PATH`; set `TRELLAGE_GROK_BIN` to an alternate binary.
The adapter routes model requests to `copilot-proxy-rs`, pins API-key
authentication in generated `config.toml`, and supplies a non-secret local
proxy token through `XAI_API_KEY`. It does not create, copy, or require
`auth.json`. Before launch, it records the exact canonical worktree as trusted
inside the generated Grok home and passes `--trust`; folder trust remains
enabled and other directories remain untrusted. It forwards the current `github.com` `gh`
credential immediately before launch when no explicit GitHub token is set.
Set `TRELLAGE_GROK_GH_AUTH_BRIDGE=0` to disable that bridge.
Grok does not expose a separate plan-mode effort setting. Enter plan mode with
`/plan`, then use `/effort xhigh`; normal mode defaults to `medium`.

### Native capability catalog

The shared config reader accepts `schema_version = 1` and a Native catalog
alongside `[environment]`. Existing environment-only files need no migration.
This is the configuration layer for `trx run` composition above. The
[Native discovery gate](docs/native-sandbox-research.md#6-runtime-composition-discovery-gate)
must pass before launch behavior or command ownership changes.

```toml
schema_version = 1

[native.sources.superpowers]
repository = "obra/superpowers"

[native.profiles.planning]
label = "Planning"
skills = [{ source = "superpowers", names = ["brainstorming", "writing-plans"] }]
```

Sources accept a GitHub `owner/repository` identity, plus an optional exact
`tag` or full 40-character `commit`, but not both. Repository and commit
identities are normalized to lowercase; tag spelling is preserved. Omitting a
pin declares default-branch tracking. The reader validates this intent but
fetching and caching happen in `trx run`.

Profiles list explicit skill names; no wildcard or common baseline is added.
Plugin declarations use
`plugins = [{ source = "declared-source", harness = "claude", path = "." }]`.
This records a target-specific contribution, not cross-harness plugin
compatibility. Undeclared sources, unsafe paths, unknown Native keys, and
unsupported schema versions fail config loading in both the compiler and
Native environment helper, even when environment loading is disabled.
The reader does not rewrite the user's file.

Profile source files are architecture-neutral editable intent. Development
receipts and release locks currently support native ARM64 only. `trellage`
recognizes AMD64 for future selection, but rejects it before downloads or
Docker mutation until complete AMD64 resolution support is available.
`trellage build` resolves floating development inputs for the Docker server
platform into the local cache. `trellage lock` creates the exact release
snapshot. `--locked` rejects profile, platform, artifact, and digest drift,
but it intentionally resolves current skill content at build time.

Every build publishes the canonical
`trellage-profile-<name>-<platform>:locked` tag. A profile without floating
skills also gets the content-addressed
`trellage-profile-<name>-<platform>:h-<profile-hash>-<runtime-hash>` alias and
a locked final digest. A floating profile gets neither because the same core
lock can produce different skill bytes on a later build.

A GitHub blob URL also works for release-locked builds. Trellage resolves the
revision once and fetches the profile and selected sibling release lock from
that same commit:

```bash
trellage build --locked https://github.com/engineersamuel/trellage/blob/v1.0.0/profiles/copilot-hve/profile.toml
trellage --profile https://github.com/engineersamuel/trellage/blob/v1.0.0/profiles/copilot-hve/profile.toml
```

See [the Trellage prototype guide](prototypes/trellage/README.md) for
development receipts, release locks, lifecycle details, Copilot with HVE Core,
cleanup, and verification.

## Prime Agent

The bundled `prime-agent` profile installs Prime Agent from Prime Intellect's
official stable release channel. The local development receipt records the
resolved tarball, size, and SHA-256 digest. Its common skills float, so normal
development state does not claim one final Linux/arm64 OCI digest. It routes
model traffic only through the host-managed `copilot-proxy-rs` service, fixes
the provider to `copilot-proxy-rs`, and defaults the model to
`claude-opus-5`.

```bash
trellage validate prime-agent
trellage build prime-agent
trellage --profile prime-agent
trellage doctor --profile prime-agent
```

The proxy must already be reachable on Docker network
`copilot-proxy-rs_default`. Prime receives no host model credentials; Trellage
manages its Anthropic Messages provider seed under `/home/agent/.prime/agent`
and preserves Prime sessions and other user state in the profile/worktree state
volume. The image build also prepares a Python kernel archive that each
state volume restores locally, so tool use does not depend on first-launch
access to PyPI. Every launch restores the managed provider definition so
persisted edits cannot redirect this profile to another endpoint. Use
`--model MODEL` only when the full inventory publishes
`modelOverride: true`.

Prime release snapshots are intentionally unavailable for now. The current
bootstrap can still resolve transitive npm and Python content online, so
Trellage refuses to label that state as a reproducible release lock.

## Headlong

The bundled `headlong` profile resolves the latest stable official
[`laude-institute/headlong`](https://github.com/laude-institute/headlong)
checkout when first built or explicitly upgraded. It runs as a persistent
service with identity, memory, background thinkers, and a web dashboard
published only at <http://127.0.0.1:18080>.

The image builds the resolved Rust `headlong-tui` during image creation and
installs it with `ada` on the login-shell `PATH`. Headlong starts and supervises
the dashboard by default, including after a container restart.

```bash
trellage validate headlong
trellage build headlong
trellage --profile headlong
trellage stop --profile headlong
trellage start --profile headlong
trellage destroy --profile headlong
```

Headlong uses the local `copilot-proxy-rs` service on Docker network
`copilot-proxy-rs_default`. Trellage fixes Headlong to the Anthropic Messages
route with model `claude-sonnet-5`; it does not request, forward, or store a
provider API key. Start and authenticate `copilot-proxy-rs` before the first
launch. The Headlong initializer then runs identity setup without a provider
key prompt.

Exiting the attached shell does not stop Headlong. Use `stop` to pause it and
`start` to resume it. `destroy` removes the container and its Headlong state
only after confirmation. `trellage upgrade headlong` can replace a clean
managed checkout while preserving identity state. If Headlong or
the user changed tracked or untracked source, the runtime refuses the
replacement; inspect and back up the checkout with
`trellage shell --profile headlong`.

Headlong uses the outer Trellage container as its sandbox. The profile does not
mount the Docker socket or start nested Docker, and prompt, resume, model
override, and structured-output modes remain disabled.

## Pi with Oh My Pi

The bundled `pi-oh-my-pi` profile resolves the latest stable standalone `omp`
executable from `can1357/oh-my-pi`. It is distinct from GitHub Copilot CLI:
OMP uses its native `github-copilot` provider with model `gpt-5.6-terra`. At
build time, Trellage fetches current default-branch versions of OMP's
`semantic-compression`, `system-prompts`, and `tool-prompt-optimization`
skills and seeds them into the isolated OMP state directory.

```bash
trellage validate pi-oh-my-pi
trellage build pi-oh-my-pi
trellage --profile pi-oh-my-pi
trellage doctor --profile pi-oh-my-pi
```

Authentication precedence is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`,
then `gh auth token`. Without a host token, OMP can complete its native GitHub
Copilot login interactively. Host tokens are forwarded only to the OMP process;
login and session state persist in the isolated profile/worktree state volume
under `/home/agent/.omp/agent`. The profile uses Docker `bridge`, not
`copilot-proxy-rs_default`.

The development receipt records the resolved OMP release asset URL, size, and
GitHub SHA-256 digest. Native skill content is not part of that receipt. An
explicit release lock freezes the same data; normal builds and upgrades use
the floating stable selector.

## Trellage Native (`trx`)

Use **Trellage Sandbox** for the Docker-based CLI and isolated container
profiles described above. Use **Trellage Native** for `trx` and its host-native
profile launchers. Native launchers isolate agent state but run directly on the
host.

### Fresh-machine onboarding

`trx` provides a static catalog and routes each harness to its private backend.
Install the dependencies for the harnesses you use. On a brand-new machine:

1. **Confirm `~/.local/bin` is on `PATH`.** The router installer places `trx`
   there; harness installers register private backends. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile if
   it is missing, then reload the shell.
2. **Install only the underlying agent CLIs you actually use**, each launcher
   only needs its own dependency:
   - Codex needs the `codex` CLI (`npm install -g @openai/codex`),
     Node.js 22+, npm, and `python3`.
   - GitHub Copilot needs `copilot` (`gh extension install
     github/gh-copilot` or the standalone Copilot CLI) already authenticated,
     plus `jq` and `python3`.
   - Agency needs Microsoft Agency on `PATH` or at
     `~/.config/agency/CurrentVersion/agency`, Node.js, npm, npx, and either
     complete Azure environment credentials or an existing `az login`.
   - Claude Code needs the `claude` CLI (`npm install -g
     @anthropic-ai/claude-code`) and `python3`.
   - composed Grok needs the `grok` CLI. `trx run grok` uses
     `copilot-proxy-rs`, generated API-key-only configuration, and Grok's
     native workspace sandbox; it does not require or copy an xAI login.
   - JCode, OMP, and Pi need `mise` and `curl`.
     First use resolves the latest stable runtime and records the installed
     version locally for offline reuse.
   - Prime Agent needs `mise`, Node 22+, `npm`, `curl`, `jq`, **and
     `uv`** (`mise use -g uv` if it is not already on `PATH`) to bootstrap its
     Python kernel venv.
   - Firstmate needs the `claude` CLI (`npm install -g
     @anthropic-ai/claude-code`), `git`, `gh`, `jq`, `python3`, authenticated
     host `gh` configuration, and either a Herdr pane or `tmux` for its
     backend. On first launch it detects the remaining Firstmate-specific
     tools, shows their exact versions and managed destination, and asks for
     consent before installing them under
     `~/.local/share/trellage/fmx/prerequisites/`. It does not install global
     npm packages or global agent hooks.
3. **Browse with `trx list`.** Listing does not require every harness to be
   installed. Launch with `trx run HARNESS PROFILE`.
4. Claude, Firstmate, JCode, Prime, Pi, Grok, and the default Codex provider use
   the keyless `copilot-proxy-rs` service at `http://127.0.0.1:8080`. Start
   that proxy and make sure it has a valid GitHub Copilot device-flow login
   before using those launchers. A `401` or `GitHub OAuth device flow is not
   available in this non-interactive process` error means the proxy has no
   usable cached token (it only prompts for the device flow when its stdin is
   a terminal, so a detached `docker compose up -d`/`restart` never shows the
   prompt). Re-authenticate it once, from the proxy's own repository:

   ```bash
   docker run -t --rm \
     -e COPILOT_PROXY_RS_CONFIG_DIR=/config \
     -e COPILOT_PROXY_RS_PORT=8091 \
     -v "$HOME/.config/copilot-proxy-rs:/config:rw" \
     copilot-proxy-rs:local
   ```

   Open the printed `https://github.com/login/device` URL, enter the printed
   code, and approve GitHub Copilot access. The token persists to
   `~/.config/copilot-proxy-rs/github_token`; once authorization completes,
   stop that temporary container and restart the real service (`docker
   compose restart` in the proxy's project directory) so it picks up the
   fresh token. A plain `gh auth token` value is **not** sufficient — the
   Copilot API rejects it with "Copilot token request denied" because it
   lacks the Copilot OAuth app's scope.

OMP default uses native Copilot authentication. Its keyless `local` profile
(routed to a self-hosted Qwen model, not GitHub Copilot) is a separate setup
and is not fixed by the device-flow login above.

Install the private harness backends and the `trx` router from the
repository root:

```bash
(cd prototypes/trellage-codex-profiles && ./install.sh)
(cd prototypes/trellage-copilot-profiles && ./install.sh)
(cd prototypes/trellage-agency-profiles && ./install.sh)
(cd prototypes/trellage-claude-profiles && ./install.sh)
(cd prototypes/trellage-firstmate-profiles && ./install.sh)
(cd prototypes/trellage-jcode-profiles && ./install.sh)
(cd prototypes/trellage-omp-profiles && ./install.sh)
(cd prototypes/trellage-picx-profiles && ./install.sh)
(cd prototypes/trellage-prime-profiles && ./install.sh)
(cd prototypes/trellage-router && ./install.sh)
```

Then set up each profile you plan to use and confirm it's healthy before
launching, for example:

```bash
trx setup copilot --all
trx setup agency azure
trx setup jcode
trx setup omp default
trx setup pi
trx setup codex pstack
trx setup prime
trx setup firstmate default
trx doctor copilot awesome
trx list
```

An explicit `setup` step is not required for Agency, Codex, Copilot, Claude,
JCode, OMP, Pi, or Prime; those backends self-heal on first
launch. Firstmate requires explicit setup: run `trx setup firstmate PROFILE` first so
the pinned Firstmate source and overlay are installed as an explicit,
reviewable step. Running `setup`/`doctor` ahead of time is recommended for
every launcher so missing prerequisites are reported before a session starts.

For harness versions and skills, use `trx admin`: press `A` to check the full
catalog, including profiles hidden by filters. The preview lists only known
available updates; current harnesses and skills are hidden. Version changes
show `current -> target`, with configured pins kept. Failed or incomplete
checks are listed separately and are not treated as current.
Press `y` to run the displayed selection after the checks finish.
Native skill-only updates do not run a harness updater. Container skill
changes require an image rebuild. A selected Native harness update also
synchronizes its affected profiles' managed skills afterward.
`U` still updates the selected harness group. For a full maintenance run
through the same queue, use the command below or `trellage-upgrade-all`:

```bash
trx upgrade all --dry-run  # Preview without updating harnesses or skills.
trx upgrade all            # Preview, then ask for confirmation.
trx upgrade all --yes      # Run without an interactive confirmation.
```

These actions update selected shared Native runtimes once, refresh the shared
skill caches, then copy and verify skills for affected Native profiles. Container
profiles are rebuilt with current configured skills. The final Native skill
copies cannot be overwritten by a later harness updater. Profile version and
source pins are preserved. Unsupported profiles and failures are reported;
independent updates continue. This does not install Trellage or restart
sessions. `trellage upgrade all` remains Container-only.

`config.toml` is the skill source of truth for Native, Sandbox, and comparison
profiles. Sources with an explicit commit or tag stay pinned during launch.
Unpinned sources attempt a default-branch refresh on every profile load.
A failed refresh warns and reuses a validated matching cache; without one,
the launch fails. Each running session retains its selected snapshot.

```bash
trx skills status
trx skills update                 # Refresh latest sources and verify pins.
trx skills update --check         # Report available changes.
trx skills update --upgrade-pins  # Persist newer pinned versions atomically.
```

An unsuccessful update preserves the previous cache and configuration.
Use `trx upgrade all` to update harnesses and deployed skill copies together.

Reinstall the Native launchers before refreshing skills after a catalog or
shared-helper change. For `i-have-adhd`, the updated JCode adapter must be
installed before `trx skills update`; publishing only the catalog is not enough.
Then synchronize the refreshed skills with `trx upgrade HARNESS PROFILE --skills-only`, or let its next normal launch sync the cache. Existing Sandbox and
comparison images must be rebuilt with the updated Trellage compiler and runtime.

The public command is `trx` (`~/.local/bin/trx`). Native installers retain
private backend runtimes under `~/.local/share/trellage/` and register them
outside PATH. Successful installation removes only an owned legacy launcher
symlink; unrelated executables, authentication, sessions, and profile homes stay
in place.

| Former command | Canonical command |
| --- | --- |
| `agx trellage-azure` | `trx run agency azure` |
| `cdx PROFILE` | `trx run codex PROFILE` |
| `cldx PROFILE` | `trx run claude PROFILE` |
| `cpx PROFILE` | `trx run copilot PROFILE` |
| `fmx PROFILE` | `trx run firstmate PROFILE` |
| `jcx` | `trx run jcode default` |
| `omp copilot` | `trx run omp default` |
| `omp` (local Qwen) | `trx run omp local` |
| `picx` | `trx run pi default` |
| `prx` | `trx run prime default` |
| `grx PROFILE` | `trx run grok PROFILE` |

Native lifecycle commands use the same identity, for example
`trx setup agency azure`, `trx doctor omp default`, and
`trx inventory firstmate default --json`.

Their isolated profile homes are rooted at:

```text
~/.local/share/trellage/profiles/codex/<profile>/home/
~/.local/share/trellage/profiles/copilot/<profile>/home/
~/.local/share/trellage/profiles/agency/<profile>/home/
~/.local/share/trellage/profiles/claude/default/home/
~/.local/share/trellage/profiles/jcode/default/home/
~/.local/share/trellage/profiles/prime/default/home/
~/.omp/profiles/trellage-qwen-local/
~/.local/share/trellage/profiles/pi/picx-default/
~/.local/share/trellage/profiles/firstmate/<profile>/home/
```

The native `omp` launcher is independent of the Docker `pi-oh-my-pi` profile.
It reuses a locally recorded `mise`-resolved Oh My Pi release and provides two
isolated profiles:
`local` routes every built-in model role to keyless
`copilot-proxy-rs/qwen3.6-35b-a3b-local` on
`http://127.0.0.1:8080/v1`, while `default` uses OMP's native GitHub Copilot
authentication and discovered models. It uses the same host-auth precedence as
the container profile (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then
`gh auth token`) and on macOS additionally falls back to the existing
`copilot-cli` Keychain credential. It defaults to
`github-copilot/gpt-5.6-sol:medium`:

```bash
trx setup omp local
trx setup omp default
trx doctor omp local
trx doctor omp default
trx models omp copilot-proxy-rs
trx run omp local -- -p "Reply exactly OMP_LOCAL_OK"
trx run omp default -p "Reply exactly OMP_COPILOT_OK"
trx upgrade omp --check
trx upgrade omp default
trx repair omp default
```

`trx run omp default` uses native Copilot. `trx run omp local` preserves the
former bare-`omp` local Qwen setup and its separate state.

See the [native OMP guide](prototypes/trellage-omp-profiles/README.md) for
ownership, update, repair, and uninstall behavior.

The native `pi` backend provides one `default` Pi profile with the
ordered ten-extension daily-coding set on the latest stable upstream Pi
release. Setup and explicit update resolve current stable extension packages;
ordinary launches reuse the installed profile. The launcher also provides
isolated user-scope package data, the configured TOML skills,
disabled host-MCP discovery, and `copilot-proxy-rs/gpt-6-astra:medium`. See
the [native picx guide](prototypes/trellage-picx-profiles/README.md).

Managed Codex profiles use the local proxy by default. Native OpenAI authentication
is an explicit per-launch opt-in:

```sh
trx run codex superpowers --native-auth -- exec "Review this repository"
```

The native `claude` backend runs the host `claude` executable with isolated
state and keyless `copilot-proxy-rs` at `http://127.0.0.1:8080`. It launches
the `opusplan` selector, so normal turns use `claude-sonnet-5.5` at `medium`
effort and plan-mode turns use `claude-opus-5.5`. Start with
`--permission-mode plan` for `max` effort. When changing modes in an existing
session, set `/effort max` for planning and `/effort medium` for normal work;
Claude Code cannot save per-model `max` effort. An explicit
`--model` argument wins:

```bash
trx setup claude
trx doctor claude
trx run claude default -- -p "Reply exactly CLDX_OK"
trx run claude default -- --model claude-sonnet-5.5 -p "Reply exactly CLDX_SONNET_OK"
trx repair claude
```

For Office documents and academic presentations, use `trx setup claude office`
then `trx run claude office`. It includes Anthropic's `document-skills` plugin and
`academic-pptx`. The optional chart-heavy builder is a separate
`trx run claude office-charts` profile; run `trx setup claude office-charts` to enable it.
Both profiles retain the shared native skills and use isolated homes.

No host model credentials are copied. Launch scrubs ambient provider and token
variables before setting only the local proxy environment. See the
[native Claude guide](prototypes/trellage-claude-profiles/README.md).

The native `firstmate` backend runs [Firstmate](https://github.com/kunchenguid/firstmate)
fleet orchestration directly on the host, pinned to a fixed upstream commit
(`4ad8cbaeafc109a17c1af3911867b7fe9e04e801`); ordinary launches never update
that pin, and only `trx upgrade firstmate` installs a newer catalog pin. The integration
is experimental while Firstmate has no immutable tagged release. v1 uses
Claude Code for the captain and every worker, with tmux and Herdr as its two
backends (Herdr when launched inside a valid Herdr pane, tmux otherwise).
Firstmate owns one isolated Claude home for the captain and separate isolated
Claude homes for each worker; only the captain gets the Trellage session
bridge. The first captain launch detects Firstmate's additional toolchain and,
when anything is missing, shows the locked versions and install destination
before asking for consent. Accepted installs stay under the fmx runtime rather
than using global npm. Two profiles are available:

```bash
trx setup firstmate default
trx doctor firstmate default
trx run firstmate default
trx setup firstmate pstack-workers
trx run firstmate pstack-workers
trx upgrade firstmate --check default
trx upgrade firstmate default
```

`default` keeps Firstmate's standard ship/scout brief behavior within the v1
limits above. `pstack-workers` adds only a concise pstack-derived worker
inner-loop policy (smallest-change discipline, blast-radius naming,
conditional architecture/history checks, real-artifact proof); it does not
invoke Poteto Mode, install the pstack plugin, create pstack subagents, add a
second router, or require mandatory multi-frontier review. v1 refuses all
secondmate spawns. Both profiles report `sandbox: false` — Firstmate's
autonomous workers run directly on the host and are not a container or
OS-level security boundary. See
[`docs/herdr-compatibility.json`](docs/herdr-compatibility.json) for their
current Herdr round-trip status.

The native `trx run codex pstack` profile runs Codex with
[pstack for Codex](https://github.com/Aqua-123/pstack-for-codex), created and
maintained by Aqua-123. It installs only the upstream marketplace plugin in
`~/.local/share/trellage/profiles/codex/pstack/home/`. Codex exposes its skills
with the plugin namespace, such as `$pstack-for-codex:poteto-mode`; the shorter
`$poteto-mode` name is only the upstream hook's activation marker, not the
installed skill identity. Poteto prompts use both forms. Optional pstack agent
profiles, Poteto Mode cross-turn activation, and Benny automations are not
enabled automatically.
Its Trellage identity is harness `codex` and profile
`pstack`.

```bash
trx setup codex pstack
trx doctor codex pstack
trx run codex pstack
trx upgrade codex --check pstack
trx upgrade codex pstack
```

Like all managed Codex profiles, it uses Full Access by default: no command approval
prompts and no Codex OS sandbox. Commands run with the host account's
permissions. Use Trellage Sandbox when isolation is required. Authentication
policy is unchanged. Node.js is required by upstream hooks and validation.
Bun is optional. Pstack is a Codex profile, so Trellage does not install a
`pstack` executable and does not shadow the Unix debugger with that name.

The opt-in `trx run codex youtube` profile adds only the `youtube-full` Agent Skill from
[`ZeroPointRepo/youtube-skills`](https://github.com/ZeroPointRepo/youtube-skills)
to the shared native skill set. It requires an existing
`TRANSCRIPT_API_KEY` at launch and can consume paid TranscriptAPI credits.
Setup, doctor, repair, inventory, and update do not require the key. Trellage
does not create accounts, handle OTP signup, or persist the key outside the
user-managed Varlock source.

```bash
trx setup codex youtube
trx doctor codex youtube
trx upgrade codex --check youtube
trx run codex youtube
```

After installing `trx` and the desired harness backends, list the available
harness/profile pairs or use the picker:

```bash
trx
trx list
trx list --json
trx guide
trx guide "Write a LinkedIn post about AI agents"
trx --model gpt-5.6-terra
```

Use `mise run trx -- ...` to run the router from the current worktree without
replacing the installed native command:

```bash
mise run trx
mise run trx -- run agency azure
mise run trx -- list
mise run trx -- list --json
mise run trx -- guide "Write a LinkedIn post about AI agents"
```

`mise run trx -- run agency azure` bypasses the picker and launches
`agency/azure`. Arguments after `agency` pass unchanged to the
Agency-managed Copilot CLI.

`trx list` prints `harness/profile` plus the catalog description; `--json`
returns the same discovery data with launcher and harness identity plus a
nested guide projected from `profile-guides/native/*/*.md`. `trx` reads
the static harness registry before listing or opening the picker. Picker
rows show `harness / profile`; the detail pane shows the canonical harness,
absolute binary path, exact JSON argument vector, catalog metadata, and readiness
status. After selection, it validates that profile's read-only installed
inventory before launching. Package counts come only from launcher-validated
selected plugin roots
or cache paths; `visibleCount` preserves each native CLI's broader inventory
semantics. `trx` requires a TTY; Escape or Ctrl-C returns `130`. Browsing does not set
up, repair, update, call a model, use the network, or mutate profile state.
Launching prepares the selected profile and attempts to refresh floating skills.
The native `jcode` backend runs jcode against `copilot-proxy-rs`, defaulting to
`gpt-5.6-sol` with `medium` reasoning in an isolated `JCODE_HOME`. Install and
manage it from `prototypes/trellage-jcode-profiles`.

### Profile and prompt guide

Bare `trx` remains the fast, model-free profile search. `trx guide` is a
separate Ink flow that matches an intent across both Trellage Native and
Trellage Sandbox profiles, compares five recommendations, and creates three
editable prompt candidates. An approved goal instead gets one to five
compatible recommendations and three editable execution approaches.
Matching first uses TypeSafe Jev (`jev-1.13.0`) with the complete compact
catalog. The guide reads `TYPESAFE_API_KEY` from, in order: the shell
environment, `.env` in the guide's working directory, then the Trellage user
environment directory (`$XDG_CONFIG_HOME/trellage` or `~/.config/trellage`,
file `.env.local` then `.env`). The user files must be private regular files
(mode `0600`, not symlinks); plain values only. Under `trx guide` and
`trx admin`, the router first resolves the key through Varlock from that
directory, so Varlock function values such as encrypted secrets also work
(see `docs/guide-ui-integration.md`). `TRELLAGE_ENVIRONMENT=off` skips the
user directory. Only that key is read; the guide does not load other dotenv
settings into its environment. Jev gets one three-second attempt with no
retries. Missing credentials, service failures, or invalid responses fall back
to the existing profile prefilter and Copilot matching, and the guide shows a
"Jev not in use" notice with the reason. Low fit probabilities
remain valid results; cancellation stops matching.

By default, fallback matching, Prompt Master optimization, and refinement use
`gpt-5.6-sol` with medium reasoning; candidate drafting uses `gpt-5.6-luna` with
medium reasoning. `--model` or `TRELLAGE_GUIDE_MODEL` selects the LLM for these
phases; Jev remains first. `--effort` applies to those LLM routes. Neither
override changes Jev or the Goal-me interview model. Intent input accepts
up to 60,000 characters:

```bash
trx guide --intent "Turn a technical outline into a LinkedIn post"
trx guide --intent "Review this architecture" --model claude-opus-5 --effort medium
trx guide "$(cat /tmp/large-prompt.md)" --ui-variant pager
```

For committed and working-tree changes, `trx guide --review` opens **Review
changes**. `trx guide --optimize` opens the same flow with **First principles**
and **Behavior preservation** selected; `--review` starts with no checks selected.
Both entries offer all six checks: those two built-in checks, **Improve codebase
architecture**, **Ponytail Review**, **Fleet Review**, and **Matt Pocock Code
Review**. Select any compatible combination. The two flags cannot be combined.
Both accept `--base`, `--intent`, `--model`, and `--effort`; model overrides
also apply to guarded Fleet workers, not to the eventual Native profile.

Guide's pinned `o` action, Ctrl-R at an empty intent screen, and Herdr's
**Review changes** popup open this same flow. Returning to Guide preserves its
draft, goals, forks, and queued jobs. The popup uses the invoking worktree.
Direct entries do not use profile matching, Prompt Master, or Sandbox discovery.
Optional Native profiles are discovered only when a handoff is requested;
a missing implementation profile does not block review.
Opening setup or history makes no model calls and downloads no skills.

Choose the scope and files, select checks, then confirm model use. Consent shows
the effective models, workers, sharing scope, and bounded follow-up work.
First principles and Behavior preservation use built-in prompts; architecture
adapts managed architecture skills. Ponytail looks for removable complexity,
Fleet runs six specialist passes, and Matt runs a Standards pass.
The current Guide flow has no verified spec input, so Matt runs one Standards
worker and explicitly marks the Spec axis unavailable. It does not invent
requirements or claim two workers ran. If a selected skill is missing from an
existing Native cache, Review refreshes the approved shared skill bundle once
before it starts; unsafe cache content and refresh failures stop the run.
Fleet defaults to Claude Opus 5.5, GPT-6 Sol, and Grok 4.7 (two reviewers per
model). Its guarded worker hook supplies each approved lens with the frozen
diff and pins the selected model; unknown or duplicate workers are denied.
Choose committed plus uncommitted changes with a detected local comparison base,
or uncommitted changes only. Press `b` to override the base. Comparisons use the
merge base, so commits only on the base branch stay out of scope. No fetch or
rebase is required. Detached HEAD and repositories without an initial commit
are supported where the selected checks permit them.
Staged, unstaged, deleted, and non-ignored untracked files can be selected.
Use Space to include or exclude files. An empty scope does not expand to the
repository or silently select the last commit. Skill-only reviews can include
binary patches and link-target metadata without following links; built-in and
architecture checks require supported text. Incompatible selections require an
explicit change before starting.
The confirmed target is rechecked before model work. Escape cancels a run.
All checks use projections of one frozen target, with one run ID, one history
record, and one combined synthesis. Built-in proposals receive a bounded
challenge round. Ponytail and Matt reports receive structured extraction;
their original reports remain available. Ungrounded findings stay read-only.
A partial or failed review cannot become an all-clear or authorize edits.
Matt's Standards pass uses documented standards from the review base, so
committed or uncommitted changes under review cannot set their own rules.
Evidence limits depend on the selected checks. Built-in and architecture checks
include related tracked source as context; skill-only checks do not acquire
that broader source snapshot.
Router contract fixtures are ignored so an interrupted test does not add a
copied source tree to the review. Other untracked files remain in scope.
The former 384 KiB skill-patch limit is removed. Capture retains a 32 MB
local storage bound, while model input follows discovered context, prompt,
and output limits. Net and staged/unstaged views share frozen sources.
Paged reads and fresh evidence batches cover larger inputs; cross-file checks
combine the results. Missing coverage still blocks completion, without truncation.
Large reviews can use more calls and time; consent shows the batch request ceiling.
Skill evidence capture accepts at most 1,024 untracked paths and has a 60-second
total deadline; each Git command also retains its 15-second ceiling. Untracked symlinks are
captured as link-target text without following their targets. Unsupported
special entries stop capture.
Selected skills are frozen within a 30-second pass, with at most 1,024 entries
including directories and skill roots, depth 16 (root depth zero), 1 MiB per
file, and 4 MiB total content. A permitted refresh starts a fresh pass.
Private staging cleanup stops scheduling work after five seconds and reports
any retained owned path; it does not remove the shared skill cache.
The installed Fleet skill normally asks for unmerged commits only. Guide's
restricted adapter instead passes the confirmed working-tree patches to
each Fleet specialist and explicitly permits reviews with no new commits.
Fleet has a 15-minute total budget including startup, reserving two minutes
for at most two same-coordinator report-recovery attempts of up to one minute
each. A timed-out primary request fails rather than overlapping recovery.
SDK cleanup retains its separate five-second-per-step limits.
Matt Code Review has a 15-minute model deadline; Ponytail has four minutes.
The master has four minutes total, including at most three minutes
for peer debate. Specialist text is live model output, not a verified report:
only the saved Fleet Markdown/JSON pair establishes a completed Fleet review.
Guide names any completed Fleet worker whose result was not read before the
report is saved. The coordinator can reread it once; if it remains unavailable,
the report stays partial. A completed report also needs verified per-lens
model dispatch and readable worker results. Markdown totals and coverage must
match the structured report.
Approved background tasks receive a trusted name and model. A missing worker
result returns a model-visible failure with the worker IDs, so the coordinator
can retry rather than losing the report to a generic tool error.
If the coordinator ends without the saved report pair, Guide gives that same
session up to two bounded chances to read missing workers and finish the pair.
Guide records successful worker reads from SDK tool events as well as hooks.
Some SDK `read_agent` calls do not emit post-tool hooks; a status-only or
still-running reply does not count as a reviewed worker result.
The Fleet report tool assigns one dated Markdown/JSON pair inside the
run-owned workspace, even if a reviewer suggests a different filename.
Traversal requests remain blocked, repeated identical writes are safe,
and format and byte-limit failures have separate diagnostics.
For a worktree without a PR, the guarded report tool fills only the
schema-required base and HEAD SHAs from the confirmed snapshot; it binds
JSON `reportMarkdown` to the Markdown already saved in the owned workspace,
and records the actual Fleet start and report-save times.
Fleet may revise its Markdown before saving JSON; after JSON is saved the
report pair is fixed. JSON saves without prior Markdown receive a clear error.
Guide accepts display labels such as `Complete` and `Incomplete coverage` in
Markdown when they agree with the JSON worker status; unknown labels and
contradictory status or model rows still fail. Report validation failures are
returned to the Fleet coordinator with the exact reason, and a failed run
retains that reason even if a separate worker-policy error also occurred.
Other Fleet fields, worker outcomes, counts, and findings must still pass
validation. Up to two rejected JSON attempts are retained there for diagnosis.
While reviews run, Overview shows the status of each selected check.
Use Left/Right to switch between Overview, check reports, and Synthesis.
PgUp/PgDn scroll the selected report. Output updates preserve the selected tab
and scroll position. Fleet's specialist events stay inside the Fleet tab.
After completion, inspect findings and open the full saved reports.
Fenced `diff` blocks in saved Review reports display added lines in green,
removed lines in red, and hunk headers in the info color; line prefixes
remain visible, while the fence markers are hidden. Other fenced code and
the saved Markdown files are unchanged.
Status labels distinguish failed and partial reviews from complete ones;
live model text is not a verified report. Only the live display buffer is
limited; saved reports retain full content. Version-2 records, reports, and
frozen evidence are saved under
`<absolute-worktree-git-directory>/trellage-reviews/`, outside tracked files,
with private directories and atomic mode-0600 files. Press `h` from scope or
target selection to reopen history without model calls. Interrupted runs remain
inspectable but do not resume automatically.
Legacy Optimize history under `trellage-optimize-reviews` retains its original
validation and approval path. Existing `.trx-review-*` reports remain where
they are; they are not migrated or treated as authority to edit.
Untracked dated Fleet reports written manually under `docs/review/` are
ignored as generated output too. Tracked reports and other untracked files
remain part of the review.
When two or more successful reviews disagree, the master can cite each
reviewer's evidence and send a focused challenge to the other reviewer's
existing SDK session. Guide routes no more than four questions per round and
allows at most two rounds; the second needs new evidence from the first.
Questions, replies, master decisions, and unresolved disputes are saved beside
the reports. An unresolved challenge makes the combined review incomplete;
a failed reply cannot be marked resolved or become an all-clear.
After the report, select recommended findings with Space and save approval
before choosing **Implement approved findings**. Choose an eligible Native
Copilot, Codex, or Claude profile, then confirm launch in the current terminal
or a same-worktree Herdr pane/tab. Nothing starts approved. Every editing action
checks saved approval, fresh target and context, profile readiness, other
writers, the worktree lock, and a durable one-use launch reservation.

Alternatively, press `l` for **Plan fixes** with Copilot `hve`, without edit
approval. Planning can use the current terminal or a clean new Herdr worktree
at the unchanged reviewed HEAD. Incomplete reports stay explicitly incomplete.
Dirty files are not copied to a new worktree.
The current-terminal planning handoff uses `mise run trx -- run copilot hve -- --plan -i`
from a `mise run trx` worktree session, so the router repairs stale source
runtime readiness before launch. Installed sessions use
`trx run copilot hve -- --plan -i` instead of invoking the launcher path directly.
**Plan then implement approved findings** uses Copilot `hve` with full access
in a same-worktree Herdr tab. It requires saved finding approval and a separate
automatic-execution confirmation. It is not a planning-only action.
Each handoff needs confirmation; exiting the report launches nothing.
Queued Guide work can block taking over the current terminal without blocking
read-only review or an eligible Herdr destination. Native execution is not
restricted to selected files by a filesystem sandbox.
Plan-mode continuations ask Copilot to check
the reviewed snapshot against the current worktree, triage the findings, and
propose prioritized fixes and checks without editing files.
If a run stops, Review shows the underlying error and retains partial reports
and evidence in history. Restart returns through target selection and new
consent. A failed synthesis cannot authorize implementation or produce an
all-clear. An uncertain launch is never resent automatically.
Selected skill content is frozen for a run. `trx skills update` refreshes the
Native skill cache between runs; Review also refreshes it when a selected skill
is missing from an otherwise valid cache.

To add a leaf review, declare its exact skill in `config.toml` and
`native-common`, then add its ID, skill name, and model to
`packages/trellage-launcher/src/review-catalog.ts`. The existing runner loads
selected leaf skills without new orchestration code. A skill that starts its
own agents needs a verified composite adapter; Fleet and Matt Pocock Code
Review have separate bounded adapters.

The guide starts profile matching immediately. Press `p` during matching or
recommendations to open the supplied prompt as rendered Markdown. The default
viewer is `dashboard`; use `--ui-variant pager`, `split`, `focus`, `bookends`,
or `dashboard` to select another layout. Each viewer supports Page Up/Page
Down. Press `e` to edit the raw prompt, then Enter to re-run matching when the
prompt changed.

#### Prompt augmentation

A short intent gives the match model little to work with. Open the augment menu
to rewrite the prompt: press `Ctrl-G` on the intent screen, or `a` on the prompt
page (`p`) or after a failed match.

- **Research** runs HVE Core's `rpi-research` skill through the installed native
  `trx run copilot hve` profile and replaces the draft with the research note it writes. It
  runs out of process because that skill needs the `hve-core` plugin, file-write
  tools, and this repository as its working directory; the guide's own model
  sessions deny all three. It fails with `trx setup copilot hve` guidance when the
  profile is not installed. Set `TRELLAGE_GUIDE_RESEARCH_TIMEOUT_MS` to change
  the 15-minute limit.
- **Codebase** packs this repository with `repomix` and asks the guide's
  `enrich` phase to restate the draft with that pack as reference. The pack
  travels as prompt content, so the model session stays locked down. `repomix`
  already honours `.gitignore` and skips `.git/` and `node_modules/`; on top of
  that the guide drops built output, vendored trees, lockfiles, snapshots, and
  binary assets. If the pack is still over the 400,000-character budget it
  narrows once to source, entry points, and `docs/`, and once more to source
  signatures with comments removed. Only when the narrowest scope is still too
  large does it fail, and it then names `repomix.config.json` and running from a
  single package directory as the fix.
- **Goal me** runs the installed `goal-me` skill in one Copilot SDK session.
  Questions stay inside the guide. Select an answer or type your own, then
  continue until the task and success criteria are clear. The completed goal
  appears for explicit approval; no separate harness opens.
- **Customer context and outcome** asks six local questions about the problem,
  business outcome, evidence, decisions, constraints, and customer ownership.
  No model reads the draft answers. Enter saves each answer; a blank answer
  stays **Unknown (not supplied)**. `Ctrl+B` returns to the previous answer.
  `Esc` pauses without losing the draft. Review the complete brief, then use
  `a` to apply and allow Guide use, `e` to edit, or `x` to discard.

The customer brief is Trellage preparation, not a complete HVE workshop or
customer signoff. Supply only sanitized material you may share. Applying it
permits use by Guide models, its local `.trx-guide` cache, and the selected
agent. Guide preserves the approved fields and original request through
generation, refinement, and candidate edits. Existing forks and queued jobs
keep their own context. Editing and submitting the main request clears its
structured customer approval; cancelled edits do not. Reopen the augmentation
to approve a new brief. Each answer is limited to 600 characters. If the full
context and workflow cannot fit the final 8,000-character prompt, Guide reports
the limit instead of removing evidence.

Customer context and Goal me are separate approval paths. Do not attach a
brief to an approved execution goal or silently turn a customer brief into
one. Start a separate prompt for Goal me, or explicitly remove the brief by
editing the main request.

Research and Codebase run in the background. Choosing either gives the screen
back at once and puts a one-line status bar above the tab bar:

```
⠋ Research · Reading the research note · p then a to watch
✓ Research ready · p then a to apply
✗ Research failed · p then a for details
```

A research run takes minutes, so you keep working while it runs: edit the draft,
match on the base prompt, browse recommendations, open a fork, queue a job. The
run holds the prompt it started from, so later edits do not reach it, and a
queued job carries its own prompt.

The prompt page (`p`) shows the run above the prompt it is rewriting: a spinner,
the current phase, and the last few output lines. `a` there opens the full watch
screen, with a taller output panel, so you can see which files `repomix` is
reading or what the research run is doing. The panel keeps the last few lines;
it is progress, not a transcript. `Esc` leaves the watch screen and the run
keeps going.

When Research or Codebase finishes it replaces the prompt itself, on the screen you started
it from; enhancing the prompt is the point, so there is no approval step.
Applying from the prompt page re-matches the profiles as soon as you leave that
page with `Esc`.

It waits only where replacing the text would throw away work: while you are
editing the prompt with `e`, and while you are inside a fork tab, where the
draft belongs to the tab rather than to the main screen. Then the status bar
reads ready and `p` then `a` takes it. A failed run offers `r` to retry.
`x` on a running job stops the child process; so does quitting the guide.

Goal me is an option in the existing menu: **`p` remains View prompt**, and
**`a` remains Augment while viewing the prompt**. Select **Goal me** to open
the interview. Arrow keys and Enter select an answer. Text answers support
multiline paste; letters such as `q`, `a`, and `L` remain text in the answer
editor. A question can restrict answers to its supplied choices.

The question footer offers **`a` Accept all recommended answers**. This
accepts the current and later choices marked `(Recommended)` or
`(Recommended: reason)` in the same interview. Questions without exactly one
marked recommendation still wait for your answer; the guide does not guess.
Press `a` where **Stop automatic answers** is shown to return to manual
answers. In text editors, `a` remains text. The setting survives parking and
retry, but discard or a new interview clears it.

Review the full goal as Markdown. Select **Use goal** to approve it, or
**Revise** to give feedback in the same conversation. Only an approved goal
replaces the prompt; automatic answers never approve it. If the source prompt
changed while the interview was open, the guide requires a separate
replacement decision. Existing queued
jobs keep their own prompts.
Unlike standalone `/goal-me`, this embedded interview returns goal text to the
prompt editor: it writes no goal file and does not execute the goal loop.
Approval also keeps the structured goal for the later recommendation and
execution steps.

`Esc` returns to the prompt without losing the interview or typed answer.
`a` reopens it. Time spent answering does not count against the model's
active-work timeout. Each completed answer (manual or automatic) or revision
starts a new model round with a fresh three-minute limit. A long interview
does not share one three-minute budget; a stalled round still times out.
Discarding the interview or exiting the guide cancels
pending questions without sending an answer. On failure, the guide keeps the
source, completed answers, and last goal draft in memory; `r` starts an
explicit retry with that context. Discard or exit clears it.

Goal me always uses `gpt-6-astra` with `max` effort. The guide's general
`--model` and `--effort` overrides do not change this interview model.
Other guide phases keep their existing model routes. The skill loads only
when selected, through the shared Native skill cache. If it is missing, run
`trx skills update` and retry. Normal guide startup and the other augmenters
do not require goal-me.

One augmentation runs at a time, because all rewrite the same prompt. Discard
the current one before you start another.

The research note stays on disk at
`.copilot-tracking/research/{date}/{slug}-research.md`; it is durable evidence
by design. Add `.copilot-tracking/` to `.gitignore` if you do not want it
committed. Researching the same intent twice resumes that same note rather than
writing a second one, and the augmenter takes the resumed note. A run that
writes nothing at all fails, and the failure quotes the run's own closing words
and its last output so you can see why.

#### Customer workflows and lenses

HVE keeps human judgment with the customer. Use the smallest workflow that
fits the evidence already available. Do not restart discovery when approved
requirements already exist, and do not treat a successful demo as validated
customer value.

| Situation | Native HVE workflow and agent |
| --- | --- |
| The customer problem or proposed solution is not validated | `d` **Discover with the customer** — `customer-discovery`, DT Coach |
| A specific assumption needs evidence before investment | `e` **Test an assumption** — `test-assumption`, Experiment Designer |
| The problem is understood; business requirements need agreement | `business-requirements`, BRD Builder |
| Product behavior and acceptance criteria need definition | `product-requirements`, PRD Builder |
| One UX framing, critique, or stakeholder question needs help | `focused-ux-coaching`, UX UI Designer |
| Architecture choices need review against agreed needs | `review-architecture`, System Architecture Reviewer |
| Mature requirements need a reviewed work hierarchy | `functional-planning`, Functional Planner |

Discovery can move backward and reuse evidence. Its formal exits from problem,
solution, or implementation space go to scoped `rpi-research`, not directly to
coding. An experiment agrees on measures and decision criteria before it runs.
Disproving an assumption can be useful learning. Partner participation,
ownership transfer, and independent repetition are part of experiment design.

Discovery and Experiment remain eligible for normal recommendations even
though they also have pinned shortcuts. The broad Council, Research, and HVE
RPI workflows remain optional lenses unless explicitly requested. This
exclusion applies to those workflows, not every workflow on their profiles.

These seven customer workflows use `trx run copilot hve --interactive`, an explicit agent,
and declared skill checks. They require a terminal and your answers; they
cannot enter the batch queue. Guide rechecks readiness before a direct
terminal or Herdr launch. An old launcher, missing registration, disabled
skill, or unsafe file blocks launch with a diagnostic. Static checks do not
prove a successful HVE session or customer approval.

The initial verified customer routes are **Native only**. Sandbox HVE retains
its RPI and HVE Builder routes. This feature does not ingest meetings, read
customer files during brief preparation, manage data access or retention,
publish reports, change a tracker, or authorize implementation. These actions
need separate decisions and controls. See the
[Native HVE guide](profile-guides/native/copilot/hve.md) for exact agents, skills,
and workflow boundaries.

#### Repository engagement guidance

Ask what to do next using the engagement's existing repository knowledge:

```sh
trx guide --engagement
trx guide --engagement --intent "Prepare the next customer workshop"
```

The first command defaults to "What's the next step in this engagement?"
Guide opens a local source-selection view before any model call. After you
approve model use, it recommends an evidence-backed next action, or asks one
material question. The next action can be human work or waiting; an agent is
not required.

Prepare one assignment, review it, and separately confirm an interactive
Native HVE launch in the current worktree. Guide returns for result review
when the execution attempt ends. Assignments and reviewed notes stay under
lowercase `engagement/work/` paths. HVE keeps its canonical method state; no
folder migration or competing status file is required.

See [engagement guidance](docs/trx-guide-engagement.md) for source mapping,
consent, saved work, data limits, and supported launch boundaries.

#### Goal-aware recommendations and execution

After **Use goal**, recommendations use the approved artifact, task, and
success criteria. The screen shows **Goal: N approved criteria** and the
selected controller. Only profiles with a compatible declared goal policy
can execute the goal. The guide can show fewer than five recommendations;
it does not fill empty places with ordinary prompt workflows.

The profile's declared policy selects one controller:

| Supported profile | Controller and delivery |
| --- | --- |
| Native Codex, including Superpowers | Native `/goal`; start the interactive profile, then use its command input as described below |
| Supported Native Claude (`trx run claude default`) in this terminal | Native `/goal` through the launcher's documented `-p` prompt mode |
| Sandbox Claude in prompt mode | Native `/goal` through the runtime's Claude `-p` path |
| Native Claude in interactive Herdr | Native `/goal` with explicit manual command input; the session stays interactive |
| Sandbox Claude Graph of Loops | The authored `/graph-of-loops` workflow; `trellage-graph` remains the only completion authority |

Workflow discipline such as Superpowers TDD does not replace a declared goal
controller. Every native-goal candidate has one explicit `/goal` frame.
Graph candidates use `/graph-of-loops` without an outer `/goal`. The installed
`goal-me` skill authors goals; it is not invoked again to execute an approved
goal. The guide does not invent a `$goal` skill.

All three candidates retain the exact approved task and criteria, with a
minimum score of 8 on every criterion. They differ only in approach. The
selected controller owns progress, continuation, and completion. The original
Goal-me document stays available for review, but its generic LOOP PROTOCOL,
SCOREBOARD, and progress-file rule do not become a second execution protocol.
Graph keeps its existing review, proof, integration, and delivery gates.

**Edit approach (goal fixed)** changes only the candidate's approach.
The queued-job editor has the same restriction. Each fork and queued job
keeps its own goal, controller, and approach; a later main goal cannot change
an older job.

If you change an approved main prompt, or replace it with Research or Codebase
output, **Review goal changes** requires an explicit decision:
`g` revises and reapproves a goal through Goal me; `n` uses the changed text as
a normal prompt; `b` or `Esc` keeps the approved goal. Unchanged or cancelled
edits keep the goal. A pinned workflow without a supported controller also
requires a choice. Its `n` option opens an ordinary reference fork without
changing the main goal or queued jobs; `b` or `Esc` returns to recommendations.

**Native Codex does not activate `/goal` from a startup argument.** Trellage
starts the selected interactive Codex profile without a goal prompt argument.
In that session, type `/goal `, paste the supplied condition body after the
space, then submit it. Do not rely on pasting a large slash-command block:
Codex can replace large pastes with composer placeholders. Interactive Claude
Herdr sessions also require explicit native command input. These jobs are
marked as needing input, and their full condition and destination remain
available in the handoff output. A started session is not proof of goal
activation or completion.

The approved document can contain up to 60,000 characters. The composed goal
prompt has a separate 96,000-character limit. An approach can contain up to
8,000 characters, except that Claude's complete `/goal` condition must fit
within 4,000 characters, excluding the command prefix. The guide reduces only
the approach budget. If the fixed goal and workflow cannot fit, choose another
controller; the guide does not shorten the task or criteria. Manual paste does
not remove Claude's condition limit. Prompt arguments also have a separate
UTF-8 byte limit.

Read-only readiness must confirm runtime support and settings before dispatch.
Native `/goal` checks require stable Codex 0.153.4 or later with `goals`
enabled, or Claude 2.1.139 or later. Codex uses
`trx inventory codex PROFILE --goal-features` to include the same project
configuration as a launch. Older launchers without this probe or Claude goal
runtime metadata report unknown readiness; refresh those launchers separately.

If evidence is missing or a policy blocks the goal, the guide reports the
reason and leaves it unlaunched. A supported transport form alone does not
prove readiness, including for a Sandbox whose doctor output lacks goal
runtime evidence. Disabled Codex goals, missing Claude
workspace trust, or prohibited hooks must not be treated as successful goal
activation. Trellage does not change those policies or create project goal
files such as `.trellage/GOAL-xxxx.md`. Codex can store large goal input in its
own native state. Existing guide model artifacts are not goal progress files.

`trx guide --preview` renders the staged prompt basket composer overlay from
fixture data. The preview is fixture-only: it makes no model call, reads no
profile catalog, and launches nothing, so it opens with Docker stopped and with
no Copilot credentials.

The composer always shows the destination that will run the assembled prompt:
launcher, harness, profile, model, effort, sandbox flag, working directory,
target Herdr pane, and session name. Each staged block is truncated to two
wrapped lines with an ellipsis, and its header carries the source pane, harness,
capture time, character count, and line count.

Inside it, `↑/↓` (or `j`/`k`) cycle the staged blocks and `J`/`K` reorder them.
`o` opens the selected block in full and `f` opens the assembled final prompt;
both page with `j`/`k` and PgDn/PgUp, and `q` or Esc returns to the list. `e`
edits the selected block, `u` reverts it to the captured text, `x` drops one,
`X` clears the basket, and `r` restores the fixtures. Enter prints the assembled
prompt to stdout and exits; `q` or Esc quits.

Successful model-backed guide steps are stored as readable Markdown under the
effective working directory:

```text
.trx-guide/<prompt-slug>-<uuid>/
  1-profile-recommendations.md
  2-prompt-candidates-<profile-workflow>-<key7>.md
  2-refinement-<candidate>-<feedback-slug>-<key7>.md
```

The prompt slug is a deterministic, safe hint of at most seven characters;
the UUID keeps separate prompt sessions distinct. Each artifact shows the
original intent, routing, selected profile/workflow, feedback when applicable,
and final model-derived output. A versioned base64url JSON header preserves the
exact structured result used by the launcher. Directories use mode `0700` and
files use mode `0600`, with atomic writes and bounded, regular-file-only reads.

Repeating an identical step reuses the newest valid matching artifact and its
UUID directory, avoiding the corresponding generation, optimization, or
refinement model calls. Changes to relevant prompts, routing, catalog, guide,
profile/workflow, target agent or model, Prompt Master skill content,
candidates, or feedback miss independently and leave earlier artifacts
available for review.
Match caches also distinguish backend, model, and matcher/question revision.
Jev cache keys exclude unrelated LLM settings. A cached Copilot fallback never
prevents a new Jev attempt, and each successful backend is cached separately.
Match artifacts report the backend and model that supplied the recommendations.
Deterministic fallbacks and direct manual edits are not cached because they do
not avoid model work.

`.trx-guide` is intentionally project-local and is not added to ignore rules
automatically. Its files contain the original intent and model-derived output;
review them before committing, sharing, or otherwise exposing the working
directory. The former XDG `trellage/trx-guide/last-match.json` cache is no
longer read or written.

When the selected workflow declares a skill, the guide applies that workflow's
authored Markdown prompt template to generated and refined content. The final
handoff therefore invokes the exact curated skill, such as
`/social-media-skills:post-writer <generated prompt>`. Workflows without a
declared skill keep the generated prompt unchanged.

The guide shows the exact command and asks for confirmation before it starts a
profile, creates a Herdr pane, or creates a Herdr worktree. A profile receives
`-p` only when its published headless contract supports prompt input. For
ordinary Copilot and Codex Herdr handoffs, the guide queues the
prompt in the initial harness command. The harness keeps that prompt while you answer
Copilot workspace-trust or Codex hook-trust requests; the guide does not
approve trust automatically. Other Herdr profiles receive the prompt through
the Herdr agent API after the agent is idle. Goal handoffs use the separate
controller and native-input rules above.

Guide worktree suggestions use `wt/<profile-tag>-<topic>`, for example
`wt/cpx-hve-review-my-pr` or `wt/sb-claude-council-review-my-pr`.
Generated names contain at most 40 ASCII characters. Native tags include the
launcher and profile; Sandbox tags use `sb-` and the profile. Tags longer than
22 characters retain a readable prefix and a six-hex identity hash. Topics use
at most 14 characters, shortened at a word boundary when possible.

Suggestions skip branches already reserved by queued new-worktree jobs, using
`-2`, `-3`, and later suffixes within the same length limit. A manually entered
duplicate stays in the editor with the conflicting job and profile shown.
The queue checks again at confirmation; a queued-only conflict does not offer
to open an existing checkout. Reopening a queued job keeps its branch and ID.
Removing the job or changing its placement releases its reservation.
Manual names still use Git validation without the generated-name length cap.
Existing branches, Admin repair names, dirty-checkout confirmation, and
explicit reuse of existing worktrees are unchanged. Reservations cover the
current queue only, not other guide sessions.

Agent Skills can use the side-effect-free JSON API:

```bash
trx guide --intent "Write a post about AI agents" --json
trx guide --intent "Write a post about AI agents" \
  --profile sandbox:claude-social-media --json
printf '%s' \
  '{"schemaVersion":1,"intent":"Write a post about AI agents"}' \
  | trx guide --json
```

JSON mode does not require a TTY and never launches a profile or changes
Herdr. The stdin object accepts `schemaVersion`, `intent`, and optional
`profile`, `model`, `effort`, `goal`, and `workflowId` fields. Structured goal
mode is explicit: `goal` contains `artifact`, `task`, and a `criteria` array;
`intent` retains the original document. The caller supplies this contract;
the API does not run or claim a Goal-me approval. A `workflowId` requires a
selected profile, supplied in JSON or through `--profile`.

Match responses contain `phase: "match"` and enriched `recommendations`.
Optional host-owned `execution` metadata identifies the actual matcher:
`{"backend":"jev","model":"jev-1.13.0"}` or
`{"backend":"copilot","model":"gpt-5.6-sol","effort":"medium"}`.
The top-level `model` and `effort` retain the configured LLM route. Jev's
`confidence` is the probability that the profile fits the task. Its explanations
come from the selected authored workflow and profile limitations or prerequisites.
Ordinary matching returns five recommendations. Goal matching returns one to
five compatible recommendations, or reports why none can execute the goal.
Generation responses contain `phase: "generation"`, the selected `profile`, and exactly
three prompt `candidates` with path-free command previews. Goal candidates
retain the chosen workflow, protected objective, controller, and delivery
requirements. Manual `goalTransport` data includes the exact native-input
instructions; JSON mode does not execute them. Interactive model
failures can be retried or replaced with deterministic literal/template
fallbacks. Matching and candidate drafting have no tools, repository
attachments, file tracking, or persistent history. Candidate drafting writes
complete agent prompts as short task briefs: objective, context, target state,
scope, constraints, acceptance criteria, action boundaries, and progress
evidence. It uses only supplied facts and omits sections without support.
Prompt optimization loads only the configured Prompt Master skill. Guide names
the target agent and, for Sandbox profiles, its configured model. Prompt
Master cannot read its reference templates, and Guide disables its
interactive output, question, warning, and stop-and-ask rules. Guide content
and the execution objective are sent to TypeSafe for Jev matching and to the
configured Copilot model for fallback matching and subsequent LLM phases.

The native `prime` backend runs Prime Agent against `copilot-proxy-rs`, pinning
the provider and model to `copilot-proxy-rs` and `claude-opus-5` (Anthropic
Messages API at `http://127.0.0.1:8080`). It is independent of the Docker
`prime-agent` profile. Install and manage it from
`prototypes/trellage-prime-profiles`:

```bash
trx setup prime
trx doctor prime
trx run prime default -- -p "Reply exactly PRX_OK"
trx upgrade prime --check
trx upgrade prime
trx repair prime
```

`PRIME_AGENT_CODING_AGENT_DIR` isolates configuration and sessions under
`~/.local/share/trellage/profiles/prime/default/home/`. Every launch restores
the managed `models.json` provider and selected model so persisted edits cannot
redirect the endpoint. No host model credentials are copied.

The native `agency` backend runs Microsoft Agency's managed Copilot CLI with the
repository-local `trellage-azure` Agency profile:

```bash
trx setup agency azure
trx doctor agency azure
trx inventory agency azure --json
trx run agency azure
```

It preserves the real `HOME` and current worktree, but sets
`COPILOT_HOME=~/.local/share/trellage/profiles/agency/trellage-azure/home`.
Agency receives `--profile-only trellage-azure`; Copilot arguments follow the
required `--` separator. The committed `agency.toml` enables Microsoft Learn
and Azure MCP `2.0.5` with eleven exact read-only subscription, resource-group,
ACR, storage, and resource-health tools. It contains no credentials and does
not enable deployment or write tools. This first release works only from this
repository because Agency discovers the named profile from the worktree-root
configuration.

Live Agency and Azure checks are never part of `make test`. Run the explicit
interactive proof only after recording the exact installed versions:

```bash
TRELLAGE_AGENCY_LIVE=1 \
TRELLAGE_AGENCY_VERSION='<exact Agency version>' \
TRELLAGE_AGENCY_COPILOT_VERSION='<exact managed Copilot version>' \
  prototypes/trellage-agency-profiles/tests/live.sh
```

Native profiles run directly on the host and are state-isolation conveniences,
not security boundaries.

## Generic Evaluation Harness

This repository runs multiple coding-agent configurations against the same prompt without loading their plugins, skills, hooks, sessions, caches, or configuration into the host harness.

The included comparison builds the same TODO app twice:

- Codex CLI with the current approved `wshobson/agents` source, using
  `copilot-proxy-rs` for model calls.
- GitHub Copilot CLI with the current approved `github/awesome-copilot`
  source, using native GitHub Copilot authentication.

Each contestant gets its own image, Compose project, network, workspace volume, app-data volume, session, and loopback port. The output is normalized evidence for later grading; the harness does not select a winner.

Each comparison build resolves `comparison-common` once and gives the same
staged skill snapshot to every contestant image. A build fails if the snapshot
cannot be fetched or validated. Compose does not fall back to the repository
directory as a skill context.

The three common bundles require the upstream `ui-guidelines` skill. Existing
native caches receive catalog updates only after `trx skills update`; existing
Sandbox and comparison images must be rebuilt.

## Quick Start

Prerequisites:

- Docker Engine with Compose.
- `jq`, `gh`, and the pinned Bun runtime on the host; Node.js and npm remain
  necessary for external agent and browser tooling.
- A running `copilot-proxy-rs` Compose project whose network is named `copilot-proxy-rs_default`.
- A GitHub account with Copilot access. Authenticate with `gh auth login`, or set `COPILOT_GITHUB_TOKEN` or `GH_TOKEN`.

Install the host Playwright browser once:

```bash
cd tests/playwright
npm ci
npx playwright install chromium
cd ../..
```

Run the complete comparison:

```bash
make compare
```

This validates the manifest, builds both images, runs both agents concurrently, serves both apps, verifies both generated workspaces and browser flows, and writes a timestamped evidence bundle.

Open the live apps:

- Codex + `wshobson/agents`: <http://127.0.0.1:4173>
- Copilot + `awesome-copilot`: <http://127.0.0.1:4174>

## Native Agent Profile Matrix

Prerequisites are the installed commands `trx`, `codex`, and `jq`; provisioned Codex/Copilot profiles; and authenticated CLI sessions. The Agency, Claude, Firstmate, and JCode backends have their own contracts and router integration but are not yet part of the plugin-and-skill profile matrix. Composed Grok is verified by the Native runtime tests rather than this legacy profile matrix. Live verification also requires paid model access.

Run native non-inference verification in static mode:

```bash
scripts/verify-agent-profiles
make profile-matrix
```

Static mode performs native profile discovery plus non-inference health, inventory, and context validation. It never invokes a model.

All launchers are required; failures are not skips.

Invoke every statically passing discovered profile in live mode:

```bash
scripts/verify-agent-profiles --live
make profile-matrix PROFILE_MATRIX_ARGS=--live
```

Live mode invokes every statically passing discovered profile, may consume paid model quota, and may create product-local telemetry or state where a CLI lacks ephemeral mode.

Run the focused contract with:

```bash
make profile-matrix-test
```

Codex discovery and static checks require the managed Codex backend and isolated profile roots under `~/.local/share/trellage/profiles/codex/`.

Codex live checks bypass the managed Codex backend and invoke raw `codex` with the validated isolated `CODEX_HOME` plus ephemeral, read-only, approval-never arguments.

Static verification performs no native marketplace, plugin, or managed-skill mutation and no live prompt. It never runs setup, repair, update, install, uninstall, login, or logout, but `trx doctor codex` may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.

Exit statuses:

- `0`: all required checks pass.
- `1`: a required launcher is missing, or discovery, static verification, or live verification fails.
- `2`: invalid usage.

## Native TUI Matrix

The Native TUI matrix discovers its complete profile set from
`trx list --json`. Profile names are not hardcoded. A new profile under an
existing launcher is included automatically. A new launcher must select a
versioned PTY adapter in
[`scripts/native-tui-adapters.json`](scripts/native-tui-adapters.json);
discovery fails closed when that adapter is missing.

Run the sequential, no-model lifecycle matrix:

```bash
scripts/verify-native-tuis
make native-tui-matrix
```

Filter a run without changing discovery:

```bash
scripts/verify-native-tuis --launcher claude --profile default
```

The runner still validates adapter coverage for the complete discovered
catalog before it applies filters. Unknown or partly invalid selectors fail
instead of being ignored.

Lifecycle mode uses each real current profile home. It requires healthy
machine-readable inventory before launch, starts the profile through
`trx run`, waits for the harness-specific input marker, sends only configured
control keys to exit, and requires healthy inventory afterward. It does not
run setup, repair, login, or a model prompt. Harnesses can still write normal
session, history, cache, usage, and UI state. Profiles run one at a time.
Recognized trust, consent, login, and onboarding screens fail as blockers; the
matrix does not answer or persist those decisions.

Live mode is an explicit paid probe:

```bash
scripts/verify-native-tuis --live --launcher claude --profile default
make native-tui-matrix-live NATIVE_TUI_MATRIX_ARGS='--launcher claude --profile default'
```

For every selected profile, live mode enters text through the real TUI and
proves a decoded nonce response, a second response that depends on conversation
memory, and a `justify`-prefixed behavioral smoke that requires a verdict line.
Expected response markers are encoded as decimal ASCII in the typed prompt, so
input echo cannot satisfy the check. This verifies TUI invocation and response
shape; it is not a proof that the model did not inspect other files. Live mode
can consume model quota and must not run from `make test`.

Each run writes mode-0600 raw PTY streams and `result.json` beneath
`~/.local/state/trellage/native-tui-matrix/`. Use `--evidence-dir PATH` to
select another fresh, empty, non-symlink directory. Run the deterministic
fixture contract with:

```bash
make native-tui-matrix-test
```

To test uninstalled launcher changes from the current worktree, opt in to
source launcher resolution:

```bash
TRELLAGE_TRX_SOURCE_ROOT="$PWD/prototypes/trellage-router" \
TRELLAGE_TRX_NATIVE_SOURCE=1 \
scripts/verify-native-tuis \
  --trx "$PWD/prototypes/trellage-router/bin/trx" \
  --launcher claude --profile default
```

Exit statuses:

- `0`: every selected profile passes.
- `1`: discovery, adapter validation, readiness, PTY interaction, exit, or
  postflight readiness fails.
- `2`: invalid usage.

## Headless Contract Matrix

The headless publication gate compares Sandbox adapter declarations and Native
catalogs with [`docs/headless-evidence.json`](docs/headless-evidence.json). It
also runs deterministic prompt, machine-output, session, resume, malformed
output, failure, cleanup, question-control, usage/cost, and Git evidence
contracts.

```bash
scripts/verify-headless-contracts
make headless-matrix
make headless-matrix-test
```

Static and deterministic checks do not invoke a model. Live verification is
separate because it can consume paid quota:

```bash
TRELLAGE_HEADLESS_SANDBOX_PROFILE=tests/fixtures/headless-live-claude/profile.toml \
TRELLAGE_HEADLESS_SANDBOX_VERSION=2.1.229 \
  scripts/verify-headless-contracts --live
TRELLAGE_HEADLESS_SANDBOX_PROFILE=tests/fixtures/headless-live-claude/profile.toml \
TRELLAGE_HEADLESS_SANDBOX_VERSION=2.1.229 \
  make headless-matrix-live

TRELLAGE_HEADLESS_SANDBOX_PROFILE=claude-council \
TRELLAGE_HEADLESS_SANDBOX_VERSION=2.1.233 \
TRELLAGE_HEADLESS_LIVE_SCOPE=sandbox \
  scripts/verify-headless-contracts --live
```

The checked-in core fixture pins its recorded Claude Code `2.1.229` contract.
Sandbox adapters can publish different tested Claude versions. Set
`TRELLAGE_HEADLESS_SANDBOX_VERSION` with the exact version expected for the
selected profile. The `claude-council` live probe also requires a successful
headless Council agent invocation. Use `TRELLAGE_HEADLESS_LIVE_SCOPE=sandbox`
to run only the selected Sandbox contract when unrelated Native probes are not
part of the evidence being refreshed.

Capability values apply only to the exact recorded harness version. Version
drift keeps the profile discoverable but resolves its headless object to
conservative values.

## Native Copilot Authentication

The Copilot contestant does not use `copilot-proxy-rs`. The runner resolves a token in this order:

1. `COPILOT_GITHUB_TOKEN`
2. `GH_TOKEN`
3. `gh auth token`

It writes the value to a temporary mode-`0600` file, mounts that file only as `/run/secrets/copilot_token` in the one-shot Copilot agent container, and deletes the temporary file when the run ends. The token is not placed in container environment configuration, host bind mounts, logs, or collected evidence. Host `~/.copilot` and `~/.config/gh` directories are never mounted.

## Lifecycle Commands

The default manifest is `harnesses/todo-side-by-side/harness.json`.

```bash
./scripts/harness validate harnesses/todo-side-by-side/harness.json
./scripts/harness build    harnesses/todo-side-by-side/harness.json
./scripts/harness run      harnesses/todo-side-by-side/harness.json
./scripts/harness resume   harnesses/todo-side-by-side/harness.json
./scripts/harness sessions harnesses/todo-side-by-side/harness.json
./scripts/harness serve    harnesses/todo-side-by-side/harness.json
./scripts/harness verify   harnesses/todo-side-by-side/harness.json
HARNESS_RUN_ID=my-run ./scripts/harness collect harnesses/todo-side-by-side/harness.json
./scripts/harness down     harnesses/todo-side-by-side/harness.json
./scripts/harness purge    harnesses/todo-side-by-side/harness.json
```

- `run` creates new retained agent sessions and runs contestants concurrently.
- `resume` continues both retained sessions with the shared prompt. If an abrupt
  container exit prevented the session-ID sidecar from being written, it
  recovers the newest native session for `/workspace`.
- `sessions` inspects retained native state without credentials or network
  access and prints each contestant's recoverable session ID.
- `serve` publishes the generated runtime artifacts and starts both apps.
- `verify` runs each app's own test/type/lint/build/audit checks, recreates clean app processes, runs the shared CRUD flow, recreates each app again, and proves SQLite persistence.
- `collect` exports normalized, secret-scanned evidence and refuses to overwrite an existing run ID.
- `down` stops containers but preserves workspaces, sessions, and app data.
- `purge` permanently removes both contestant projects and their named volumes.

Agent containers are one-shot, but their Codex and Copilot runtime homes live in
the project-scoped workspace volumes. A container or terminal crash therefore
does not discard conversation state; use `sessions` to inspect it and `resume`
to continue it. Host `~/.codex` and `~/.copilot` remain unmounted so contestants
cannot read or modify unrelated host conversations. `purge` irreversibly removes
the retained runtime homes.

Use another manifest with Make:

```bash
make compare HARNESS=harnesses/my-comparison/harness.json
```

## Define a Comparison

Copy the existing harness directory and edit its manifest and prompt. Keep contestant IDs and ports unique.
`build` and `compare` resolve floating package branches and stable runtime
channels with a fresh image build. Later `run` and `resume` commands reuse
those installed images.

Each contestant declares its `model`. The optional `reasoningEffort` defaults
to `medium` for Codex and `low` for Copilot; plan mode uses the same model
with `max` reasoning. Set `CODEX_MODEL` and
`CODEX_REASONING_EFFORT`, or `COPILOT_MODEL` and `COPILOT_REASONING_EFFORT`,
to override the corresponding manifest settings for a run or resume. Set
`CODEX_PLAN_MODE_REASONING_EFFORT` or `COPILOT_PLAN_MODE_REASONING_EFFORT` to
override plan effort separately.

Each package entry contains:

- `source`: the repository supported by that runtime adapter.
- `ref`: `main` or `master` for floating development, or an exact
  40-character Git commit SHA for a recorded snapshot.
- `plugins`: the plugin or plugins baked into that contestant image.
- `skills` and `hooks`: reserved direct-selection fields; they must currently be empty.

Current adapter capabilities:

| Runtime | Package source | Plugin selection | Agents and skills | Hooks |
|---|---|---|---|---|
| Codex | `wshobson/agents` | Exactly one plugin per contestant | Generated Codex agents and skills bundled by that plugin | Direct hooks unsupported |
| Copilot | `github/awesome-copilot` | One or more plugins per contestant | Native plugin agents and skills are materialized with their manifests | Plugin hooks and direct hooks unsupported |

The Awesome Copilot adapter also rejects plugin manifests that require MCP servers, commands, extensions, unsafe paths, or symbolic links. Unsupported surfaces fail validation or build instead of being silently ignored.

When changing package inputs, use a new harness/contestant ID for a clean comparison, or run `purge` first. Reusing an ID intentionally reuses that contestant's retained workspace and data volumes.

## Isolation Contract

- No host bind mounts or Docker socket mounts.
- No host agent configuration or harness state mounted into contestants.
- Non-root agent UID/GID `10001:10001`; non-root app UID/GID `10002:10002`.
- Read-only root filesystems, all capabilities dropped, and `no-new-privileges`.
- Separate workspace and SQLite volumes for every contestant.
- Separate Compose networks and localhost-only app ports.
- Only the Codex agent joins `copilot-proxy-rs_default`.
- The Copilot agent joins only its project network and receives only its ephemeral file secret.
- Generated apps cannot reach the proxy network and receive no model credentials.

The app networks are ordinary Docker bridges because published host ports do not work on Docker internal networks. Isolation is enforced by project-scoped networks and volumes, hardened containers, and loopback-only port publication.

## Evidence

Each collection creates:

```text
results/<harness-id>/<run-id>/
├── acceptance.json
├── comparison.json
├── manifest.resolved.json
├── prompt.md
└── contestants/<contestant-id>/
    ├── input.json
    ├── runtime.json
    ├── checks.json
    ├── browser.json
    ├── events.jsonl
    ├── last-message.md
    ├── package-inventory.txt
    ├── source-provenance.json
    ├── app-inventory.json
    └── artifact-hashes.json
```

`comparison.json` records prompt parity, runtime/provider/model identity, evidence roots, and pass/fail status. It intentionally has no `winner` field, leaving a stable seam for a deterministic rubric or future LLM judge.

Each contestant image creates `/opt/trellage/source-provenance.json` at build
time. The read-only, network-disabled evidence exporter reads this receipt
directly from the image, not from the writable workspace. The receipt records
`schemaVersion`, `source`, `requestedRef`, and the lowercase full
`resolvedCommit`. Collection fails if a receipt is missing, malformed,
duplicated, unaccounted, or does not match the contestant's single package.
`manifest.resolved.json` preserves the requested `ref` and adds the validated
`resolvedCommit`; each contestant evidence directory also preserves the source
receipt.

See [docs/verification.md](docs/verification.md) for the current live proof and audit commands.

### Installing Pi from GitHub releases

Package feeds can lag the upstream Pi release. `scripts/install-pi-release.sh [TAG]`
downloads the latest release asset with `gh`, verifies its `SHA256SUMS` entry,
installs it under `~/.local/share/pi-release/<version>`, and links
`~/.local/bin/pi` to it. Re-run it to upgrade. `TRELLAGE_PI_BIN` overrides the
binary `trx run pi` launches.

`trx run pi` runs this installer before every launch (a no-op when current). A
failed update warns and keeps the installed Pi. Set `TRELLAGE_PI_AUTO_UPDATE=0`
to skip it; `TRELLAGE_PI_BIN` also skips it.

`trx run` checks each floating default-branch skill source with `git ls-remote`.
Every profile load attempts this check; there is no freshness TTL. Pinned
sources reuse their validated resolved content until explicitly upgraded.
