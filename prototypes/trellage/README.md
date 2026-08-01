# Trellage

## Prototype Question and Scope

Trellage runs Codex inside a locked, profile-compiled Docker sandbox while preserving Herdr detection, conversations, and recovery shells. Declarative TOML profiles select the Codex configuration and bundled capabilities.

## Prerequisites and Setup

Use an Apple Silicon host with Git, Docker, `jq`, and mise. Docker must provide the locked base images and the existing `copilot-proxy-rs_default` network. From `prototypes/trellage`:

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

## Doctor

From any Git worktree, inspect dependencies, canonical paths, image, proxy network, exact container and state-volume names, and lifecycle state without requiring a TTY:

```bash
trellage doctor
```

## Use

Run these commands inside the Git worktree that should be mounted:

```bash
trellage [--profile PROFILE]
trellage [--profile PROFILE] -p|--prompt PROMPT
trellage resume|shell|stop|doctor|destroy [--profile PROFILE]
trellage validate [PROFILE]
trellage lock [--update] [PROFILE]
trellage build [--locked] [PROFILE]

trellage                    # new interactive Codex conversation
trellage "<prompt>"         # new conversation with an explicit prompt
trellage -p "<prompt>"      # one non-interactive prompt with plain-text output
trellage resume             # native resume
trellage shell              # recovery Fish without secrets
trellage stop               # preserve state
trellage destroy            # confirmed profile/worktree cleanup
```

For a profile bundled in this repository, use its directory name instead of an absolute path:

```bash
trellage build --locked claude-hyperresearch
trellage --profile claude-hyperresearch
```

A bare name resolves to `profiles/<name>/profile.toml`; explicit `.toml` and path arguments continue to resolve from the current directory.

Bare profile launches remain interactive. Portable `-p` and `--prompt` run one prompt without a TTY and return the native harness status. Trellage translates this to `codex exec`, `claude -p`, or `copilot -p`:

```bash
trellage --profile codex-superpowers -p "hello"
trellage --profile claude-hyperresearch -p "hello"
trellage --profile copilot-hve -p "hello"
```

Multiple Codex sessions can run concurrently for the same worktree. Each bare
`trellage` invocation starts a new native session.
`trellage resume` selects the newest recorded native session. All sessions
share one container and durable profile volume.
`trellage stop` stops the shared container and terminates every active session for that profile and worktree,
so reserve it for recovery after interactive sessions have exited.

New and resumed sessions run Codex with `--dangerously-bypass-approvals-and-sandbox`; Docker is the external sandbox. `trellage shell` does not start or label a Codex process.

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
