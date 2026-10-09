# Native Oh My Pi profiles

Public commands use the [`trx` router](../trellage-router/README.md). Install it alongside this canonically named private backend, which is not published on `PATH`.

`trx run omp PROFILE` runs host-native Oh My Pi with two isolated profiles:

- `local` uses `copilot-proxy-rs` with only
  `qwen3.6-35b-a3b-local` enabled.
- `default` uses OMP's native GitHub Copilot provider and discovered models
  without the local proxy.

Choose the local proxy or native Copilot explicitly with
`trx run omp local ...` or `trx run omp default ...`.

## Requirements

- `mise`
- `curl`
- `jq`
- `copilot-proxy-rs` listening on `http://127.0.0.1:8080` for `local`
- Native GitHub Copilot authentication for `copilot`

No API key is required or written for `local`. The managed provider uses
`auth: none` and OpenAI Responses.

## Install and lifecycle

```bash
./install.sh
trx setup omp local
trx setup omp default
trx doctor omp local
trx doctor omp default
trx upgrade omp local --check
trx upgrade omp local
trx repair omp local
```

The installer keeps `omp` as a private backend and owns its runtime beneath
`~/.local/share/trellage/omp`. `setup` resolves the latest release eligible
under `mise` policy on first use, installs it into the managed runtime, and
records the exact installed version in the local `installed-version` receipt.
Ordinary launches reuse that version without a network request. Only explicit
`trx upgrade omp local` resolves latest again, and a failed update preserves the last good
installed version, receipt, version-specific configuration, and managed skill
state. The bundled OMP community skills require OMP 17.3.5 or newer. Profiles
using an older installed OMP release omit the community skill directory from
discovery; run `trx upgrade omp local` to enable it.

Managed OMP files live at:

```text
~/.omp/profiles/trellage-qwen-local/agent/config.yml
~/.omp/profiles/trellage-qwen-local/agent/models.yml
~/.omp/profiles/trellage-copilot-native/agent/config.yml
~/.omp/profiles/trellage-copilot-native/agent/models.yml
```

Both profiles also receive 34 approved community skills from:

- [`dsebban/skills`](https://github.com/dsebban/skills): `orchestrate-omp`,
  `poteto-mode`, and `pstack-omp`
- [`Aqua-123/pstack-for-codex`](https://github.com/Aqua-123/pstack-for-codex):
  31 harness-neutral pstack workflow, principle, automation, and support skills

The approved source policy is in `config.toml`. The two repositories both
provide `poteto-mode`; Trellage intentionally selects the dsebban version
because it adapts pstack skill links and agent roles for OMP. Codex-specific
skills, hooks, profiles, setup automation, and namespaced invocation remain
exclusive to the `trx run codex pstack` profile. The first
eligible OMP setup resolves the latest source commits into a shared local
cache. Later launches work offline and synchronize the cached snapshot
atomically into each profile's `agent/community-skills` directory without
removing unrelated skills. Run `trx skills update` to refresh both the common
native skills and this OMP-only cache from the approved default branches.

Then run `trx upgrade omp local --skills-only` and `trx upgrade omp default --skills-only` to update
the existing copies. Each command checks both caches and both managed targets
before writing `agent/skills` (`native-common`) or `agent/community-skills`
(`omp-community`). Custom skills are preserved. Missing caches or copies,
invalid ownership, unsafe paths, and name collisions fail closed. The command
never fetches, starts OMP or the proxy, changes configuration or authentication,
or updates the harness. Older profiles without a managed community copy need
their normal explicit upgrade first.
`trx --help` shows router commands. Use
`trx run omp local --help` or `trx run omp default --help` for upstream OMP help.

Setup and repair refuse symlinked paths or unrelated existing profile files.
They preserve other profile state, including sessions. `doctor` is read-only
and checks managed bytes and the receipt-selected `mise` installation. The `local`
doctor also checks proxy health and local model discovery. The `copilot` doctor
checks native GitHub Copilot authentication and model availability.

Launching self-heals. OMP rewrites its own config during use, so a launch that
finds drifted managed bytes republishes them and reports
`omp: managed config restored` on stderr before starting; a launch that finds the
receipt-selected version missing installs it. `trx repair omp local` remains available
for repairing without launching, and `trx doctor omp local` keeps the strict read-only
check. Self-healing never crosses the ownership boundary: an unmanaged or
foreign-marked profile still fails with `profile is not managed`.

The `copilot` profile matches the container profile's host-auth order:
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`.
On macOS it additionally falls back to the existing `copilot-cli` Keychain
credential. The selected token is forwarded only as `COPILOT_GITHUB_TOKEN`;
alternate token variables are removed before OMP starts. The token is not
copied into the profile, written to disk, or logged.

If no host Copilot credential is available, OMP can use profile-scoped
authentication. Run:

```bash
trx run omp default auth-broker login github-copilot
```

The Copilot profile defaults to `github-copilot/gpt-5.6-sol:medium` while
leaving the rest of the authenticated Copilot model catalog available.

All other arguments pass unchanged to OMP:

```bash
trx run omp local models copilot-proxy-rs
trx run omp local -p "Reply exactly OMP_LOCAL_OK"
trx run omp default -p "Reply exactly OMP_COPILOT_OK"
```

Use `--headless-policy no-user-input` for one non-interactive launch that must
fail if OMP tries to ask the user. Trellage writes one temporary one-shot
overlay with only:

```yaml
ask:
  enabled: false
```

The launcher passes that file through OMP `--config`, removes it on exit or
signal, and leaves the managed profile configuration unchanged. For exact OMP
`18.0.10`, only the `copilot` profile publishes
`headless.questionToolControl = "prompt-only"` with the live-proved prompt/text
contract. The `local` profile stays fully conservative, including
`headless.questionToolControl = "none"`, until it has its own live smoke.
Other versions stay discoverable in `trx list --json`, but they fall back to
conservative `headless` values and `--headless-policy no-user-input` fails
closed. OMP 18.0.10 therefore retains its verified headless behavior while
loading the current community skills; other releases do not inherit that
verification without a new live probe.

Tool approval is set to `yolo` in both managed configuration and every launch
argument vector. The agents can use all host access available to the OMP process.

## Uninstall

```bash
./uninstall.sh
```

Uninstall removes only the owned command and managed runtime. Both named
profiles, their configuration, authentication, sessions, and other state
remain.

## Test

```bash
make native-omp-profile
```

The contract uses fixture homes plus fake `mise`, proxy, and OMP executables.
It does not modify the live profile.
