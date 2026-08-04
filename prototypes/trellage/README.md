# Trellage

## Prototype Question and Scope

Trellage runs coding harnesses inside locked, profile-compiled Docker sandboxes while preserving Herdr detection, conversations, and recovery shells. Declarative TOML profiles select the harness configuration and bundled capabilities.

## Prerequisites and Setup

Use an Apple Silicon host with Git, Docker, `jq`, and mise. Codex and Claude profiles require the existing `copilot-proxy-rs_default` network; Copilot and Pi profiles use Docker `bridge`. From `prototypes/trellage`:

```bash
mise trust
```

Install and compile the profile compiler once. Run `npm run build` after dependency installation:

```bash
cd ../../packages/trellage-cli
npm install
npm run build
```

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

Profiles and adjacent locks are committed. Resolved source content is integrity-checked under the Trellage cache beneath `$XDG_CACHE_HOME` and is safe to delete. Credentials remain host-side and are never copied into build inputs.

## Build

Build the locked Linux ARM64 OCI image, verify its manifest digest, and import it as `trellage-profile-codex-superpowers:locked`:

```bash
./trellage build --locked ../../profiles/codex-superpowers/profile.toml
```

## Deterministic Smoke Verification

The deterministic smoke verification requires Bash, Docker, Git, jq, and mise. Docker must provide the existing `copilot-proxy-rs_default` network and reachable proxy service. Run it from this directory:

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

The command remains linked to this prototype directory. Bundled profile
discovery therefore uses the `profiles/` directory in this Trellage source
tree; moving or deleting the source tree breaks the installed link.

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

The next `trellage --profile claude-hyperresearch` launch receives `PLAYWRIGHT_MCP_EXTENSION_TOKEN` before Trellage selects Claude MCPs, so Playwright and Obscura are both exposed. Existing process environment values take precedence, which preserves explicit credentials supplied by automation.

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
trellage -i|--interactive [-p|--prompt PROMPT]
trellage resume [SESSION_ID] [--profile PROFILE]
trellage shell|stop|doctor|destroy [--profile PROFILE]
trellage validate [PROFILE]
trellage lock [--update] [PROFILE]
trellage build [--locked] [PROFILE]

trellage                    # new interactive Codex conversation
trellage -i                 # select a profile, then start its interactive harness
trellage "<prompt>"         # new conversation with an explicit prompt
trellage -p "<prompt>"      # one non-interactive prompt with plain-text output
trellage resume             # resume the latest native conversation
trellage resume SESSION_ID  # resume one exact native conversation
trellage shell              # recovery Fish without secrets
trellage stop               # preserve state
trellage destroy            # confirmed profile/worktree cleanup
```

For a profile bundled in this repository, use its directory name instead of an absolute path:

```bash
trellage build --locked claude-hyperresearch
trellage --profile claude-hyperresearch
trellage build --locked claude-social-media
trellage --profile claude-social-media
```

A bare name resolves to `profiles/<name>/profile.toml`; explicit `.toml` and path arguments continue to resolve from the current directory.

`trellage -i` and `trellage --interactive` discover valid immediate child
profiles from both the bundled source-tree `profiles/` directory and the current
Git worktree's `profiles/` directory. Choices are sorted by declared profile
name. A current-worktree profile overrides a bundled profile with the same
declared name; duplicate canonical paths and invalid profiles are omitted. Each
row shows only the declared name and harness. The highlighted detail pane shows
the full description plus declared harness version/model, selected plugin names,
skill selections/count, and MCP names/count. These are declarations in the
selected `profile.toml`, not runtime inventory claims.

The picker requires interactive stdin and stdout. It cannot be combined with
`--profile`, resume, lifecycle, or compiler commands. Escape or Ctrl-C restores
the terminal and exits `130`. `trellage -i -p "prompt"` uses a TTY only for
selection, then runs the selected harness through the ordinary portable prompt
path. Selection never locks, builds, upgrades, or otherwise mutates a profile.

Bare profile launches remain interactive. Portable `-p` and `--prompt` run one prompt without a TTY and return the native harness status. Trellage translates this to `codex exec`, `claude -p`, or `copilot -p`:

```bash
trellage --profile codex-superpowers -p "hello"
trellage --profile claude-hyperresearch -p "hello"
trellage --profile claude-social-media -p "draft a LinkedIn post"
trellage --profile copilot-hve -p "hello"
trellage --profile pi-oh-my-pi -p "hello"
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

Claude Hyperresearch runs with `bypassPermissions` inside the same external Docker sandbox. Trellage supplies `skipDangerousModePermissionPrompt = true` as a session-level managed setting, so Claude starts without asking users or non-interactive callers to acknowledge the bypass-mode warning.

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
OMP process. If no host token exists, OMP login and session state persist in
the isolated profile/worktree state volume at `/home/agent/.omp/agent`. No host
`.omp`, `.copilot`, or GitHub CLI configuration directory is mounted or baked.

The profile uses Docker `bridge` and does not require `copilot-proxy-rs`.
`profile.toml` pins the same release for the OMP executable and native skills.
`profile.lock.toml` pins the source commit and inventory, architecture-specific
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

The container is non-root, read-only, capability-free, and resource-limited. The only host-backed mounts are the current worktree read-write and its owned `/home/agent` state volume. The container also receives a private `/tmp` tmpfs with `noexec`, `nosuid`, and `nodev`. Host-visible Docker exec uses the supported `HERDR_AGENT=codex` hint. `HERDR_AGENT=codex is host-only wrapper metadata`. The hint is not passed into the container. Herdr is not installed or mounted in the container. No bridge, socket, or plugin was added for Herdr.

Resource names include the profile, normalized worktree basename, and a canonical-path hash. Ownership labels and exact mounts are revalidated before stop, attach, or removal; collisions with unrelated Docker resources fail closed. Rebuilt images replace stale containers while retaining the profile/worktree state volume.

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
