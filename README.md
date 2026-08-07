# Trellage

Trellage compiles locked agent profiles and runs them in isolated Docker sandboxes while preserving host worktree and Herdr workflows. Install the CLI from `prototypes/trellage`; it defaults to `~/.local/bin/trellage`.

## Trellage Quick Start

```bash
cd prototypes/trellage
mise trust
mise run install-trellage
trellage validate /absolute/path/to/profile.toml
trellage build --locked /absolute/path/to/profile.toml
trellage -i
trellage --profile /absolute/path/to/profile.toml
trellage resume --profile /absolute/path/to/profile.toml SESSION_ID
trellage resume --profile /absolute/path/to/profile.toml
trellage doctor --profile /absolute/path/to/profile.toml
trellage destroy --profile /absolute/path/to/profile.toml
trellage upgrade /absolute/path/to/profile.toml
trellage upgrade all
```

Bundled profiles can also be selected by directory name:

```bash
trellage validate claude-hyperresearch
trellage build --locked claude-hyperresearch
trellage --profile claude-hyperresearch
trellage validate claude-social-media
trellage build --locked claude-social-media
trellage --profile claude-social-media
trellage validate prime-agent
trellage build --locked prime-agent
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

`trellage upgrade all` discovers every valid bundled and current-worktree
profile, applies current-worktree name overrides, and upgrades profiles
sequentially in name order. Each profile refreshes its declared mutable source
refs and `latest` harness selector, builds a candidate image, and atomically
adopts the matching lock and image. A failed profile keeps its prior lock and
image; remaining profiles continue, and the command exits nonzero after
reporting all failures. Exact versions and immutable Git refs remain pinned by
the profile.

Use `trellage -i` or `trellage --interactive` to choose a profile before a new
launch:

```bash
trellage -i
trellage -i -p "hello"
```

The picker combines valid profiles bundled with the installed Trellage source
tree and valid `<current-worktree>/profiles/<directory>/profile.toml` files into
one name-sorted list. A current-worktree profile with the same declared name
replaces the bundled choice. Rows stay concise. The highlighted detail pane
shows the full description plus declared harness version/model, selected plugin
names, skill selections/count, and MCP names/count. The profile remains the
source of truth for those declarations; they are not installed inventory.

Interactive selection requires a terminal and cannot be combined with
`--profile`, resume, lifecycle, or compiler commands. Escape or Ctrl-C cancels
with status `130`. Selection does not install, update, lock, or build a profile;
the chosen profile continues through the normal launch checks.

Bare profile launches open the harness TUI. Use portable `-p` (or `--prompt`) for one plain-text, non-interactive prompt; Trellage returns the native harness exit status:

```bash
trellage --profile codex-superpowers -p "hello"
trellage --profile claude-hyperresearch -p "hello"
trellage --profile claude-social-media -p "draft a LinkedIn post"
trellage --profile claude-council -p "hello"
trellage --profile copilot-hve -p "hello"
trellage --profile pi-oh-my-pi -p "hello"
trellage --profile prime-agent -p "hello"
```

### Claude council

`claude-council` runs Claude Opus 5 through `copilot-proxy-rs` with two Claude
Code marketplace plugins enabled by default:

- [`0xNyk/council-of-high-intelligence`](https://github.com/0xNyk/council-of-high-intelligence) (`council`) for multi-persona deliberation (`/council`)
- [`JuliusBrussee/caveman`](https://github.com/JuliusBrussee/caveman) (`caveman`) for compressed communication mode

```bash
trellage --profile claude-council
```

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
trellage --profile claude-hyperresearch
trellage --profile claude-hyperresearch -p "research this topic"
trellage resume --profile claude-hyperresearch
```

Do not prefix these commands with `varlock`. This keeps the same interface for terminals, scripts, editors, Herdr, and other applications invoking Trellage.

### Default files

The default environment directory is `$XDG_CONFIG_HOME/trellage`, or `~/.config/trellage` when `XDG_CONFIG_HOME` is unset:

```text
~/.config/trellage/
├── config.toml
├── .env.schema
└── .env.local
```

No `config.toml` is required for the default behavior. If the directory has no `.env` files, Trellage continues without Varlock. To supply the Claude Hyperresearch browser extension token:

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
trellage doctor --profile claude-hyperresearch
```

Doctor reports `environment: varlock (ready)` when `.env.local` is available and secure. See the [prototype guide](prototypes/trellage/README.md#automatic-environment-loading) for the complete runtime details.

Profile source files are architecture-neutral editable intent. Production locks currently support native ARM64 only. `trellage` recognizes AMD64 for future lock selection, but rejects it before downloads or Docker mutation until a complete AMD64 artifact catalog and lock are available. `trellage lock` resolves sources and native artifacts only for the Docker server platform. Reproducible builds use `--locked` and reject profile, platform, artifact, or digest drift.

A GitHub blob URL also works for locked builds and launches. Trellage resolves the revision once and fetches the profile and selected sibling lock from that same commit:

```bash
trellage build --locked https://github.com/engineersamuel/trellage/blob/v1.0.0/profiles/copilot-hve/profile.toml
trellage --profile https://github.com/engineersamuel/trellage/blob/v1.0.0/profiles/copilot-hve/profile.toml
```

See [the Trellage prototype guide](prototypes/trellage/README.md) for profile locks, lifecycle details, Copilot with HVE Core, cleanup, and deterministic verification.

## Prime Agent

The bundled `prime-agent` profile installs Prime Agent from Prime Intellect's
official stable release channel and locks the resolved versioned tarball, size,
SHA-256 digest, and final Linux/arm64 OCI digest. It routes model traffic only
through the host-managed `copilot-proxy-rs` service and fixes the provider and
model to `copilot-proxy-rs` and `claude-opus-5`.

```bash
trellage validate prime-agent
trellage build --locked prime-agent
trellage --profile prime-agent
trellage --profile prime-agent -p "review this repository"
trellage resume --profile prime-agent
trellage doctor --profile prime-agent
```

The proxy must already be reachable on Docker network
`copilot-proxy-rs_default`. Prime receives no host model credentials; Trellage
manages its Anthropic Messages provider seed under `/home/agent/.prime/agent`
and preserves Prime sessions and other user state in the profile/worktree state
volume. The locked image build also prepares a Python kernel archive that each
state volume restores locally, so tool use does not depend on first-launch
access to PyPI. Every launch restores the managed provider definition so
persisted edits cannot redirect this profile to another endpoint or model.

## Pi with Oh My Pi

The bundled `pi-oh-my-pi` profile runs the standalone `omp` executable from
`can1357/oh-my-pi`. It is distinct from GitHub Copilot CLI: OMP uses its native
`github-copilot` provider with model `gpt-5.6-terra`. The profile also locks and
seeds OMP's `semantic-compression`, `system-prompts`, and
`tool-prompt-optimization` skills into the isolated OMP state directory.

```bash
trellage validate pi-oh-my-pi
trellage build --locked pi-oh-my-pi
trellage --profile pi-oh-my-pi
trellage --profile pi-oh-my-pi -p "review this repository"
trellage resume --profile pi-oh-my-pi
trellage doctor --profile pi-oh-my-pi
```

Authentication precedence is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`,
then `gh auth token`. Without a host token, OMP can complete its native GitHub
Copilot login interactively. Host tokens are forwarded only to the OMP process;
login and session state persist in the isolated profile/worktree state volume
under `/home/agent/.omp/agent`. The profile uses Docker `bridge`, not
`copilot-proxy-rs_default`.

The editable profile pins the same OMP release tag for both the executable and
its native skills. The selected platform lock records the exact source commit, source
inventory, release asset URL, size, GitHub SHA-256 digest, and built OCI digest.
Locked builds never resolve a newer release.

## Trellage Native (`trx`)

Use **Trellage Sandbox** for the Docker-based CLI and isolated container
profiles described above. Use **Trellage Native** for `trx` and its host-native
profile launchers. Native launchers isolate agent state but run directly on the
host.

Install the four agent launchers and optional profile router from the repository
root:

```bash
(cd prototypes/trellage-codex-profiles && ./install.sh)
(cd prototypes/trellage-copilot-profiles && ./install.sh)
(cd prototypes/trellage-grok-profiles && ./install.sh)
(cd prototypes/trellage-omp-profiles && ./install.sh)
(cd prototypes/trellage-router && ./install.sh)
```

The installers publish these commands and managed runtimes:

- `cdx`: `~/.local/bin/cdx` and `~/.local/share/trellage/cdx/`
- `cpx`: `~/.local/bin/cpx` and `~/.local/share/trellage/cpx/`
- `grx`: `~/.local/bin/grx` and `~/.local/share/trellage/grx/`
- `omp`: `~/.local/bin/omp` and `~/.local/share/trellage/omp/`
- `trx`: `~/.local/bin/trx` and `~/.local/share/trellage/trx/`

Their isolated profile homes are rooted at:

```text
~/.local/share/trellage/profiles/codex/<profile>/home/
~/.local/share/trellage/profiles/copilot/<profile>/home/
~/.local/share/trellage/profiles/grok/<profile>/home/
~/.omp/profiles/trellage-qwen-local/
```

The native `omp` launcher is independent of the Docker `pi-oh-my-pi` profile.
It pins a `mise`-resolved Oh My Pi release and provides two isolated profiles:
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

Bare `omp` remains an alias for the `local` profile. `trx -i` includes both
`oh-my-pi / local` and `oh-my-pi / copilot`.

See the [native OMP guide](prototypes/trellage-omp-profiles/README.md) for
ownership, update, repair, and uninstall behavior.

Managed Codex profiles use the local proxy by default. Native OpenAI authentication
is an explicit per-launch opt-in:

```sh
cdx --native-auth hve exec "Review this repository"
```

After `cdx`, `cpx`, `grx`, and `trx` are installed, use one flat
harness/profile picker:

```bash
trx -i
trx -i --model gpt-5
```

`trx` reads the launchers' declared catalogs before opening the picker, so rows
show only `harness / profile` and the detail pane shows the catalog description.
After selection, it validates that profile's read-only installed inventory before
launching. Package counts come only from launcher-validated selected plugin roots
or cache paths; `visibleCount` preserves each native CLI's broader inventory
semantics. `trx` requires a TTY; Escape or Ctrl-C returns `130`. It does not set
up, repair, update, call a model, use the network, or mutate profile state.
The native `jcx` launcher runs jcode against `copilot-proxy-rs`, defaulting to
`gpt-5.6-sol` with `medium` reasoning in an isolated `JCODE_HOME`. Install and
manage it from `prototypes/trellage-jcode-profiles`.

Native profiles run directly on the host and are state-isolation conveniences,
not security boundaries.

## Generic Evaluation Harness

This repository runs multiple coding-agent configurations against the same prompt without loading their plugins, skills, hooks, sessions, caches, or configuration into the host harness.

The included comparison builds the same TODO app twice:

- Codex CLI with a pinned `wshobson/agents` plugin, using `copilot-proxy-rs` for model calls.
- GitHub Copilot CLI with pinned `github/awesome-copilot` plugins, using native GitHub Copilot authentication.

Each contestant gets its own image, Compose project, network, workspace volume, app-data volume, session, and loopback port. The output is normalized evidence for later grading; the harness does not select a winner.

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

Prerequisites are the installed commands `cdx`, `codex`, `cpx`, `grx`, and `jq`; profiles provisioned for each launcher; and authenticated CLI sessions. The standalone `jcx` launcher has its own contract and router integration but is not yet part of the plugin-oriented profile matrix. Live verification also requires paid model access.

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

Codex discovery and static checks require the managed `cdx` launcher and its isolated profile roots under `~/.local/share/trellage/profiles/codex/<profile>/home`.

Codex live checks bypass managed `cdx` and invoke raw `codex` with the validated isolated `CODEX_HOME` plus ephemeral, read-only, approval-never arguments.

Static verification performs no native marketplace/plugin mutation or live prompt and never runs setup, repair, update, install, uninstall, login, or logout, but `cdx doctor` may atomically remove only exact Codex-generated project-trust stanzas during stale recovery.

Exit statuses:

- `0`: all required checks pass.
- `1`: a required launcher is missing, or discovery, static verification, or live verification fails.
- `2`: invalid usage.

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
./scripts/harness serve    harnesses/todo-side-by-side/harness.json
./scripts/harness verify   harnesses/todo-side-by-side/harness.json
HARNESS_RUN_ID=my-run ./scripts/harness collect harnesses/todo-side-by-side/harness.json
./scripts/harness down     harnesses/todo-side-by-side/harness.json
./scripts/harness purge    harnesses/todo-side-by-side/harness.json
```

- `run` creates new retained agent sessions and runs contestants concurrently.
- `resume` continues both retained sessions with the shared prompt.
- `serve` publishes the generated runtime artifacts and starts both apps.
- `verify` runs each app's own test/type/lint/build/audit checks, recreates clean app processes, runs the shared CRUD flow, recreates each app again, and proves SQLite persistence.
- `collect` exports normalized, secret-scanned evidence and refuses to overwrite an existing run ID.
- `down` stops containers but preserves workspaces, sessions, and app data.
- `purge` permanently removes both contestant projects and their named volumes.

Use another manifest with Make:

```bash
make compare HARNESS=harnesses/my-comparison/harness.json
```

## Define a Comparison

Copy the existing harness directory and edit its manifest and prompt. Keep contestant IDs and ports unique.

Each package entry contains:

- `source`: the repository supported by that runtime adapter.
- `ref`: an exact 40-character Git commit SHA.
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
