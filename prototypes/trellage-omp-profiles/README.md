# Native Oh My Pi profiles

`omp` runs host-native Oh My Pi with two isolated profiles:

- `local` uses `copilot-proxy-rs` with only
  `qwen3.6-35b-a3b-local` enabled.
- `copilot` uses OMP's native GitHub Copilot provider and discovered models
  without the local proxy.

Bare `omp` invocations continue to use `local`. Explicit launches use
`omp local ...` or `omp copilot ...`.

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
omp setup
omp setup copilot
omp doctor
omp doctor copilot
omp update --check
omp update
omp repair
```

The installer publishes `~/.local/bin/omp` and owns its runtime beneath
`~/.local/share/trellage/omp`. `setup` resolves the latest release eligible
under `mise` policy, installs it into the managed runtime, and pins that exact
version. Ordinary launches never update it. Only `omp update` changes the pin.

Managed OMP files live at:

```text
~/.omp/profiles/trellage-qwen-local/agent/config.yml
~/.omp/profiles/trellage-qwen-local/agent/models.yml
~/.omp/profiles/trellage-copilot-native/agent/config.yml
~/.omp/profiles/trellage-copilot-native/agent/models.yml
```

Setup and repair refuse symlinked paths or unrelated existing profile files.
They preserve other profile state, including sessions. `doctor` is read-only
and checks managed bytes and the pinned `mise` installation. The `local`
doctor also checks proxy health and local model discovery. The `copilot` doctor
checks native GitHub Copilot authentication and model availability.

Launching self-heals. OMP rewrites its own config during use, so a launch that
finds drifted managed bytes republishes them and reports
`omp: managed config restored` on stderr before starting; a launch that finds the
pinned version missing installs it. `omp repair` remains available for repairing
without launching, and `omp doctor` keeps the strict read-only check. Self-healing
never crosses the ownership boundary: an unmanaged or foreign-marked profile still
fails with `profile is not managed`.

The `copilot` profile matches the container profile's host-auth order:
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`.
On macOS it additionally falls back to the existing `copilot-cli` Keychain
credential. The selected token is forwarded only as `COPILOT_GITHUB_TOKEN`;
alternate token variables are removed before OMP starts. The token is not
copied into the profile, written to disk, or logged.

If no host Copilot credential is available, OMP can use profile-scoped
authentication. Run:

```bash
omp copilot auth-broker login github-copilot
```

The Copilot profile defaults to `github-copilot/gpt-5.6-sol:medium` while
leaving the rest of the authenticated Copilot model catalog available.

All other arguments pass unchanged to OMP:

```bash
omp models copilot-proxy-rs
omp -p "Reply exactly OMP_LOCAL_OK"
omp copilot -p "Reply exactly OMP_COPILOT_OK"
```

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
