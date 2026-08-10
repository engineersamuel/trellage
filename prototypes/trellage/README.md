# Trellage

## Prototype Question and Scope

Trellage runs coding harnesses inside locked, profile-compiled Docker sandboxes while preserving Herdr detection, conversations, and recovery shells. Declarative TOML profiles select the harness configuration and bundled capabilities.

## Prerequisites and Setup

Use an Apple Silicon host with Git, Docker, `gh`, `jq`, and mise. Authenticate `gh` with a repository-scoped credential before launching a profile. Codex, Claude, and Prime profiles require the existing `copilot-proxy-rs_default` network; Copilot and Pi profiles use Docker `bridge`. From `prototypes/trellage`:

```bash
mise trust
```

The worktree launcher bootstraps the profile compiler automatically. It runs
`npm ci` when compiler dependencies are missing and runs `npm run build` when
compiler output is missing or stale.

## Profiles and Locks

Validate or resolve the bundled compatibility profile:

```bash
./trellage validate ../../profiles/codex-superpowers/profile.toml
./trellage lock ../../profiles/codex-superpowers/profile.toml
```

Only an explicit update refreshes unchanged Git refs:

```bash
./trellage lock --update ../../profiles/codex-superpowers/profile.toml
```

Profiles and adjacent platform locks are committed. Trellage binds the operation to one local Unix Docker endpoint and refuses endpoint or server changes before mutation. Native ARM64 is the only production platform today. AMD64 is recognized for future lock selection but rejected before downloads or Docker mutation until its artifact catalog and lock are complete. Resolved source content is integrity-checked under the Trellage cache beneath `$XDG_CACHE_HOME` and is safe to delete. Credentials never enter build inputs.

## Build

Build the lock for the local Docker server platform, verify its manifest digest, and import the platform-qualified image:

```bash
./trellage build --locked ../../profiles/codex-superpowers/profile.toml
```

The current production tag is `trellage-profile-codex-superpowers-linux-arm64:locked`.

### Rebuild everything (post-merge / heavy dev)

From the repository root:

```bash
mise run rebuild-profiles
```

That:

1. Installs the worktree `trellage` into `~/.local/bin`
2. Reinstalls every native launcher (`cdx`, `cpx`, `cldx`, `grx`, `jcx`, `omp`, `prx`) then `trx`
   from `prototypes/trellage-*-profiles` and `prototypes/trellage-router`
3. Runs non-locked `trellage build` for every `profiles/*/profile.toml` (pins
   kept; `final_digest` may update)

Equivalent: `./scripts/rebuild-profile-images.sh --install`

Useful variants:

```bash
./scripts/rebuild-profile-images.sh --native-only    # launchers + trx only
./scripts/rebuild-profile-images.sh --sandbox-only   # Docker images only
./scripts/rebuild-profile-images.sh --install --locked
```

## Deterministic Smoke Verification

The deterministic smoke verification requires Bash, Docker, Git, `gh`, jq, and mise. Docker must provide the existing `copilot-proxy-rs_default` network and reachable proxy service. Run it from this directory:

```bash
mise run smoke
```

The smoke performs a fresh locked image build, static and live contracts, a restricted container probe, proxy checks, persistence recreation, recovery Fish, and an installer dry-run. It usually takes 5-10 minutes, depending on Docker build speed. It creates uniquely named `trellage-codex-smoke-*`, `trellage-codex-runtime-test-*`, and `trellage-codex-persistence-test-*` temporary resources. Each test tracks immutable container IDs and successful volume creation, then revalidates ownership labels before removing only tracked resources. The smoke removes its temporary containers, volumes, bind directories, and installer directory on exit. It retains the built image, proxy, network, Herdr, repository worktrees, and unrelated resources.

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
trellage [--profile PROFILE]
trellage [--profile PROFILE] -p|--prompt PROMPT
trellage [--profile CLAUDE_PROFILE] [--model MODEL] [-p|--prompt PROMPT]
trellage resume [SESSION_ID] [--profile PROFILE] [--model MODEL]
trellage shell|stop|doctor|destroy [--profile PROFILE]
trellage validate [PROFILE]
trellage lock [--update] [PROFILE]
trellage build [--locked] [PROFILE]
trellage upgrade [PROFILE|all]

trellage                    # select a profile, then start its interactive harness
trellage --profile NAME     # directly launch one profile
trellage "<prompt>"         # new conversation with an explicit prompt
trellage -p "<prompt>"      # one non-interactive prompt with plain-text output
trellage resume             # resume the latest native conversation
trellage resume SESSION_ID  # resume one exact native conversation
trellage shell              # recovery Fish without secrets
trellage stop               # preserve state
trellage destroy            # confirmed profile/worktree cleanup
trellage upgrade all         # transactionally upgrade every discovered profile
```

`trellage upgrade all` uses the same bundled and current-worktree discovery as
the interactive picker. Profiles run sequentially in declared-name order.
Current-worktree profiles override bundled profiles with the same name. Each
upgrade refreshes mutable Git refs, marketplace plugin versions, and harnesses
declared with `version = "latest"`, then builds and atomically adopts the new
lock and image. Exact versions and immutable refs stay pinned. If VPN or
upstream access blocks one profile, its existing lock and image remain intact,
the remaining profiles still run, and the command exits nonzero with a failure
summary.

For a profile bundled in this repository, use its directory name instead of an absolute path:

```bash
trellage build --locked claude-research
trellage --profile claude-research
trellage build --locked claude-social-media
trellage --profile claude-social-media
```

A bare name resolves to `profiles/<name>/profile.toml`; explicit `.toml` and path arguments continue to resolve from the current directory.

Bare `trellage` discovers valid immediate child profiles from both the bundled
source-tree `profiles/` directory and the current Git worktree's `profiles/`
directory. Choices default to profile-name order; `S` cycles sort order and `/`
filters the list. A current-worktree profile overrides a bundled profile with the
same declared name. The detail pane shows the description, harness version/model,
plugins, skills, and MCPs declared by the selected `profile.toml`.

The Ink launcher requires an interactive terminal. Escape or Ctrl-C restores the
terminal and exits `130`. `M` selects an advertised model where the harness
supports overrides. Inside Herdr, `H` opens the selected launch in a new pane for
the current Git worktree. Selection itself never builds or mutates a profile.

Bare profile launches remain interactive. Portable `-p` and `--prompt` run one prompt without a TTY and return the native harness status. Trellage translates this to `codex exec`, `claude -p`, or `copilot -p`:

```bash
trellage --profile codex-superpowers -p "hello"
trellage --profile claude-research -p "hello"
trellage --profile claude-social-media -p "draft a LinkedIn post"
trellage --profile copilot-hve -p "hello"
trellage --profile pi-oh-my-pi -p "hello"
```

Claude profiles route Opus, Sonnet, and Haiku aliases to the models declared by
the profile. Their defaults are `claude-opus-5`, `claude-sonnet-5`, and
`claude-haiku-4.5`; `--model MODEL` overrides the Opus route. Codex, Copilot,
Pi, and Prime pass `--model MODEL` to their runtime. The local Qwen profile is
the sole pinned model.

```bash
trellage --profile claude-council --model gpt-5.5 -p "hello"
trellage --profile prime-agent --model claude-sonnet-5 -p "hello"
```

Multiple Codex sessions can run concurrently for the same worktree. Each bare
`trellage` invocation starts a new native session.
`trellage resume` selects the newest recorded native session. Pass a native
session ID to select an exact conversation; Trellage maps that ID to each
harness's native resume syntax. After an interactive session exits, Trellage
prints a copyable exact resume command. All sessions share one container and
durable profile volume.
`trellage stop` stops the shared container and terminates every active session for that profile and worktree,
so reserve it for recovery after interactive sessions have exited.

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
trellage build --locked /absolute/path/to/profiles/copilot-hve/profile.toml
trellage --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage resume --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage doctor --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage destroy --profile /absolute/path/to/profiles/copilot-hve/profile.toml
trellage upgrade /absolute/path/to/profiles/copilot-hve/profile.toml
```

For a launch or resume, host authentication precedence is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`, then device login. Host authentication is ephemeral: the resolved host token is supplied only to the Copilot process and is not saved in the profile state volume. If no host token is available, Copilot falls back to device login. Device login persists in the profile state volume so later launches and resumes stay authenticated.

Treat the profile state volume as sensitive local state. `destroy` deletes that sensitive local state only after confirmation. Stop and ordinary container replacement preserve it.

Locked builds never refresh mutable selectors. Upgrades never happen automatically. Run the explicit one-command `trellage upgrade /absolute/path/to/profiles/copilot-hve/profile.toml` flow when you intend to resolve, build, and adopt an upgrade.

## Prime Agent

The `prime-agent` profile installs the exact Prime Intellect stable release
recorded in `profile.linux-arm64.lock.toml`. The lock pins the official
versioned tarball URL, size, SHA-256 digest, runtime packages, base image, and
final OCI digest. Locked rebuilds reject any resulting image drift.

```bash
trellage validate /absolute/path/to/profiles/prime-agent/profile.toml
trellage build --locked /absolute/path/to/profiles/prime-agent/profile.toml
trellage --profile /absolute/path/to/profiles/prime-agent/profile.toml
trellage --profile /absolute/path/to/profiles/prime-agent/profile.toml -p "review this repository"
trellage resume --profile /absolute/path/to/profiles/prime-agent/profile.toml
trellage doctor --profile /absolute/path/to/profiles/prime-agent/profile.toml
trellage destroy --profile /absolute/path/to/profiles/prime-agent/profile.toml
```

Every launch fixes Prime's custom provider to `copilot-proxy-rs`, its API to
Anthropic Messages, and its endpoint to `http://copilot-proxy-rs:8080`. The
default model is `claude-opus-5`; `--model MODEL` materializes another model in
the managed provider file for that launch. The proxy and Docker network are
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
trellage build --locked /absolute/path/to/profiles/prime-agent/profile.toml
```

Hosts that use public registries leave those variables unset; Trellage does not
force CFS.

## Pi with Oh My Pi

The `pi-oh-my-pi` profile installs the standalone `omp` executable from
`can1357/oh-my-pi`. OMP is not GitHub Copilot CLI: this profile selects OMP's
native `github-copilot` provider and pins model `gpt-5.6-terra`. It also seeds
the three native skills published under the matching OMP release's
`.omp/skills`: `semantic-compression`, `system-prompts`, and
`tool-prompt-optimization`.

```bash
trellage validate /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage build --locked /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml -p "review this repository"
trellage resume --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage doctor --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
trellage destroy --profile /absolute/path/to/profiles/pi-oh-my-pi/profile.toml
```

Prompt mode translates to OMP `--print`; interactive launch uses a new native
OMP session; resume uses OMP `--continue` for the current worktree. All modes force
`github-copilot/gpt-5.6-terra` and preserve OMP's exit status.

Authentication precedence is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
`GITHUB_TOKEN`, then `gh auth token`, then OMP's native interactive login. A
resolved host token is forwarded only as `COPILOT_GITHUB_TOKEN` to the final
OMP process. The ephemeral `gh` configuration is separate from OMP state. If
no host token exists, OMP login and session state persist in the isolated
profile/worktree state volume at `/home/agent/.omp/agent`. No host `.omp`,
`.copilot`, or GitHub CLI configuration directory is mounted or baked.

The profile uses Docker `bridge` and does not require `copilot-proxy-rs`.
`profile.toml` pins the same release for the OMP executable and native skills.
The selected `profile.linux-<architecture>.lock.toml` pins the source commit and inventory, architecture-specific
raw asset URL, size, GitHub-provided SHA-256 digest, and final OCI digest.
Managed skills are refreshed into the persistent state volume on every launch.

## Ten-step Herdr Human Test

1. Create or open a disposable host Git worktree in Herdr.
2. Run `trellage` in its existing Herdr pane.
3. Confirm Codex opens at `/mounts/<worktree-name>`.
4. Invoke a bundled Superpowers skill and the pinned full-stack-orchestration plugin.
5. Edit a host-mounted file and confirm two-way host/container visibility.
6. Observe Herdr detect Codex and follow its status transitions.
7. Exit or kill Codex, then run `trellage stop` or allow the container to restart on the next launch.
8. Run `trellage resume` and verify the same conversation continues.
9. Run `trellage shell` and confirm recovery access.
10. Record the Herdr verdict and every interaction that felt wrong.

## Cleanup

Stop preserves container and conversation state:

```bash
trellage stop
```

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

The container is non-root, read-only, capability-free, and resource-limited. The host-backed mounts are the current worktree, its writable Git common directory, the read-only `~/.copilot/models.json` catalog at `/home/agent/.copilot-models.json`, and its owned `/home/agent` state volume. The container also receives a private `/tmp` tmpfs with `noexec`, `nosuid`, and `nodev`; GitHub CLI credentials exist only in that tmpfs. Host-visible Docker exec uses the supported `HERDR_AGENT=codex` hint. `HERDR_AGENT=codex is host-only wrapper metadata`. The hint is not passed into the container. Herdr is not installed or mounted in the container. No bridge, socket, or plugin was added for Herdr.

Resource names include the profile, normalized worktree basename, and a canonical-path hash. Ownership labels and exact mounts are revalidated before stop, attach, or removal; collisions with unrelated Docker resources fail closed. Legacy managed containers missing the Git common-directory or models-catalog mount are recreated while preserving the profile/worktree state volume. Rebuilt images replace stale containers while retaining the profile/worktree state volume.

## Observations

- Interactive sessions received `TERM=xterm-256color` and `COLORTERM=truecolor`.
- Codex YOLO/dangerous bypass was active inside the external Docker sandbox.
- Herdr followed `idle -> working -> done -> release` for the host-visible launch.
- Native resume continued the same conversation after exit and restart.
- The recovery Fish opened but printed `/tmp/fish` and `error: Runtime path not available. Try deleting the directory /tmp/fish.`

## Verdict

NATIVE_HERDR_DETECTION_WORKS

The supported host hint was sufficient for the tested manual Herdr flow. The recovery-shell warning remains a narrow defect, not evidence for a broader integration layer.

## Smallest Next Experiment

Isolate and correct only the recovery-shell Fish runtime-path warning, then repeat the recovery shell check. Do not generalize Prototype A into a registry or framework yet.
