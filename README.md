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

# 3. Node.js >= 22 (builds the profile compiler on first use)
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

An advertised headless prompt also builds the image automatically on first use
(this can take several minutes), runs one non-TTY prompt, and returns the
harness status. Check `trellage list --json --full` first.

Four resolution commands, four different jobs:

- `trellage build <profile>` resolves approved stable development inputs into
  a local receipt and rebuilds the image. It does not write generated lock data
  beside `profile.toml`.
- `trellage upgrade <profile>` refreshes floating inputs, builds a candidate,
  and atomically adopts the new local receipt and image. Failure preserves the
  last good installation.
- `trellage lock <profile>` creates an exact portable release snapshot beside
  the profile. This is the only normal command that writes a release lock.
- `trellage build --locked <profile>` and `trellage ci-verify <profile>`
  require that exact release snapshot. They never fall back to floating
  development resolution.

Skill sources and bundles are approved in [`skills.json`](skills.json).
Profiles select bundle names with `skill_bundles`; they do not store skill
refs or digests. Wildcard sources may declare an `exclude` list for skills
that must never enter any consuming bundle and a `required` list that makes
materialization fail if an expected skill is absent. The `engineersamuel`
source requires `ui-guidelines`, and that source is part of `sandbox-common`,
`native-common`, and `comparison-common`. A skill-bearing rebuild is therefore
not byte-reproducible.

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
directories. Trust the root config once; mise shares that trust with linked Git
worktrees:

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
source tree. The worktree launcher runs `npm ci` when compiler dependencies are
missing and rebuilds missing or stale profile compiler output automatically.

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

`claude-council` runs Claude Opus 5 through `copilot-proxy-rs` with two Claude
Code marketplace plugins enabled by default:

- [`0xNyk/council-of-high-intelligence`](https://github.com/0xNyk/council-of-high-intelligence) (`council`) for multi-persona deliberation (`/council`)
- [`JuliusBrussee/caveman`](https://github.com/JuliusBrussee/caveman) (`caveman`) for compressed communication mode

```bash
trellage --profile claude-council
```

Claude profiles default their Opus, Sonnet, and Haiku routes to
`claude-opus-5`, `claude-sonnet-5`, and `claude-haiku-4.5`. When the resolved
headless inventory publishes `modelOverride: true`, `--model` overrides only
the Opus route for that new, prompt, or resumed launch.

Requires the external `copilot-proxy-rs_default` Docker network, same as other
proxy-backed Claude profiles.

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

Trellage also completes Claude Code's first-run onboarding with the dark theme. Later
theme changes and unrelated Claude user state are preserved. The current mounted
worktree is pre-approved as trusted inside the isolated container.
## Automatic Varlock Environment Loading

Trellage bundles Varlock and uses it automatically for new, prompt, and resume launches when a user environment source exists. Always invoke `trellage` directly:

```bash
trellage --profile claude-research
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

Each native launcher wraps a real, already-installed agent CLI; `trx` itself
is just a picker over whichever launchers are installed. On a brand-new
machine:

1. **Confirm `~/.local/bin` is on `PATH`.** Every installer places its command
   there. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile if
   it is missing, then reload the shell.
2. **Install only the underlying agent CLIs you actually use**, each launcher
   only needs its own dependency:
   - `cdx` (Codex) needs the `codex` CLI: `npm install -g @openai/codex`.
   - `cpx` (GitHub Copilot) needs `copilot` (`gh extension install
     github/gh-copilot` or the standalone Copilot CLI) already authenticated,
     plus `jq`.
   - `cldx` (Claude Code) needs the `claude` CLI: `npm install -g
     @anthropic-ai/claude-code`.
   - `grx` (Grok) needs the `grok` CLI already logged in
     (`~/.grok/auth.json` present).
   - `jcx` (jcode), `omp` (Oh My Pi), and `picx` (Pi) need `mise` and `curl`.
     First use resolves the latest stable runtime and records the installed
     version locally for offline reuse.
   - `prx` (Prime Agent) needs `mise`, Node 22+, `npm`, `curl`, `jq`, **and
     `uv`** (`mise use -g uv` if it is not already on `PATH`) to bootstrap its
     Python kernel venv.
3. **`trx` requires every one of the eight launchers to be installed** before
   it will list or launch anything — it errors with `required launcher not
   found on PATH: <name>` otherwise. If you only use a subset of harnesses,
   skip `trx` and run that launcher's binary (`cpx`, `grx`, …) directly
   instead of installing agent CLIs you don't need.
4. Several profiles (`cldx`, `jcx`, `prx`, and `omp`'s `copilot` profile) talk
   to a keyless `copilot-proxy-rs` service at `http://127.0.0.1:8080`. Start
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

Once `copilot-proxy-rs` is authenticated, `omp`'s keyless `local` profile
(routed to a self-hosted Qwen model, not GitHub Copilot) is a separate setup
and is not fixed by the device-flow login above.

Install the native agent launchers and optional profile router from the
repository root:

```bash
(cd prototypes/trellage-codex-profiles && ./install.sh)
(cd prototypes/trellage-copilot-profiles && ./install.sh)
(cd prototypes/trellage-claude-profiles && ./install.sh)
(cd prototypes/trellage-grok-profiles && ./install.sh)
(cd prototypes/trellage-jcode-profiles && ./install.sh)
(cd prototypes/trellage-omp-profiles && ./install.sh)
(cd prototypes/trellage-picx-profiles && ./install.sh)
(cd prototypes/trellage-prime-profiles && ./install.sh)
(cd prototypes/trellage-router && ./install.sh)
```

Then set up each profile you plan to use and confirm it's healthy before
launching, for example:

```bash
cpx setup --all
grx setup --all
jcx setup
omp setup
picx setup
cdx setup pstack
prx setup
cpx doctor awesome
trx list
```

An explicit `setup` step is not strictly required: every native launcher
(`cdx`, `cpx`, `cldx`, `grx`, `jcx`, `omp`, `picx`, `prx`) self-heals on first launch,
automatically running the equivalent of `setup` for a profile the first time
it's launched. Running `setup`/`doctor` ahead of time is still recommended so
you can catch missing prerequisites (proxy auth, host CLIs, etc.) before
diving into a session, rather than mid-launch.

The first native setup or launch fetches `native-common` from the approved
default branches and publishes one shared cache. Later launches use that cache
without network access. Refresh it only when you choose:

```bash
trx skills status
trx skills update
```

An update is atomic. If fetch or validation fails, the previous cache and
profile skills remain available.

The installers publish these commands and managed runtimes:

- `cdx`: `~/.local/bin/cdx` and `~/.local/share/trellage/cdx/`
- `cpx`: `~/.local/bin/cpx` and `~/.local/share/trellage/cpx/`
- `cldx`: `~/.local/bin/cldx` and `~/.local/share/trellage/cldx/`
- `grx`: `~/.local/bin/grx` and `~/.local/share/trellage/grx/`
- `jcx`: `~/.local/bin/jcx` and `~/.local/share/trellage/jcx/`
- `omp`: `~/.local/bin/omp` and `~/.local/share/trellage/omp/`
- `picx`: `~/.local/bin/picx` and `~/.local/share/trellage/picx/`
- `prx`: `~/.local/bin/prx` and `~/.local/share/trellage/prx/`
- `trx`: `~/.local/bin/trx` and `~/.local/share/trellage/trx/`

Their isolated profile homes are rooted at:

```text
~/.local/share/trellage/profiles/codex/<profile>/home/
~/.local/share/trellage/profiles/copilot/<profile>/home/
~/.local/share/trellage/profiles/claude/default/home/
~/.local/share/trellage/profiles/grok/<profile>/home/
~/.local/share/trellage/profiles/jcode/default/home/
~/.local/share/trellage/profiles/prime/default/home/
~/.omp/profiles/trellage-qwen-local/
~/.local/share/trellage/profiles/pi/picx-default/
```

The native `omp` launcher is independent of the Docker `pi-oh-my-pi` profile.
It reuses a locally recorded `mise`-resolved Oh My Pi release and provides two
isolated profiles:
`local` routes every built-in model role to keyless
`copilot-proxy-rs/qwen3.6-35b-a3b-local` on
`http://127.0.0.1:8080/v1`, while `copilot` uses OMP's native GitHub Copilot
authentication and discovered models. It uses the same host-auth precedence as
the container profile (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then
`gh auth token`) and on macOS additionally falls back to the existing
`copilot-cli` Keychain credential. It defaults to
`github-copilot/gpt-5.6-sol:medium`:

```bash
omp setup
omp setup copilot
omp doctor
omp doctor copilot
omp models copilot-proxy-rs
omp -p "Reply exactly OMP_LOCAL_OK"
omp copilot -p "Reply exactly OMP_COPILOT_OK"
omp update --check
omp update
omp repair
```

Bare `omp` remains an alias for the `local` profile. `trx` includes both
`oh-my-pi / local` and `oh-my-pi / copilot`.

See the [native OMP guide](prototypes/trellage-omp-profiles/README.md) for
ownership, update, repair, and uninstall behavior.

The standalone `picx` launcher provides one `default` Pi profile with the
ordered ten-extension daily-coding set on the latest stable upstream Pi
release. Setup and explicit update resolve current stable extension packages;
ordinary launches reuse the installed profile. The launcher also provides
isolated user-scope package data, the shared floating `native-common` skills,
disabled host-MCP discovery, and `copilot-proxy-rs/gpt-5.6-sol:medium`. See
the [native picx guide](prototypes/trellage-picx-profiles/README.md).

Managed Codex profiles use the local proxy by default. Native OpenAI authentication
is an explicit per-launch opt-in:

```sh
cdx --native-auth superpowers exec "Review this repository"
```

The native `cldx` launcher runs the host `claude` executable with isolated
state and keyless `copilot-proxy-rs` at `http://127.0.0.1:8080`. It defaults to
`claude-opus-5`; an explicit `--model` argument wins:

```bash
cldx setup
cldx doctor
cldx -p "Reply exactly CLDX_OK"
cldx --model claude-sonnet-5 -p "Reply exactly CLDX_SONNET_OK"
cldx repair
```

No host model credentials are copied. Launch scrubs ambient provider and token
variables before setting only the local proxy environment. See the
[native Claude guide](prototypes/trellage-claude-profiles/README.md).

The native `cdx pstack` profile runs Codex with
[pstack for Codex](https://github.com/Aqua-123/pstack-for-codex), created and
maintained by Aqua-123. It installs only the upstream marketplace plugin in
`~/.local/share/trellage/profiles/codex/pstack/home/`; optional pstack agent
profiles, Poteto Mode activation, and Benny automations are not enabled
automatically.
Its Trellage identity is launcher `cdx`, harness `codex`, and profile
`pstack`.

```bash
cdx setup pstack
cdx doctor pstack
cdx pstack
cdx update --check pstack
cdx update pstack
```

It uses the same native Codex `workspace-write` sandbox and authentication
policy as `cdx`. Node.js is required by upstream hooks and validation. Bun is
optional. Pstack is a Codex profile, so Trellage does not install a `pstack`
executable and does not shadow the Unix debugger with that name.

After the eight native profile launchers and `trx` are installed, list the
available launcher/profile pairs or use one flat picker:

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
mise run trx -- list
mise run trx -- list --json
mise run trx -- guide "Write a LinkedIn post about AI agents"
```

`trx list` prints `launcher/profile` plus the catalog description; `--json`
returns the same discovery data with launcher and harness identity plus a
nested guide projected from `profile-guides/native/*/*.md`. `trx` reads
the launchers' declared catalogs before listing or opening the picker. Picker
rows show `harness / profile`; the detail pane shows the resolved launcher alias,
absolute binary path, exact JSON argument vector, catalog metadata, and readiness
status. After selection, it validates that profile's read-only installed
inventory before launching. Package counts come only from launcher-validated
selected plugin roots
or cache paths; `visibleCount` preserves each native CLI's broader inventory
semantics. `trx` requires a TTY; Escape or Ctrl-C returns `130`. It does not set
up, repair, update, call a model, use the network, or mutate profile state.
The native `jcx` launcher runs jcode against `copilot-proxy-rs`, defaulting to
`gpt-5.6-sol` with `medium` reasoning in an isolated `JCODE_HOME`. Install and
manage it from `prototypes/trellage-jcode-profiles`.

### Profile and prompt guide

Bare `trx` remains the fast, model-free profile search. `trx guide` is a
separate Ink flow that matches an intent across both Trellage Native and
Trellage Sandbox profiles, compares five recommendations, and creates three
editable prompt candidates. By default, matching, Prompt Master optimization,
and refinement use `gpt-5.6-sol` with medium reasoning; candidate drafting uses
`gpt-5.6-luna` with medium reasoning. `--model` forces one model across every
model-backed phase, while `--effort` applies one effort level across the phase
route:

```bash
trx guide --intent "Turn a technical outline into a LinkedIn post"
trx guide --intent "Review this architecture" --model claude-opus-5 --effort medium
```

The last successful profile match is cached under
`${XDG_CACHE_HOME:-~/.cache}/trellage/trx-guide/last-match.json`. Repeating the
same intent with the same model, effort, profile catalog, and authored match
prompt reuses that result without a model call. Changing any key input replaces
the one-entry cache. The cache file uses mode `0600`; recommendation reasons
can contain model-written wording derived from the intent. Prompt generation
and refinement are not cached.

When the selected workflow declares a skill, the guide applies that workflow's
authored Markdown prompt template to generated and refined content. The final
handoff therefore invokes the exact curated skill, such as
`/social-media-skills:post-writer <generated prompt>`. Workflows without a
declared skill keep the generated prompt unchanged.

The guide shows the exact command and asks for confirmation before it starts a
profile, creates a Herdr pane, or creates a Herdr worktree. A profile receives
`-p` only when its published headless contract supports prompt input.
Otherwise, the guide starts the interactive profile and shows the prompt for
manual paste, or sends it through the Herdr agent API after the agent is idle.

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
`profile`, `model`, and `effort` fields. Match responses contain
`phase: "match"` and exactly three enriched `recommendations`. Generation
responses contain `phase: "generation"`, the selected `profile`, and exactly
three prompt `candidates` with path-free command previews. Interactive model
failures can be retried or replaced with deterministic literal/template
fallbacks. Model sessions have no tools, repository attachments, file
tracking, skill loading, or persistent history. Guide content and user intent
are sent only to the selected Copilot model.

The native `prx` launcher runs Prime Agent against `copilot-proxy-rs`, pinning
the provider and model to `copilot-proxy-rs` and `claude-opus-5` (Anthropic
Messages API at `http://127.0.0.1:8080`). It is independent of the Docker
`prime-agent` profile. Install and manage it from
`prototypes/trellage-prime-profiles`:

```bash
prx setup
prx doctor
prx -p "Reply exactly PRX_OK"
prx update --check
prx update
prx repair
```

`PRIME_AGENT_CODING_AGENT_DIR` isolates configuration and sessions under
`~/.local/share/trellage/profiles/prime/default/home/`. Every launch restores
the managed `models.json` provider and selected model so persisted edits cannot
redirect the endpoint. No host model credentials are copied.

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
- `jq`, `gh`, Node.js, and npm on the host.
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

Prerequisites are the installed commands `cdx`, `codex`, `cpx`, `grx`, and `jq`; profiles provisioned for each launcher; and authenticated CLI sessions. The standalone `cldx` and `jcx` launchers have their own contracts and router integration but are not yet part of the plugin-oriented profile matrix. Live verification also requires paid model access.

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

Codex discovery and static checks require the managed `cdx` launcher and isolated profile roots under `~/.local/share/trellage/profiles/codex/`.

Codex live checks bypass managed `cdx` and invoke raw `codex` with the validated isolated `CODEX_HOME` plus ephemeral, read-only, approval-never arguments.

Static verification performs no native marketplace/plugin mutation or live prompt and never runs setup, repair, update, install, uninstall, login, or logout, but `cdx doctor` may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.

Exit statuses:

- `0`: all required checks pass.
- `1`: a required launcher is missing, or discovery, static verification, or live verification fails.
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
    ├── app-inventory.json
    └── artifact-hashes.json
```

`comparison.json` records prompt parity, runtime/provider/model identity, evidence roots, and pass/fail status. It intentionally has no `winner` field, leaving a stable seam for a deterministic rubric or future LLM judge.

See [docs/verification.md](docs/verification.md) for the current live proof and audit commands.
