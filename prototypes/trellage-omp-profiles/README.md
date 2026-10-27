# Native Oh My Pi profiles

Public commands use the [`trx` router](../trellage-router/README.md). The
private backend keeps the profile wrapper and skills isolated, while every OMP
launch uses the host-installed `omp` executable.

`trx run omp PROFILE` runs host-native Oh My Pi with two profiles:

- `local` routes every model role to
  `copilot-proxy-rs/qwen3.6-35b-a3b-local`.
- `default` uses OMP's native GitHub Copilot provider and discovered models.

Choose a profile explicitly with `trx run omp local ...` or
`trx run omp default ...`. The backend calls the second profile `copilot`.

## Requirements

Install OMP on the host before installing this backend. Trellage does not install or pin a private OMP copy. A valid manually maintained host executable is enough for setup, launch, repair, doctor, and inventory. Bun, Homebrew, and mise are the supported owners for automatic update and latest-version checks:

```bash
# Choose one host installation method.
bun install -g @oh-my-pi/pi-coding-agent
brew install can1357/tap/omp
mise use -g github:can1357/oh-my-pi
```

Trellage checks the resolved host executable and its `omp/X.Y.Z` version on
every setup, launch, doctor, inventory, and update command. It never silently
installs a replacement. `jq` and `curl` are required. The `local` profile also
requires `copilot-proxy-rs` at `http://127.0.0.1:8080`; the `default` profile
requires native GitHub Copilot authentication and the
`github-copilot/gpt-5.6-sol` model catalog.

## Install and lifecycle

```bash
(cd prototypes/trellage-omp-profiles && ./install.sh)
trx setup omp local
trx setup omp default
trx doctor omp local
trx doctor omp default
trx upgrade omp default --check
trx upgrade omp default
trx repair omp local
omp reap PROFILE
```

`setup` prepares the named profile, managed overlays, provider state where
needed, and selected skills. `repair` reconciles that managed state without
installing or downgrading OMP. `doctor` is read-only. A first launch can set up
an absent profile, but launch, setup, repair, and doctor all resolve and verify
the host executable before they continue.

Source-mode commands, including `mise run trx run omp`, use the worktree's
backend, catalog, and skill helpers. They still require the installed, owned
`~/.local/share/trellage/omp` runtime for overlays, initialization locks, and
temporary files. Install the backend once with the command above before using
source mode. No runtime files or ownership marker are written into the worktree.

If an interrupted first launch leaves an initialization claim behind, an
operator may run the installed backend command
`~/.local/share/trellage/omp/bin/omp reap PROFILE` (with `PROFILE` set to
`local` or `copilot`). The
command only removes a validated stale initialization claim at the exact
runtime/profile path: it requires a regular non-symlink `0600` file,
a parseable claimant PID and birth identity, and a claimant that is no longer
that same process, or whose recorded PID is absent. Live or indeterminate
inspection, malformed, redirected, wrong-mode, or replacement-raced claims
fail closed. Automatic initialization keeps the same fail-closed behavior and
never invokes this recovery implicitly.

Automatic updates and latest-version checks belong to the package manager that
owns the resolved executable. The supported ownership and upgrade commands are:

```text
Bun:      bun update -g --latest @oh-my-pi/pi-coding-agent '@oh-my-pi/pi-natives*'
Homebrew: brew upgrade can1357/tap/omp
mise:     mise upgrade github:can1357/oh-my-pi
```

`trx upgrade omp [default|local] --check` performs the owner's read-only
latest-version query. `trx upgrade omp [default|local]` runs that owner's
upgrade, resolves OMP again, and reports the observed before and after
versions. Unknown ownership fails update and check; update the binary manually with the mechanism that installed it. This does not block setup, launch, repair, doctor, or inventory. A failed owner command does not cause Trellage to install a private fallback or roll back user state.

## Managed state and preservation

Trellage stores its wrapper, catalog, overlays, and selected skills beneath
`~/.local/share/trellage/omp`. Native OMP profile state remains under:

```text
~/.omp/profiles/trellage-qwen-local/agent/
~/.omp/profiles/trellage-copilot-native/agent/
```

The profile `config.yml`, Copilot `models.yml`, authentication, sessions, caches, history, and other profile state remain byte-for-byte unchanged. The local profile's `models.yml` is the one Trellage-managed exception because OMP
has no provider-file overlay mechanism. Trellage adopts or updates that file
only when it is absent or already marked as Trellage-owned. An unrelated local
provider file blocks setup and repair instead of being overwritten.

Uninstall removes only the owned wrapper runtime and command link. It preserves
both `~/.omp` profiles, including the local provider file, Copilot state,
authentication, sessions, caches, and history:

```bash
(cd prototypes/trellage-omp-profiles && ./uninstall.sh)
```

## Overlay policy and precedence

Trellage writes one profile-specific overlay outside `~/.omp`. The common
policy contains these seven settings:

```yaml
startup:
  checkUpdate: false
  setupWizard: false
marketplace:
  autoUpdate: off
tools:
  approvalMode: yolo
bash:
  gitGuard: true
secrets:
  enabled: true
providers:
  cacheWarming: streaming
```

The local overlay adds its model roles and enabled model. The default overlay
adds the Copilot model roles and reasoning levels. An existing `PI_CONFIG_FILES` list is preserved, and Trellage appends its overlay last. The same composition
is used for delegated model discovery and doctor checks. Explicit OMP `--config` arguments load later and override the Trellage overlay. The headless policy overlay is also an explicit later layer and is
removed when the launch exits.

Trellage no longer adds `--approval-mode yolo` to every command because the
overlay supplies that policy. OMP remains free to update its own native
`config.yml` through its settings commands.

## Skills and profile routing

The approved OMP community bundle contains 33 skills from:

- [`dsebban/skills`](https://github.com/dsebban/skills): `orchestrate-omp`,
  `poteto-mode`, and `pstack-omp`.
- [`ericlitman/open-pstack`](https://github.com/ericlitman/open-pstack):
  30 harness-neutral workflow, principle, automation, and support skills.

The source policy is in `config.example.toml`, and user overrides are in
`~/.config/trellage/config.toml`. OMP 17.3.5 or newer discovers the
community directory. Older host versions remain usable without that directory.
`trx skills update` refreshes approved caches; then
`trx upgrade omp default --skills-only` or
`trx upgrade omp local --skills-only` synchronizes an existing profile. Custom
skills are preserved. Missing caches, unsafe paths, ownership mismatches, and
name collisions fail closed.

The local profile keeps one model route for every OMP role:
`copilot-proxy-rs/qwen3.6-35b-a3b-local`. The default profile keeps native
Copilot authentication and defaults to `github-copilot/gpt-5.6-sol:medium`.
Host token precedence for the default profile is
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`, with
the existing macOS `copilot-cli` Keychain credential as a final fallback. Only
`COPILOT_GITHUB_TOKEN` reaches OMP; alternate token variables are removed and
the selected token is never written to profile state or logs.

If no host Copilot credential is available, use profile-scoped authentication:

```bash
trx run omp default auth-broker login github-copilot
```

All other arguments pass unchanged to OMP:

```bash
trx run omp local models copilot-proxy-rs
trx run omp local -p "Reply exactly OMP_LOCAL_OK"
trx run omp default -p "Reply exactly OMP_COPILOT_OK"
```

## Headless compatibility

Headless capability publication is conservative. Only OMP 18.8.5 has the verified `--headless-policy no-user-input` contract. The backend accepts that
policy for either profile only at that exact version and uses a temporary
overlay. The default profile publishes its tested prompt/text capability. The
local profile remains conservative and unverified because it has no live
headless smoke contract for the local route.

Other versions publish conservative headless metadata and fail closed when a launch requests `--headless-policy no-user-input`; a successful package-manager
upgrade does not imply that Trellage has verified the new release. The launch
uses a temporary overlay containing only:

```yaml
ask:
  enabled: false
```

The file is passed through OMP `--config`, removed on normal exit or signal,
and never changes persistent profile settings.

## Test

```bash
make native-omp-profile
```

The contract uses fixture homes plus fake host package managers, proxy, and OMP
executables. It does not modify the live OMP installation or profile state.
