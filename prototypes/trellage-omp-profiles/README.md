# Native local-Qwen OMP profile

`omp` runs host-native Oh My Pi through `copilot-proxy-rs` with only
`qwen3.6-35b-a3b-local` enabled. It uses OMP's named
`trellage-qwen-local` profile, so configuration and sessions stay isolated from
the default OMP profile.

## Requirements

- `mise`
- `curl`
- `jq`
- `copilot-proxy-rs` listening on `http://127.0.0.1:8080`

No API key is required or written. The managed provider uses
`auth: none` and OpenAI Responses.

## Install and lifecycle

```bash
./install.sh
omp setup
omp doctor
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
```

Setup and repair refuse symlinked paths or unrelated existing profile files.
They preserve other profile state, including sessions. `doctor` is read-only
and checks managed bytes, the pinned `mise` installation, proxy health, and
model discovery.

All other arguments pass unchanged to OMP:

```bash
omp models copilot-proxy-rs
omp -p "Reply exactly OMP_LOCAL_OK"
```

Tool approval is explicitly set to `yolo`. The agent can use all host access
available to the OMP process.

## Uninstall

```bash
./uninstall.sh
```

Uninstall removes only the owned command and managed runtime. The
`trellage-qwen-local` profile, configuration, sessions, and other state remain.

## Test

```bash
make native-omp-profile
```

The contract uses fixture homes plus fake `mise`, proxy, and OMP executables.
It does not modify the live profile.
