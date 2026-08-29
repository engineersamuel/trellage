# Trellage

## Prototype Question and Scope

Trellage runs coding harnesses inside profile-compiled Docker sandboxes while
preserving Herdr detection, conversations, and recovery shells. Declarative
TOML development profiles select approved floating stable inputs and named
floating-skill bundles. Exact locks are explicit release artifacts.

## Prerequisites and Setup

Use an Apple Silicon host with Git, Docker, `gh`, `jq`, and mise. Authenticate `gh` with a repository-scoped credential before launching a profile. Codex, Claude, and Prime profiles require the existing `copilot-proxy-rs_default` network; Copilot and Pi profiles use Docker `bridge`. From `prototypes/trellage`:

```bash
mise trust
```

The worktree launcher bootstraps the profile compiler automatically. It runs
`npm ci` when compiler dependencies are missing and runs `npm run build` when
compiler output is missing or stale.

## Development Receipts and Release Locks

Validate or build the bundled compatibility profile:

```bash
./trellage validate ../../profiles/codex-superpowers/profile.toml
./trellage build ../../profiles/codex-superpowers/profile.toml
```

Normal development resolution is stored under the Trellage XDG cache, not
beside `profile.toml`. Only an explicit upgrade refreshes a complete local
result:

```bash
./trellage upgrade ../../profiles/codex-superpowers/profile.toml
```

Use `trellage lock PROFILE` only to create an exact adjacent release snapshot.
Prime profiles are development-only for now: `lock`, `build --locked`, and
`ci-verify` fail closed until Trellage can lock and install Prime's complete npm
and Python bootstrap closures offline.
Trellage binds resolution to one local Unix Docker endpoint and refuses
endpoint or server changes before mutation. Native ARM64 is the only supported
platform today. AMD64 is recognized for future selection but rejected before
downloads or Docker mutation until its artifact support is complete. Resolved
source content is integrity-checked under `$XDG_CACHE_HOME` and is safe to
delete. Approved skill repositories are declared without revisions in the root
`skills.json` and are not stored in release locks. Credentials never enter
build inputs.

```bash
./trellage lock ../../profiles/codex-superpowers/profile.toml
```

## Build

Resolve approved stable inputs, fetch current skill content, and import the
platform-qualified image:

```bash
./trellage build ../../profiles/codex-superpowers/profile.toml
```

The current production tag is
`trellage-profile-codex-superpowers-linux-arm64:locked`. Because this profile
has floating skills, normal development state does not claim one final image
digest.

### Rebuild everything (post-merge / heavy dev)

From the repository root:

```bash
mise run rebuild-profiles
```

That:

1. Installs the worktree `trellage` into `~/.local/bin`
2. Reinstalls every native launcher (`cdx`, `cpx`, `cldx`, `grx`, `jcx`, `omp`, `picx`, `prx`) then `trx`
   from `prototypes/trellage-*-profiles` and `prototypes/trellage-router`
3. Runs `trellage build` for every `profiles/*/profile.toml` and resolves
   current approved development inputs

Equivalent: `./scripts/rebuild-profile-images.sh --install`

Useful variants:

```bash
./scripts/rebuild-profile-images.sh --native-only    # launchers + trx only
./scripts/rebuild-profile-images.sh --sandbox-only   # Docker images only
./scripts/rebuild-profile-images.sh --install --locked
```

## Smoke Verification

The smoke verification requires Bash, Docker, Git, `gh`, jq, and mise. Docker
must provide the existing `copilot-proxy-rs_default` network and reachable
proxy service. Run it from this directory:

```bash
mise run smoke
```

The smoke performs a fresh resolved image build with one staged skill snapshot,
static and live contracts, a restricted container probe, proxy checks,
persistence recreation, recovery Fish, and an installer dry-run. It creates
uniquely named temporary resources, revalidates ownership before cleanup, and
retains the built image and unrelated resources.

## Install

Install the user-local `trellage` symlink (normally `~/.local/bin/trellage`):

```bash
./install-trellage.sh install
mise run install-trellage
```

Set `TRELLAGE_INSTALL_DIR` to override the destination directory. The installer refuses to overwrite another command or symlink and never creates a `harness` compatibility link.

The command remains linked to this prototype directory. Outside the Trellage
repository, bundled profile discovery therefore uses the `profiles/` directory
in that installed source tree; moving or deleting the source tree breaks the
installed link.

Inside a linked Trellage worktree, invoking the installed symlink compares the
current and installed Git common directories. When they match, it executes the
regular executable at `prototypes/trellage/trellage` in the current worktree and
prints `trellage: using current worktree command: ...` to stderr. A lookalike
command in an unrelated repository is never executed. Invoking `./trellage`
directly remains an explicit request for that exact checkout.

The repository root contains a mise configuration that prepends this directory
to `PATH`. After one `mise trust` in the main checkout, mise shares trust with
linked worktrees; an activated shell can run `trellage` directly from the
repository root. Bare profile names select the current worktree profile first,
then fall back to the installed source tree.

```bash
mise trust
mise run trellage -- validate prime-agent
trellage validate prime-agent
```

Use root-level `mise run trellage --` followed by any normal Trellage arguments
when the shell environment has not refreshed. The child task in this directory
remains available for component-local development.

## Doctor

From any Git worktree, inspect dependencies, canonical paths, image, proxy network, exact container and state-volume names, and lifecycle state without requiring a TTY:

```bash
trellage doctor
```

Doctor also reports whether automatic Varlock environment loading is disabled, ready, or has no configured source.

## Automatic Environment Loading

Trellage automatically runs new, prompt, and resume launches through its bundled Varlock version when a user environment source exists. Callers still invoke `trellage` directly; shells, scripts, editors, and other applications do not prefix the command with `varlock`.

The default source is `$XDG_CONFIG_HOME/trellage`, or `~/.config/trellage` when `XDG_CONFIG_HOME` is unset. No config file is required. If that directory has no `.env` files, loading is a silent no-op. A typical setup is:

```bash
install -d -m 700 ~/.config/trellage
printf '%s\n' \
  '# @sensitive' \
  'PLAYWRIGHT_MCP_EXTENSION_TOKEN=' \
  >~/.config/trellage/.env.schema
printf '%s\n' \
  'PLAYWRIGHT_MCP_EXTENSION_TOKEN=replace-with-token' \
  >~/.config/trellage/.env.local
chmod 600 ~/.config/trellage/.env.local
```

The next `trellage --profile claude-research` launch receives `PLAYWRIGHT_MCP_EXTENSION_TOKEN` before Trellage selects Claude MCPs, so Playwright and Obscura are both exposed. Existing process environment values take precedence, which preserves explicit credentials supplied by automation.

Keep secret values out of `config.toml`. Use it only to control loading:

```toml
[environment]
provider = "varlock"
enabled = true
path = "~/.config/trellage"
required = false
strict_permissions = true
```

`strict_permissions = true` is the default. Trellage rejects symlinked environment sources, non-regular `.env` entries, group/world-accessible environment directories, group/world-accessible secret-bearing files, and any config or environment file writable by group or other users. `.env.schema`, `.env.example`, `.env.sample`, and `.env.template` may remain publicly readable because they must not contain values. Set `required = true` when an application must fail closed if the source is absent.

For stronger local-at-rest protection, use Varlock device-local encryption in `.env.local`, or a noninteractive secret-provider plugin. Do not use `varlock(prompt)` in unattended launches: provision the encrypted payload or provider credentials before the application invokes Trellage.

Set `TRELLAGE_CONFIG` to an alternate config file. Set `TRELLAGE_ENVIRONMENT=off` for an explicit per-process bypass, or `TRELLAGE_ENVIRONMENT=on` to override `enabled = false`. Automatic loading applies only to new, prompt, and resume launches; lifecycle and compiler commands do not load secrets.

## Use

Run these commands inside the Git worktree that should be mounted:

```bash
trellage [--profile PROFILE] [-l|--local|-r|--remote]
trellage [--profile PROFILE] -p|--prompt PROMPT
trellage [--profile CLAUDE_PROFILE] [--model MODEL] [-p|--prompt PROMPT]
trellage [--profile PROFILE] --output-format jsonl [--trellage-events] -p PROMPT
trellage resume [SESSION_ID] [--profile PROFILE] [--model MODEL]
trellage shell|start|stop|doctor|destroy [--profile PROFILE]
trellage validate [PROFILE]
trellage lock [--update] [PROFILE]
trellage build [--locked] [PROFILE]
trellage upgrade [PROFILE|all]

trellage                    # select a profile, then start its interactive harness
trellage --profile NAME     # directly launch one profile
trellage "<prompt>"         # new conversation with an explicit prompt
trellage -p "<prompt>"      # one non-interactive prompt when advertised
trellage --remote --profile NAME  # provision/reuse an Azure VM and launch there
trellage resume             # resume the latest conversation when advertised
trellage resume SESSION_ID  # resume an exact session when advertised
trellage shell              # recovery Fish without secrets
trellage stop               # preserve state
trellage start              # restart a persistent profile without attaching
trellage destroy            # confirmed profile/worktree cleanup
trellage upgrade all         # transactionally upgrade every discovered profile
```

`trellage upgrade all` uses the same bundled and current-worktree discovery as
the interactive picker. Profiles run sequentially in declared-name order.
Current-worktree profiles override bundled profiles with the same name. Each
upgrade refreshes approved Git branches, marketplace plugin versions, and
harnesses declared with `version = "latest"`, then builds and atomically adopts
the new local receipt and image. If VPN or upstream access blocks one profile,
its existing receipt and image remain intact, the remaining profiles still
run, and the command exits nonzero with a failure summary. Every image build
resolves selected skill bundles from current default-branch content.

### Remote Execution (Azure)

`trellage` always launches locally unless `-r`/`--remote` is given; `-l`/`--local`
is the explicit (and default) opposite, useful for scripting clarity. `--remote`
is supported only for agent launches (`new`, `prompt`, `resume`) and requires an
explicit `--profile`:

```bash
trellage --profile copilot-hve --remote -p "hello"   # or: --remote -p "hello"
trellage -r --profile copilot-hve                    # interactive, on Azure
```

`--remote` requires the Azure CLI (`az`) installed and an authenticated session
(`az login`); it fails fast with a clear message otherwise, and never falls
back to local automatically. When available, it builds the resolved profile image locally (builds are
ARM64-only), then provisions (or reuses)
a single shared ARM64 Azure VM (`Standard_D2ps_v5`, `westus2`), mirrors the
current worktree, Git common directory, and `~/.copilot/models.json` onto the
VM at identical paths, transfers the built image, and re-execs the unmodified
`trellage` launcher on the VM's own Docker daemon over an interactive SSH PTY
(`--local` is forced on the remote side to avoid recursive delegation). This
is a prototype convenience path with no cost controls beyond VM reuse; destroy
the `trellage-remote-rg` resource group (`az group delete --name
trellage-remote-rg --yes`) when a remote session is no longer needed.

For a profile bundled in this repository, use its directory name instead of an absolute path:

```bash
trellage build claude-research
trellage --profile claude-research
trellage build claude-social-media
trellage --profile claude-social-media
```

A bare name resolves to `profiles/<name>/profile.toml`; explicit `.toml` and path arguments continue to resolve from the current directory.

Bare `trellage` discovers valid immediate child profiles from both the bundled
source-tree `profiles/` directory and the current Git worktree's `profiles/`
directory. The first sorted row is selected when the launcher opens. Typing
immediately filters by profile, harness, or description, and the arrow keys move
within the filtered results. Enter launches the selected profile directly from
filter mode; Escape leaves filter mode, `/` re-enters it, and `S` cycles sort
order. A current-worktree profile overrides a bundled profile with the same
declared name. The detail pane shows the description,
harness version/model, plugins, skills, and MCPs declared by the selected
`profile.toml`.

The Ink launcher requires an interactive terminal. Ctrl-C cancels from any mode;
Escape cancels after filter mode is left. Cancellation restores the terminal and
exits `130`. `M` selects an advertised model where the harness supports
overrides. Inside Herdr, `H` opens the selected launch in a new pane for the
current Git worktree. Selection itself never builds or mutates a profile.

Bare profile launches remain interactive. Headless prompt, JSONL, resume,
exact-session resume, resume-with-prompt, and model override operations require
matching capability values from `trellage list --json --full`. The values are
valid only for their exact `testedHarnessVersion`. Unsupported requests fail
before Docker or authentication mutation.

```bash
trellage list --json --full
trellage --profile VERIFIED_PROFILE -p "hello"
trellage --profile VERIFIED_PROFILE --output-format jsonl -p "hello"
trellage resume SESSION_ID --profile VERIFIED_PROFILE -p "continue"
```

`--trellage-events` is opt-in and requires JSONL plus a published
`trellage-headless-v1` contract. Native JSONL lines remain unchanged. See
[`../../docs/headless-contract.md`](../../docs/headless-contract.md).

Claude profiles route Opus, Sonnet, and Haiku aliases to the models declared by
the profile. Their defaults are `claude-opus-5`, `claude-sonnet-5`, and
`claude-haiku-4.5`. When `modelOverride` is true, Claude overrides the Opus
route and other supported adapters pass the model to their runtime. The local
Qwen profile is the sole pinned model.

Multiple Codex sessions can run concurrently for the same worktree. Each bare
`trellage` invocation starts a new native session. When the selected profile
publishes resume support, `trellage resume` selects the newest recorded native session.
A profile with `sessionId` other than `none` can also accept an exact session ID.
After a supported interactive session exits, Trellage prints a copyable exact resume command.
All sessions share one container and durable profile volume.
Trellage automatically stops an ephemeral shared container after the last harness exits.
Headlong is persistent: its service remains running after the attachment exits.
Concurrent harnesses and recovery shells keep ephemeral containers running.
The container and state volume remain retained, so the next launch restarts the
same container with durable agent state.
A `trellage shell` exit alone does not request shutdown.

`trellage stop` remains the force/recovery operation: it stops the shared
container and terminates every active attachment for that profile and worktree.
`trellage start` is available only for persistent profiles and starts their
service without opening an attachment.

New and resumed sessions run Codex with `--dangerously-bypass-approvals-and-sandbox`; Docker is the external sandbox. `trellage shell` does not start or label a Codex process.

Claude Research runs with `bypassPermissions` inside the same external Docker sandbox. Trellage supplies `skipDangerousModePermissionPrompt = true` as a session-level managed setting, so Claude starts without asking users or non-interactive callers to acknowledge the bypass-mode warning.

Claude Social Media installs every bundled skill from
[`charlie947/social-media-skills`](https://github.com/charlie947/social-media-skills)
as `social-media-skills@social-media-skills` through Claude Code's native marketplace.
Core skills need no credentials. `APIFY_API_TOKEN` optionally enables Apify-backed
workflows, and `GOOGLE_AI_API_KEY` optionally enables API-backed Google AI workflows.
Set values securely outside the repository, export the variable names, and launch:

```bash
export APIFY_API_TOKEN
export GOOGLE_AI_API_KEY
trellage --profile claude-social-media
```

Trellage forwards only present variables to the final Claude process and never records
their values in the profile, lock, image, or persistent Claude seed.

The managed Claude seed completes first-run onboarding with the dark theme. Runtime
synchronization fills only missing onboarding fields, preserving later user choices
and unrelated Claude state. The current mounted worktree is pre-approved as trusted
inside the isolated container.

## GitHub CLI Delivery

Every profile image includes `gh`. Launching or opening a recovery shell requires host GitHub authentication from `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN`, or `gh auth token`.

Trellage mounts the current worktree, its writable Git common directory, and the host `~/.copilot/models.json` read-only at `/home/agent/.copilot-models.json`. The separate destination avoids colliding with mutable Copilot runtime state while preserving linked-worktree metadata and giving every profile the shared model catalog.

For each active session, Trellage configures `gh` in the container `/tmp` tmpfs and passes only `GH_CONFIG_DIR` and `GIT_CONFIG_GLOBAL` to the agent. `GH_TOKEN` is never passed to the agent process, written to the state volume, baked into images, or logged. The temporary configuration disappears when the container stops.

## Copilot with HVE Core

Bare `trellage` remains the Codex profile. The Copilot profile runs GitHub Copilot CLI. HVE installs natively as `hve-core@hve-core`. This profile selects HVE Core, not HVE Core All: HVE Core and HVE Core All are different products, and HVE Core All is not installed.

Use absolute profile paths when invoking the installed command from any worktree:

```bash
trellage validate /absolute/path/to/profiles/copilot-hve/profile.toml
trellage build /absolute/path/to/profiles/copilot-hve/profile.toml
trellage --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage resume --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage doctor --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage destroy --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage upgrade /absolute/path/to/profiles/copilot-hve/profile.toml
```

For a launch, and for a resume when the inventory publishes resume support, host authentication precedence is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`, then device login. Host authentication is ephemeral: the resolved host token is supplied only to the Copilot process and is not saved in the profile state volume. If no host token is available, Copilot falls back to device login. Device login persists in the profile state volume.

Treat the profile state volume as sensitive local state. `destroy` deletes that sensitive local state only after confirmation. Stop and ordinary container replacement preserve it.

Ordinary launches reuse the installed local receipt and image. Run the explicit
one-command `trellage upgrade /absolute/path/to/profiles/copilot-hve/profile.toml`
flow when you intend to resolve, build, and adopt current stable inputs.

## Prime Agent

The `prime-agent` profile resolves the latest Prime Intellect stable release.
Its local receipt records the official versioned tarball URL, size, SHA-256
digest, runtime packages, and base image. Its common skills float, so normal
development state does not record or enforce a final OCI digest.
This receipt is valid development state, not a production release snapshot.
Prime release commands fail closed because the current Prime bootstrap still
resolves transitive npm and Python packages online.

```bash
trellage validate /absolute/path/to/profiles/prime-agent/profile.toml
trellage build /absolute/path/to/profiles/prime-agent/profile.toml
trellage --profile /absolute/path/to/profiles/prime-agent/profile.toml
trellage doctor --profile /absolute/path/to/profiles/prime-agent/profile.toml
trellage destroy --profile /absolute/path/to/profiles/prime-agent/profile.toml
```

Every launch fixes Prime's custom provider to `copilot-proxy-rs`, its API to
Anthropic Messages, and its endpoint to `http://copilot-proxy-rs:8080`. The
default model is `claude-opus-5`. When the full inventory publishes
`modelOverride: true`, `--model MODEL` materializes another model in the
managed provider file for that launch. The proxy and Docker network are
host-managed prerequisites. No host Anthropic, OpenAI, Copilot, or GitHub token
is forwarded to Prime; the separately prepared `GH_CONFIG_DIR` remains
available for `gh`. Prime sessions and other user state persist under
`/home/agent/.prime/agent`, while the managed provider file is restored
atomically before each launch.
The image build prepares Prime's Python kernel as
`/usr/local/share/trellage/prime-kernel-seed.tar.gz`; launches restore it into
the profile state volume instead of downloading Python packages when the first
tool is invoked. Kernel bootstrap needs a reachable PyPI simple index for `uv`
(seed packages, ipykernel, and default runtime packages).

On Microsoft-managed devices, public `pypi.org` / `files.pythonhosted.org` are
blocked. Trellage treats package feeds as **host policy** (not baked into
images):

1. **Builds** — discover `UV_DEFAULT_INDEX` / `PIP_INDEX_URL` from env, host
   `pip` `global.index-url`, or CFS when npm is already
   `packagefeedproxy.microsoft.io`, then inject into the builder.
2. **Runtime** — forward the same host HTTPS feed env into every harness
   session (`docker exec`) so in-container `pip` / `uv` / `npm` installs work.

The approved CFS PyPI URL is
`https://packagefeedproxy.microsoft.io/pypi/simple/`. Explicit override:

```bash
export UV_DEFAULT_INDEX=https://packagefeedproxy.microsoft.io/pypi/simple/
trellage build /absolute/path/to/profiles/prime-agent/profile.toml
```

Hosts that use public registries leave those variables unset; Trellage does not
force CFS.

## Headlong

The `headlong` profile installs the official
[`laude-institute/headlong`](https://github.com/laude-institute/headlong)
checkout. Its local receipt records the exact resolved upstream commit,
complete source inventory, runtime artifacts, managed skills, base image, and
final OCI digest. Ordinary launches reuse it; explicit upgrade resolves the
stable channel again.

```bash
trellage validate /absolute/path/to/profiles/headlong/profile.toml
trellage build /absolute/path/to/profiles/headlong/profile.toml
trellage --profile /absolute/path/to/profiles/headlong/profile.toml
trellage doctor --profile /absolute/path/to/profiles/headlong/profile.toml
trellage stop --profile /absolute/path/to/profiles/headlong/profile.toml
trellage start --profile /absolute/path/to/profiles/headlong/profile.toml
trellage destroy --profile /absolute/path/to/profiles/headlong/profile.toml
```

The first launch runs the upstream checkout installer and `headlong-init`
identity interview. Headlong uses `copilot-proxy-rs` on Docker network
`copilot-proxy-rs_default`, route `/v1/messages`, and model
`claude-sonnet-5`. Start and authenticate the proxy before launch. Trellage
supplies a fixed non-secret compatibility token because Headlong's Anthropic
client requires that variable, and it ignores all host provider API keys. The
runtime supplies proxy settings only to initializer and service processes; it
removes them before opening the attached shell.

The image compiles the resolved Rust `headlong-tui` with the resolved Rust
toolchain, then keeps only the resulting executable in the runtime image. The
runtime installs both `ada` and `headlong-tui` under
`/home/agent/.local/bin`; login shells include that directory on `PATH`.
Headlong starts `persona dash` by default and the persistent service restarts
the dashboard if it exits.

The proxy settings are absent from the local receipt, container configuration,
labels, and command arguments. GitHub CLI authentication remains separate and
exists only in the container `/tmp` tmpfs. The dashboard is available only on
<http://127.0.0.1:18080>. A process already using that host port blocks
container creation with a direct diagnostic.

Headlong differs from ephemeral harness profiles:

- The container command is `runtime-headlong-entry service`.
- Docker restart policy is `unless-stopped`.
- Exiting the attached shell leaves the dashboard and thinkers running.
- `trellage stop` explicitly pauses the container.
- `trellage start` restarts it without attaching.
- `trellage destroy` removes the container and state volume only after the
  normal exact-name confirmation.

The writable application lives at `/home/agent/.headlong/app`. Identity state
lives in its real `.identities` directory so the dashboard can discover it;
Trellage ownership metadata lives beside the application in the same volume.
A new resolved image replaces a clean managed application transactionally and
preserves identities. If tracked or
untracked application source changed, the runtime refuses the replacement and
prints the old and new upstream commits. Inspect and back up the checkout
before retrying:

```bash
trellage shell --profile /absolute/path/to/profiles/headlong/profile.toml
git -C /home/agent/.headlong/app status --short
```

The managed checkout has no upstream Git remote, so the dashboard cannot
bypass Trellage resolution with a pull. Profile-managed skills are synchronized
without overwriting user-owned collisions; `always_on` skills are linked into
the active identity kernel. Headlong uses the outer Trellage container as its
sandbox. No Docker socket is mounted and no nested Docker daemon is started.
Prompt, resume, model override, and structured output remain unsupported.

## Pi with Oh My Pi

The `pi-oh-my-pi` profile resolves the latest stable standalone `omp` executable
from `can1357/oh-my-pi`. OMP is not GitHub Copilot CLI: this profile selects
OMP's native `github-copilot` provider and fixes model `gpt-5.6-terra`. At build
time,
it fetches the current default-branch versions of three native skills:
`semantic-compression`, `system-prompts`, and
`tool-prompt-optimization`.

```bash
trellage validate /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage build /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml -p "review this repository"
trellage resume --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage doctor --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage destroy --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
```

Prompt mode translates to OMP `--print` when the exact resolved version publishes prompt support. Interactive launch uses a new native OMP session. When resume support is published, resume uses OMP `--continue` for the current worktree. All modes force `github-copilot/gpt-5.6-terra` and preserve OMP's exit status.

Authentication precedence is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
`GITHUB_TOKEN`, then `gh auth token`, then OMP's native interactive login. A
resolved host token is forwarded only as `COPILOT_GITHUB_TOKEN` to the final
OMP process. The ephemeral `gh` configuration is separate from OMP state. If
no host token exists, OMP login and session state persist in the isolated
profile/worktree state volume at `/home/agent/.omp/agent`. No host `.omp`,
`.copilot`, or GitHub CLI configuration directory is mounted or baked.

The profile uses Docker `bridge` and does not require `copilot-proxy-rs`.
The local receipt records the resolved architecture-specific raw asset URL,
size, and GitHub-provided SHA-256 digest. Native skill content is not part of
the receipt. Managed skills are refreshed from the image snapshot into the
persistent state volume on every launch.

## Ten-step Herdr Human Test

1. Create or open a disposable host Git worktree in Herdr.
2. Run `trellage` in its existing Herdr pane.
3. Confirm Codex opens at `/mounts/<worktree-name>`.
4. Invoke a bundled Superpowers skill and the current approved
   full-stack-orchestration plugin.
5. Edit a host-mounted file and confirm two-way host/container visibility.
6. Observe Herdr detect Codex and follow its status transitions.
7. Exit or kill Codex, confirm the container stops automatically, then relaunch it.
8. If the full inventory publishes resume support, run `trellage resume` and
   verify the same conversation continues.
9. Run `trellage shell` and confirm recovery access.
10. Record the Herdr verdict and every interaction that felt wrong.

## Cleanup

Automatic shutdown preserves an ephemeral container and state volume after the
last harness exits. Persistent Headlong containers keep running.
Explicit stop preserves the same resources:

```bash
trellage stop
```

`trellage stop` may terminate active attachments, so use it as a force/recovery
operation rather than normal session cleanup.

`trellage doctor` names the exact profile/worktree container and state volume. `trellage destroy` prints both names; type `destroy <container> <state-volume>` to confirm. A wrong or empty response cancels. Thus destroy removes only the named container and state volume after confirmation.

Preview and then remove the installed command:

```bash
./install-trellage.sh uninstall --dry-run
mise run uninstall-trellage-dry-run
./install-trellage.sh uninstall
mise run uninstall-trellage
```

Dry-run changes nothing. Real uninstall removes only the exact owned `trellage` symlink. Cleanup retains the image, network, proxy, Herdr, and unrelated resources; none of them are removed.

## Safety Boundary

The container is non-root, read-only, capability-free, and resource-limited. Docker starts a minimal init process to reap orphaned children while preserving the 256-task PID limit. The only host-backed mounts are the current worktree, its writable Git common directory, the read-only `~/.copilot/models.json` catalog at `/home/agent/.copilot-models.json`, and its owned `/home/agent` state volume. The container also receives a private `/tmp` tmpfs with `noexec`, `nosuid`, and `nodev`; GitHub CLI credentials exist only in that tmpfs. Host-visible Docker exec uses the supported `HERDR_AGENT=codex` hint. `HERDR_AGENT=codex is host-only wrapper metadata`. The hint is not passed into the container. Herdr is not installed or mounted in the container. No bridge, socket, or plugin was added for Herdr.

Resource names include the profile, normalized worktree basename, and a canonical-path hash. Ownership labels and exact mounts are revalidated before stop, attach, or removal; collisions with unrelated Docker resources fail closed. Legacy managed containers missing the Git common-directory mount, models-catalog mount, private Fish runtime directory, or init process are recreated while preserving the profile/worktree state volume. Rebuilt images replace stale containers while retaining the profile/worktree state volume.

The graph-of-loops profile disables Beads metrics and event flushing because
Beads 1.2.2 can leave detached telemetry processes behind
([gastownhall/beads#5900](https://github.com/gastownhall/beads/issues/5900)).
Trellage does not increase the PID limit or delete retained Beads telemetry
queues.

## Observations

- Interactive sessions received `TERM=xterm-256color` and `COLORTERM=truecolor`.
- Codex YOLO/dangerous bypass was active inside the external Docker sandbox.
- Herdr followed `idle -> working -> done -> release` for the host-visible launch.
- Native resume continued the same conversation after exit and restart.
- The recovery Fish opened without runtime-path warnings by using its private `/run/user/10001` tmpfs.

## Verdict

NATIVE_HERDR_DETECTION_WORKS

The supported host hint was sufficient for the tested manual Herdr flow.

## Smallest Next Experiment

Repeat the recovery shell check after Fish or Docker changes. Do not generalize Prototype A into a registry or framework yet.
