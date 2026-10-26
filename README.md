# Trellage

Trellage routes Native development agents through `trx run <harness> <profile>`.
Native harnesses run on the host; they are not containers or security
boundaries.
Install the Native router and private backends from `prototypes/trellage-router`.

## Fresh Machine Setup (macOS)

These are the one-time prerequisites for Native Trellage on macOS. Skip
anything already installed. Docker is optional and is only needed for the
comparison harness or services that use Docker.

```bash
# 1. mise (task runner / tool version manager)
brew install mise

# 2. Bun (Trellage source runtime) and Node.js (external agent tools)
mise use --global bun@1.4.2
brew install node

# 3. GitHub CLI, authenticated
brew install gh
gh auth login

# 4. Install and authenticate the harnesses you plan to use.
brew install copilot-cli
copilot -p "Reply exactly OK"

# Claude Code, Pi, Codex, and other harnesses must also be installed on the host
# before their Native routes can run.
```

## Trellage Quick Start

Prepare the locked source workspace once from the repository root:

```bash
mise trust
mise install
scripts/install-source-runtime.sh --prepare
```

Trellage runs TypeScript and TSX source through Bun. It does not need a generated
harness bundle, guide-core output, or a profile-compiler build. Type checking
remains separate. Preparation installs frozen dependencies and records runtime
readiness; a raw `bun install` alone does not prepare a usable runtime.
See the [source-runtime decision](docs/adr/0005-bun-source-runtime.md).

First run in a repo worktree with a Native route:

```bash
mise trust
mise run trx -- run copilot hve -- -p "Reply exactly OK"
```

Codex native and comparison profiles use the upstream Pro preset:
`gpt-6-astra` with `medium` reasoning, Luna execution subagents with `max`
reasoning, and an Astra reviewer with `low` reasoning. Up to four subagents
can run concurrently. Copilot retains Astra with `low` reasoning. Plan mode uses Astra with `max` reasoning. Explicit harness model and reasoning
arguments override the default mode settings.

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
and installs the Native runtime from that source on the VM.

The acceptance workflow requires an Azure CLI login,
`COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `gh auth token`) for Native Copilot
GitHub access, and `COPILOT_PROXY_GITHUB_TOKEN` (or the safe
mode-0600 `~/.config/copilot-proxy-rs/github_token`) for
`copilot-proxy-rs`. It streams the tokens to the remote process and writes
them only to mode-0600 files under VM `/dev/shm`. The temporary GitHub CLI
file is removed when acceptance exits. The proxy mounts its separate tmpfs
path read-only, binds its host port to `127.0.0.1`, and disables failed
request-body logging. No host credential file is copied.

The workflow verifies one exact `OK` response from each Native pair through
`trx run`: `copilot/hve`, `codex/pstack`, `claude/default`, composed
`grok/superpowers`, `jcode/default`, `omp/default`, `pi/default`, and
`prime/default`. `trx run` resolves the same composition catalog as `trx list`.

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

Skill sources and bundles are approved in your `~/.config/trellage/config.toml`.
Copy [`config.example.toml`](config.example.toml) to start with the shipped defaults.
Profiles select bundle names with `skill_bundles`; they do not store skill
refs or digests. Wildcard sources may declare an `exclude` list for skills
that must never enter any consuming bundle and a `required` list that makes
materialization fail if an expected skill is absent. The `engineersamuel`
source requires `ui-guidelines` in both `native-common` and
`comparison-common`. A skill-bearing rebuild is therefore not byte-reproducible.

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
| Claude Code, Grok | `/i-have-adhd` |
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
`~/.headlong/.trellage/skills/i-have-adhd/SKILL.md`.
It is not registered with Headlong's `skills show` command.

The built-in agent profiles use Native routes:

```bash
trx run claude research
trx run claude blog
trx run claude council
trx run claude ecc
trx run claude frontend-design
trx run claude social-media
trx run headlong default
```

`trx` is the only Trellage entrypoint. The former Sandbox CLI (`trellage`),
its container profile compiler, and its `profiles/` definitions are retired.

Trust the root mise config once per worktree; mise trust is keyed by its
absolute path:

```bash
mise trust
mise run trx -- run prime default -- -p "Reply exactly OK"
```

Prepare application dependencies explicitly with
`scripts/install-source-runtime.sh --prepare` in the source workspace. Normal
execution does not install missing application packages.

### Native Claude profiles

Claude profiles run on the host through the Native adapter and local
`copilot-proxy-rs` service. Install Claude Code and start the proxy before
launching a profile:

```bash
trx run claude default
trx run claude research
trx run claude blog
trx run claude council
trx run claude ecc
trx run claude frontend-design
trx run claude social-media
```

The six specialized routes have detailed workflows in
[`profile-guides/native/claude`](profile-guides/native/claude). Social-media
workflows can use `APIFY_API_TOKEN` and `GOOGLE_AI_API_KEY` when you configure
those integrations. Native runs use your host access; they are not contained
by Trellage.

### Decide: council and six-hats

In `trx guide`, `c` opens the Decide chooser on the recommendations screen:
`c` starts `trx run claude council` and `6` starts `trx run claude six-hats`.
Both open Claude interactively with the generated prompt
(`trx run claude six-hats -- '<prompt>'`), so the session stays open after the
round. Both Decide workflows stay out of normal ranking unless the request
names the profile.

`six-hats` loads this repository's `plugins/six-hats` plugin for that session
only (the `preset-claude-six-hats` profile in [`config.example.toml`](config.example.toml)): six
hat subagents and `/six-hats:decide`. White runs first; red, yellow, black, and
green run in parallel on its facts; then blue returns one plan. Green copies the
checkout's tracked and untracked, non-ignored files (including uncommitted
edits) into `.six-hats/green-<time>/`, ignored through `.gitignore` and the
local `info/exclude`, and commits its attempts there. A round ends with
`Six Hats round complete`; a failed hat is reported and blue still runs.

Native sources normally resolve from GitHub. To test unpushed plugin changes,
run `trx` through `mise` in the worktree: `mise.toml` sets
`TRELLAGE_DEV_SOURCES` to map `https://github.com/engineersamuel/trellage.git`
to the worktree, so composition snapshots the worktree's current files
(tracked and untracked, not ignored) into a deterministic local commit without
changing its index, HEAD, or refs. The variable takes whitespace-separated
`<repository>=<absolute path>` pairs.
## Automatic Varlock Environment Loading

Trellage bundles Varlock and uses it automatically for Native profile launches
that declare required environment variables. Invoke `trx` directly:

```bash
trx run claude research
trx run codex youtube
trx
trx list --json
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

No `config.toml` is required for the default behavior. If the directory has no `.env` files, Trellage continues without Varlock. To supply a required environment variable:

```dotenv
# ~/.config/trellage/.env.schema
# @sensitive
EXAMPLE_TOKEN=
```

```dotenv
# ~/.config/trellage/.env.local
EXAMPLE_TOKEN=replace-with-token
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
selected profile. It then removes the key from the harness environment before
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

A profile's `harnesses` list also limits where it can be selected: other
harnesses refuse it, and the `trx run` menu shows it dimmed. Three optional
fields change where the harness runs:

- `current_working_directory = "~/path"` starts the harness in that absolute or
  `~/` directory instead of the directory where `trx run` was invoked.
- `repository = { url = "...", branch = "main" }` clones that repository into
  the directory when it is missing, and runs `git pull --rebase origin BRANCH`
  before every launch (not on `--dry-run`). A failed pull stops the launch.
- `project_resources = true` makes Pi load the directory's own
  `.pi/extensions/*.ts` and `.agents/skills/*` explicitly; other trx isolation
  stays. Claude already loads the directory's `.claude` settings and skills.

`prerequisites = [{ command = "tool", install = "shell command" }]` lists
executables the profile needs. Before launch (not on `--dry-run`), trx lists
missing ones with their install commands and asks to install them; without a
terminal, or when you answer no, it stops. `--dry-run` marks them `(missing)`.

`trx run list` and `trx guide` also offer `claude/firstmate` and `pi/firstmate`.
Their guides (`profile-guides/native/{claude,pi}/firstmate.md`) teach the
guide's model the Firstmate message shape: `ahoy!` with the project and
delivery mode, numbered `SCOUT`/`SHIP` tasks with a `Done when:` line each,
explicit parallel and wait conditions, a `/bearings` request, captain merge
authority, and a closing "Ask me before…" line. Workflows: `fleet-delivery`,
`fleet-investigation` (scouts only) and `fleet-status` (no new work). The
guide launches `trx run claude firstmate` with the message as Firstmate's first
turn; for `pi firstmate` it hands the message over to paste. `trx admin` and
`trx upgrade all --dry-run` include these config-backed compositions in their catalog views.

The shipped `firstmate` profile uses all four to run
[Firstmate](https://github.com/kunchenguid/firstmate) on `claude` or `pi`:
`trx run claude firstmate`. It requires `git`, `gh`, `jq`, `node`,
`treehouse`, `gh-axi` and `tasks-axi`, with the install commands from
Firstmate's `bin/fm-bootstrap.sh`. Add `no-mistakes` or `quota-axi` to your own
copy of the profile if you use no-mistakes delivery or quota profiles.
Firstmate starts its workers in new terminal panes that do not inherit the
supervisor's environment, so the profile sets `workers = "firstmate"`:

- Claude: trx writes the proxy variables (`ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, model names) into the generated `settings.json` `env`
  block. Workers already receive the supervisor's `CLAUDE_CONFIG_DIR`, so they
  reach copilot-proxy-rs instead of asking for a login.
- Pi: trx writes Firstmate's `config/pi-account` (the generated Pi directory and
  provider `copilot-proxy-rs`) and a default-only `config/crew-dispatch.json`
  that sends workers to Pi with the supervisor's model and effort. A Claude run
  removes those two files again. trx never replaces or removes a version of
  either file it did not write; it stops and names the file instead.
- Worker shells start fresh and may not read your shell config (Claude runs
  commands in zsh even when you use fish). trx puts the mise shims,
  `~/.local/bin` and `/opt/homebrew/bin` (those that exist) in front of `PATH`:
  Claude through the `settings.json` `env` block, Pi through its
  `shellCommandPrefix` setting.
- Generations that started workers are kept for 7 days after the last launch,
  so pruning never removes a directory a live worker uses.

Firstmate keeps its own projects under its clone;
ask it to add the repository you work on. It does not see uncommitted changes
in your worktree.

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

### Native profile configuration

The shared config reader accepts `schema_version = 1` and Native profile
definitions alongside `[environment]`. Existing environment-only files need no migration.
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

## Native harness routes

The built-in Claude, Headlong, Prime, and OMP routes run on the host:

```bash
trx run claude default
trx run headlong default
trx run prime default
trx run omp default
```

Headlong keeps its persistent identity and memory under `~/.headlong`, and its
dashboard binds to loopback port 18080. Install the upstream `ada` and
`headlong-init` commands and start `copilot-proxy-rs` before the first run.
Headlong continues after its TUI exits; use `ada stop` to stop it and
`ada start` to resume it. See
[`profile-guides/native/headlong/default.md`](profile-guides/native/headlong/default.md).

## Trellage Native (`trx`)

Use **Trellage Native** for the built-in routes. They isolate agent state but
run directly on the host, without a Trellage container or security boundary.

### Fresh-machine onboarding

`trx` resolves a composition catalog from built-in presets and `config.toml`, then routes each harness to its adapter.
Install the dependencies for the harnesses you use. On a brand-new machine:

1. **Confirm `~/.local/bin` is on `PATH`.** The router installer places `trx`
   there; harness installers register private backends. Add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile if
   it is missing, then reload the shell.
2. **Install only the underlying agent CLIs you actually use**. Each harness
   needs only its own dependency:
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
   - JCode and Pi need `mise` and `curl`; first use resolves their selected
     runtime according to each backend's lifecycle.
   - OMP needs a host-installed `omp` executable, `jq`, and `curl`. Bun,
     Homebrew, and mise are supported owners for automatic update/check;
     manually maintained executables also work for setup and launch. Trellage
     does not install or pin a private OMP copy.
   - Prime Agent needs `mise`, Node 22+, `npm`, `curl`, `jq`, **and
     `uv`** (`mise use -g uv` if it is not already on `PATH`) to bootstrap its
     Python kernel venv.
3. **Browse with `trx list`.** Listing does not require every harness to be
   installed. Launch with `trx run HARNESS [PROFILE...]`.
4. Claude, JCode, Prime, Pi, Grok, and the default Codex provider use
   the keyless `copilot-proxy-rs` service at `http://127.0.0.1:8080`. Start
   that proxy and make sure it has a valid GitHub Copilot device-flow login
   before using those harnesses. A `401` or `GitHub OAuth device flow is not
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
(cd prototypes/trellage-copilot-profiles && ./install.sh)
(cd prototypes/trellage-agency-profiles && ./install.sh)
(cd prototypes/trellage-claude-profiles && ./install.sh)
(cd prototypes/trellage-jcode-profiles && ./install.sh)
(cd prototypes/trellage-omp-profiles && ./install.sh)
(cd prototypes/trellage-prime-profiles && ./install.sh)
(cd prototypes/trellage-router && ./install.sh)
```

Then set up each Trellage-managed backend you plan to use and confirm it is
healthy before launching, for example:

```bash
trx setup copilot --all
trx setup agency azure
trx setup jcode
trx setup omp default
trx setup prime
trx doctor copilot awesome
trx run list
```

Pi and Codex are installed and updated outside Trellage. Use
`trx inventory pi PROFILE --json` or `trx inventory codex PROFILE --json` to
inspect them. The six private backends repair launch-required state on demand,
so a separate setup step is optional.

For harness versions and skills, use `trx admin`: it shows every launchable
composition, including built-in presets and optional `config.toml` profiles.
Harness version checks are deduplicated per shared runtime. Lifecycle-backed
rows receive bounded startup inventory checks; other rows load inventory only
when selected. Version changes show `current -> target`, with configured pins
kept. Failed or incomplete checks are listed separately and are not treated as
current. Press `A` to check available managed updates, then `y` to run the
displayed selection after the checks finish. `U` updates the selected managed
harness group.
For a full maintenance run through the same queue, use:

```bash
trx upgrade all --dry-run  # Preview without updating harnesses or skills.
trx upgrade all            # Preview, then ask for confirmation.
trx upgrade all --yes      # Run without an interactive confirmation.
```

These actions update Trellage-managed shared Native runtimes once, refresh the
shared skill caches, then copy and verify skills for lifecycle-backed profiles.
The final Native skill copies cannot be overwritten by a later harness updater.
Profile version and source pins are preserved. Codex, Pi, Grok, Uji, Fx,
Headlong, and Agency updates are externally managed and appear as informational
entries, not failures. Real failures are reported while independent updates continue. This
does not install Trellage or restart sessions.

Your `~/.config/trellage/config.toml` is the skill source of truth for Native
and comparison profiles. The shipped defaults are in
[`config.example.toml`](config.example.toml). Sources with an explicit commit
or tag stay pinned during launch.
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

Reinstall the Native backends before refreshing skills after a catalog or
shared-helper change. For `i-have-adhd`, the updated JCode adapter must be
installed before `trx skills update`; publishing only the catalog is not enough.
Then synchronize the refreshed skills with `trx upgrade HARNESS PROFILE --skills-only`, or let its next normal launch sync the cache. Existing comparison images must be rebuilt with the updated Trellage compiler and runtime.


GitHub Copilot Native runs use `trx run copilot PROFILE`.

Native lifecycle commands use the same identity, for example
`trx setup agency azure`, `trx doctor omp default`, and
`trx inventory claude default --json`.

Their isolated profile homes are rooted at:

```text
~/.local/share/trellage/profiles/codex/<profile>/home/
~/.local/share/trellage/profiles/copilot/<profile>/home/
~/.local/share/trellage/profiles/agency/<profile>/home/
~/.local/share/trellage/profiles/claude/default/home/
~/.local/share/trellage/profiles/jcode/default/home/
~/.local/share/trellage/profiles/prime/default/home/
~/.omp/profiles/trellage-qwen-local/
```

The native `omp` backend uses the host-installed `omp` executable and provides two isolated profiles:
`local` routes every built-in model role to keyless
`copilot-proxy-rs/qwen3.6-35b-a3b-local` on
`http://127.0.0.1:8080/v1`, while `default` uses OMP's native GitHub Copilot
authentication and discovered models. Trellage does not install or pin a
private OMP copy. A valid manually maintained host executable is enough for
setup, launch, repair, doctor, and inventory. Bun, Homebrew, and mise are the
supported owners for automatic update and latest-version checks; use one of
these commands when that owner is detected:

```text
bun update -g --latest @oh-my-pi/pi-coding-agent '@oh-my-pi/pi-natives*'
brew upgrade can1357/tap/omp
mise upgrade github:can1357/oh-my-pi
```

The wrapper resolves and checks the host executable on every setup, launch,
doctor, inventory, and update command. Unknown ownership fails update and
check but does not block setup, launch, repair, doctor, or inventory; update a
manually maintained binary with the mechanism that installed it. The default
profile uses the same host-auth precedence as the container profile
(`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`) and
on macOS additionally falls back to the existing `copilot-cli` Keychain
credential. It defaults to `github-copilot/gpt-5.6-sol:medium`:

```bash
trx setup omp local
trx setup omp default
trx doctor omp local
trx doctor omp default
trx run omp local -- -p "Reply exactly OMP_LOCAL_OK"
trx run omp default -p "Reply exactly OMP_COPILOT_OK"
trx upgrade omp default --check
trx upgrade omp default
trx repair omp default
```

`trx run omp default` uses native Copilot. `trx run omp local` preserves the
former bare-`omp` local Qwen setup and its separate state. Trellage leaves each
profile's `config.yml`, Copilot `models.yml`, authentication, sessions, caches,
history, and unrelated state byte-for-byte unchanged. The local profile's
`models.yml` is the one provider-file exception because OMP has no equivalent
overlay mechanism.

The wrapper composes policy through `PI_CONFIG_FILES`: an existing list is
preserved and the Trellage profile overlay is appended last. Explicit OMP
`--config` arguments load later and override the overlay. The common policy
disables startup update checks and marketplace auto-update, sets `yolo` tool
approval, enables Git protection and secret handling, and uses streaming cache
warming.

Headless capability publication is conservative. The OMP harness accepts
`--headless-policy no-user-input` for either profile only at exact OMP 18.8.5;
the default profile publishes the verified prompt/text contract, while the
local profile remains conservative and unverified because it has no live smoke
contract for the local route. Other versions publish conservative metadata and
fail closed after an unverified upgrade; keeping OMP current does not itself
establish headless compatibility.

See the [native OMP guide](prototypes/trellage-omp-profiles/README.md) for
ownership, update, repair, and uninstall behavior.

Pi profiles use the host-installed `pi` executable. Trellage composes their
configuration at launch but does not install or update Pi.

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

The native `trx run codex pstack` profile runs Codex with
[open-pstack](https://github.com/ericlitman/open-pstack), the Claude Code
and Codex port of Cursor pstack maintained by Eric Litman. It installs only
the upstream marketplace plugin in
`~/.local/share/trellage/profiles/codex/pstack/home/`. Codex exposes its skills
with the plugin namespace, such as `$pstack-for-codex:poteto-mode`; the shorter
`$poteto-mode` name is only the upstream hook's activation marker, not the
installed skill identity. Poteto prompts use both forms. Optional pstack agent
profiles, Poteto Mode cross-turn activation, and Benny automations are not
enabled automatically.
Its Trellage identity is harness `codex` and profile
`pstack`.

Configs created before the switch to open-pstack still set
`[native.sources.pstack] repository = "aqua-123/pstack-for-codex"`. A local
`pstack` profile keeps using that repository with no warning. Without a local
`pstack` profile, `trx run codex pstack` fails with `source pstack conflicts
with shipped preset`. To move to open-pstack, edit `~/.config/trellage/config.toml`:
set `repository = "ericlitman/open-pstack"` and remove any `commit` pin under
that source, because Aqua-123 commits do not exist in open-pstack.

```bash
trx setup codex pstack
trx doctor codex pstack
trx run codex pstack
trx upgrade codex --check pstack
trx upgrade codex pstack
```

Like all managed Codex profiles, it uses Full Access by default: no command approval
prompts and no Codex OS sandbox. Commands run with the host account's
permissions. Authentication policy is unchanged. Node.js is required by
upstream hooks and validation.
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

After installing `trx` and the desired harness backends, open the run composer
or list the same available harnesses and profiles:

```bash
trx
trx run copilot hve
trx list
trx list --json
trx guide
trx guide "Write a LinkedIn post about AI agents"
trx run --model gpt-5.6-terra
```

Use `mise run trx -- ...` to run the router from the current worktree without
replacing the installed native command:

```bash
mise run trx
mise run trx -- run agency azure
mise run trx -- run list
mise run trx -- run list --json
mise run trx -- guide "Write a LinkedIn post about AI agents"
```

`mise run trx -- run agency azure` launches `agency/azure` without opening the
composer. Arguments after `--` pass unchanged to the Agency-managed Copilot CLI.

`trx list` prints a harness table with built-in presets and a profile table with
harness limits and `always` or `optional` mode. `trx list --json` returns schema
version 2. Its `harnesses` entries include the presets and all profile names that
`trx run HARNESS [PROFILE...]` accepts. Its `profiles` entries describe config,
shared, and special profiles. Both forms use the run composer's resolution.

Bare `trx` opens the model-free run composer. Select a harness, compatible
profiles, model, effort, flags, and agent arguments. Enter launches in the
current pane. In a Herdr pane, `H` opens a right-hand pane in the current Git
worktree and runs the composed command there. Browsing does not set up, repair,
update, call a model, use the network, or mutate profile state.
Launching prepares the selected profile and attempts to refresh floating skills.
The native `jcode` backend runs jcode against `copilot-proxy-rs`, defaulting to
`gpt-5.6-sol` with `medium` reasoning in an isolated `JCODE_HOME`. Install and
manage it from `prototypes/trellage-jcode-profiles`.

### Profile and prompt guide

`trx guide` is a separate Ink flow that matches an intent across the composition
catalog, compares five recommendations, and creates three editable prompt
candidates. An approved goal instead gets one to five compatible
recommendations and three editable execution approaches.
Matching first uses TypeSafe Jev (`jev-1.13.0`) with the compact composition
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

By default, guide tasks select their model through copilot-proxy-rs:
`POST http://127.0.0.1:8080/v1/models` with `{"input":"task prompt and instructions"}`.
The proxy uses Jev and returns `recommended.id`; guide uses that model with
`medium` reasoning. This covers fallback matching, drafting, Prompt Master,
refinement, enrichment, Goal me, Optimize, reviews and their workers, and
continuation/engagement assessments. Draft and optimize progress shows the
selected models once routing completes. Large prompts use marked routing
excerpts within the endpoint's 16 KiB limit; execution still receives the full input.

The proxy needs its own `TYPESAFE_API_KEY` configuration. An unavailable or
invalid recommendation stops the task with an error. `--model` or
`TRELLAGE_GUIDE_MODEL` bypasses automatic model selection; `--effort` or
`TRELLAGE_GUIDE_EFFORT` overrides medium. These overrides also apply to Goal me
and reviews. Jev's direct profile-matching and decision gates remain independent.
Intent input accepts up to 60,000 characters:

```bash
trx guide --intent "Turn a technical outline into a LinkedIn post"
trx guide --intent "Review this architecture" --model claude-opus-5 --effort medium
trx guide "$(cat /tmp/large-prompt.md)" --ui-variant pager
```

### Optimize the repository

Press `o` in `trx guide` (on the intent screen with an empty draft, or on
profile recommendations) to open **Optimize**. Optimize works on the whole
repository as it is now, not on a change set. It does not freeze evidence,
review, or approve findings.

1. Select one or more skills with Space: **First principles**, **Behavior
   preservation**, **Improve codebase architecture**, or **UI and CSS** (modern
   CSS rules from [good-css.com](https://good-css.com)).
2. Choose where the agent runs:
   - **Copilot SDK in this terminal**: Guide runs a Copilot agent in the
     repository with every tool and permission approved. Activity streams on
     screen; Esc stops it.
   - **Agent harness in this terminal**, **a new Herdr tab**, or **a new Herdr
     worktree**: choose Copilot, Codex, or Claude. Guide composes the harness
     with only the selected skills' managed skills (`trx run HARNESS
     --no-always --skill OWNER/REPO:NAME ...`), not a configured profile. The
     harness keeps its own permission settings.

`trx run HARNESS --skill OWNER/REPO:NAME` adds a single skill from a GitHub
repository without a configured profile; repeat it for more skills.

Skills are defined in `packages/trellage-launcher/src/guide-optimize.ts`.
**Improve codebase architecture** downloads its managed skills (bundle
`guide-optimize-architecture`) before every run, so they need not be installed
first. The agent must not stage, commit, or push.

Test Optimize offline with `bun run test test/guide-ui.integration.test.ts` in
`packages/trellage-launcher`. Run it for real against the Copilot SDK on a
throwaway repository with `mise run trx-optimize-test -- --live` (uses quota;
add `--skill ID` to choose skills).

For committed and working-tree changes, `trx guide --review` opens **Review
changes** with no checks selected. It offers three checks: **Ponytail Review**,
**Fleet Review**, and **Matt Pocock Code Review**. It accepts `--base`,
`--intent`, `--model`, and `--effort`; model overrides also apply to guarded
Fleet workers, not to the eventual Native profile.

Ctrl-R at an empty intent screen and Herdr's
**Review changes** popup open this same flow. Returning to Guide preserves its
draft, goals, forks, and queued jobs. The popup uses the invoking worktree.
Direct entries do not use profile matching or Prompt Master. The guide loads
Native profiles only when a handoff needs them, so a missing implementation
profile does not block review.
Opening setup or history makes no model calls and downloads no skills.

Choose the scope and files, select checks, then confirm model use. Consent shows
the model overrides or automatic routing policy, workers, sharing scope, and bounded follow-up work.
Ponytail looks for removable complexity,
Fleet runs six specialist passes, and Matt runs a Standards pass.
The current Guide flow has no verified spec input, so Matt runs one Standards
worker and explicitly marks the Spec axis unavailable. It does not invent
requirements or claim two workers ran. If a selected skill is missing from an
existing Native cache, Review refreshes the approved shared skill bundle once
before it starts; unsafe cache content and refresh failures stop the run.
Jev selects a model for each selected review, worker lens, and coordinator from
the frozen evidence and task description, with medium effort by default. The
run records those selections. Fleet’s guarded worker hook supplies each approved
lens with the frozen diff and pins its selected model; unknown or duplicate
workers are denied.
Choose committed plus uncommitted changes with a detected local comparison base,
or uncommitted changes only. Press `b` to override the base. Comparisons use the
merge base, so commits only on the base branch stay out of scope. No fetch or
rebase is required. Detached HEAD and repositories without an initial commit
are supported where the selected checks permit them.
Staged, unstaged, deleted, and non-ignored untracked files can be selected.
Use Space to include or exclude files. An empty scope does not expand to the
repository or silently select the last commit. Reviews can include binary
patches and link-target metadata without following links.
The confirmed target is rechecked before model work. Escape cancels a run.
All checks use projections of one frozen target, with one run ID, one history
record, and one combined synthesis. Ponytail and Matt reports receive structured extraction;
their original reports remain available. Ungrounded findings stay read-only.
A partial or failed review cannot become an all-clear or authorize edits.
Matt's Standards pass uses documented standards from the review base, so
committed or uncommitted changes under review cannot set their own rules.
Checks receive the frozen patch, not a broader source snapshot.
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
Existing `.trx-review-*` reports remain where
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
`trx run copilot hve -- --plan -i` instead of invoking the private backend directly.
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

To add a leaf review, declare its exact skill in your
`~/.config/trellage/config.toml` and
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
- **Firstmate** packs this repository the same way and rewrites the draft as
  one message for a Firstmate session (`trx run claude firstmate`): a greeting,
  a project add line with the GitHub `owner/name` and base branch read from
  `origin` (delivery `direct-PR` unless the draft asks for another), numbered
  tasks that name real files, one `Done when:` line per task, and an order only
  where one task depends on another. It uses the `enrich` model route and
  `prompts/firstmate.md`. Paste the result into Firstmate.
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

Goal me selects its interview model through the proxy's Jev router, with
`medium` effort unless overridden. The guide's general `--model` and `--effort`
overrides apply to the interview. The skill loads only
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
though they also have pinned shortcuts. The broad Council, Six Hats, Research,
and HVE RPI workflows remain optional lenses unless explicitly requested. This
exclusion applies to those workflows, not every workflow on their profiles.

These seven customer workflows use `trx run copilot hve --interactive`, an explicit agent,
and declared skill checks. They require a terminal and your answers; they
cannot enter the batch queue. Guide rechecks readiness before a direct
terminal or Herdr launch. An old runtime, missing registration, disabled skill,
or unsafe file blocks launch with a diagnostic. Static checks do not
prove a successful HVE session or customer approval.

The initial verified customer routes are Native only. This feature does not
ingest meetings, read customer files during brief preparation, manage data
access or retention, publish reports, change a tracker, or authorize implementation.
These actions need separate decisions and controls. See the
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
| Supported Native Claude (`trx run claude default`) in this terminal | Native `/goal` through the harness's documented `-p` prompt mode |
| Supported Native Claude in prompt mode | Native `/goal` through the runtime's Claude `-p` path |
| Native Claude in interactive Herdr | Native `/goal` with explicit manual command input; the session stays interactive |

Workflow discipline such as Superpowers TDD does not replace a declared goal
controller. Every native-goal candidate has one explicit `/goal` frame.
The installed `goal-me` skill authors goals; it is not invoked again to
execute an approved goal. The guide does not invent a `$goal` skill.

All three candidates retain the exact approved task and criteria, with a
minimum score of 8 on every criterion. They differ only in approach. The
selected controller owns progress, continuation, and completion. The original
Goal-me document stays available for review, but its generic LOOP PROTOCOL,
SCOREBOARD, and progress-file rule do not become a second execution protocol.

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
configuration as a launch. Older runtimes without this probe or Claude goal
runtime metadata report unknown readiness; refresh those runtimes separately.

If evidence is missing or a policy blocks the goal, the guide reports the
reason and leaves it unlaunched. A supported transport form alone does not
prove readiness. Disabled Codex goals, missing Claude workspace trust, or
prohibited hooks must not be treated as successful goal activation.
Trellage does not change those policies or create project goal
files such as `.trellage/GOAL-xxxx.md`. Codex can store large goal input in its
own native state. Existing guide model artifacts are not goal progress files.

`trx guide --preview` renders the staged prompt basket composer overlay from
fixture data. The preview is fixture-only: it makes no model call, loads no
composition catalog, and launches nothing, so it opens with no Copilot
credentials.

The composer always shows the destination that will run the assembled prompt:
harness, profile, model, effort, working directory, target Herdr pane, and
session name. Each staged block is truncated to two
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
exact structured result used by Guide. Directories use mode `0700` and
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
Automatic Copilot matching selects afresh instead of reusing a cached model
choice; direct Jev matching and explicitly pinned Copilot routes retain caching.
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
`wt/copilot-hve-review-my-pr`. Generated names contain at most 40 ASCII
characters. Tags include the harness and profile. Tags longer than 22
characters retain a readable prefix and a six-hex identity hash.
Topics use at most 14 characters, shortened at a word boundary when possible.

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
  --profile native:claude/social-media --json
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
the target agent. Prompt Master cannot read its reference templates, and Guide
disables its interactive output, question, warning, and stop-and-ask rules.
Guide content and the execution objective are sent to TypeSafe for Jev matching and to the
configured Copilot model for fallback matching and subsequent LLM phases.

The native `prime` backend runs Prime Agent against `copilot-proxy-rs`, pinning
the provider and model to `copilot-proxy-rs` and `claude-opus-5` (Anthropic
Messages API at `http://127.0.0.1:8080`). Install and manage it from
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

The common bundles require the upstream `ui-guidelines` skill. Existing native
caches receive catalog updates only after `trx skills update`; existing
comparison images must be rebuilt.

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

Prerequisites are the installed commands `trx`, `codex`, and `jq`; provisioned Codex/Copilot profiles; and authenticated CLI sessions. The Agency, Claude, and JCode backends have their own contracts and router integration but are not yet part of the plugin-and-skill profile matrix. Composed Grok is verified by the Native runtime tests rather than this legacy profile matrix. Live verification also requires paid model access.

Run native non-inference verification in static mode:

```bash
scripts/verify-agent-profiles
make profile-matrix
```

Static mode performs native profile discovery plus non-inference health, inventory, and context validation. It never invokes a model.

All harnesses are required; failures are not skips.

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
- `1`: a required harness is missing, or discovery, static verification, or live verification fails.
- `2`: invalid usage.

## Native TUI Matrix

The Native TUI matrix discovers built-in presets from the schema-version 2
`harnesses[].presets` output of `trx list --json`. Preset names are not
hardcoded. A new preset under an existing harness is included automatically.
A new harness must select a versioned PTY adapter in
[`scripts/native-tui-adapters.json`](scripts/native-tui-adapters.json); discovery
fails closed when that adapter is missing.

Run the sequential, no-model lifecycle matrix:

```bash
scripts/verify-native-tuis
make native-tui-matrix
```

Filter a run without changing discovery:

```bash
scripts/verify-native-tuis --harness claude --profile default
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
scripts/verify-native-tuis --live --harness claude --profile default
make native-tui-matrix-live NATIVE_TUI_MATRIX_ARGS='--harness claude --profile default'
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

To test uninstalled harness changes from the current worktree, opt in to
source harness resolution:

```bash
TRELLAGE_TRX_SOURCE_ROOT="$PWD/prototypes/trellage-router" \
TRELLAGE_TRX_NATIVE_SOURCE=1 \
scripts/verify-native-tuis \
  --trx "$PWD/prototypes/trellage-router/bin/trx" \
  --harness claude --profile default
```

Exit statuses:

- `0`: every selected profile passes.
- `1`: discovery, adapter validation, readiness, PTY interaction, exit, or
  postflight readiness fails.
- `2`: invalid usage.

## Headless Contract Matrix

The headless publication gate compares Native composition capabilities with
[`docs/headless-evidence.json`](docs/headless-evidence.json). It also runs
deterministic prompt, machine-output, session, resume, malformed output,
failure, cleanup, question-control, usage/cost, and Git evidence contracts.

```bash
scripts/verify-headless-contracts
make headless-matrix
make headless-matrix-test
```

Static and deterministic checks do not invoke a model. Live verification runs
Native `trx` probes and is separate because it can consume paid quota:

```bash
scripts/verify-headless-contracts --live
make headless-matrix-live
```

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

`trx run pi` checks the latest Pi release and always-on extension versions on
every launch. Those checks run concurrently with floating-skill freshness
checks. The release installer receives the already-resolved tag, and npm runs
`install` only when an extension is missing or its installed version differs
from the registry's latest version. Native Pi loads `@narumitw/pi-plan-mode`
and `@narumitw/pi-goal` from the shared
`~/.local/share/trellage/pi-extensions` directory, outside the generated
composition. Set `TRELLAGE_PI_EXTENSIONS_HOME` to override that shared
directory. Each latest-version check has a two-second limit; failure warns and
keeps the installed Pi or extensions. Set
`TRELLAGE_PI_AUTO_UPDATE=0` to skip these checks; `TRELLAGE_PI_BIN` also skips
them.

`trx run` checks each floating default-branch skill source with `git ls-remote`.
Every profile load attempts this check; there is no freshness TTL. Each ref
check has a two-second limit so a slow remote falls back to validated last-good
content with a warning. Pinned sources reuse their validated resolved content
until explicitly upgraded.
