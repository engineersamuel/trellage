# Native jcode profile

`jcx` runs [jcode](https://github.com/1jehuang/jcode) directly on the host with
an isolated profile. It uses keyless `copilot-proxy-rs` at
`http://127.0.0.1:8080/v1` and defaults to `gpt-5.6-sol` with `medium`
reasoning.

## Requirements

- `mise`
- `curl`
- `jq`
- `copilot-proxy-rs` listening on `http://127.0.0.1:8080`

No API key is written. The launcher materializes an owned, keyless named
OpenAI-compatible provider and also applies the provider, model, and reasoning
defaults through process environment variables.

Every launch sets `JCODE_NO_TELEMETRY=1`. Setup seeds jcode's launch state past
the first-run threshold, and launches repair a lowered counter while preserving
other setup preferences, so guided onboarding and setup hints do not appear.

## Install and lifecycle

```bash
./install.sh
jcx setup
jcx doctor
jcx update --check
jcx update
jcx repair
```

The installer publishes `~/.local/bin/jcx` and owns its runtime beneath
`~/.local/share/trellage/jcx`. `setup` resolves the latest jcode release
eligible under `mise` policy, installs it into the managed runtime, and pins
that exact version. Ordinary launches never update it.
Installation refreshes the shared OS-user Deja runtime unless
`TRELLAGE_MEMORY=off` is set. The launcher uses it with this profile's isolated
home and index.

Profile state lives at:

```text
~/.local/share/trellage/profiles/jcode/default/home/
```

`JCODE_HOME` isolates jcode configuration, sessions, authentication, memory,
and other state from direct `jcode` use. The managed `config.toml` explicitly
enables reasoning effort for the proxy-backed GPT model, ensuring `medium` is
used rather than jcode's generic compatibility-provider fallback. Setup and
repair refuse symlinked paths or unrelated existing profile files. Uninstall
preserves this profile.

Bare and explicit launches are equivalent:

```bash
jcx
jcx default
jcx run "Reply exactly JCODE_OK"
```

The launcher passes `--no-update` before caller arguments; explicit jcode CLI
flags can override other launcher defaults. `doctor` and every launch verify the
proxy health response and confirm that `gpt-5.6-sol` is advertised.
Launches automatically restore the owned managed config when it is missing or
differs; unsafe paths and unowned profile state still fail closed.

`jcx` adds no containment. jcode runs with all host access available to the
process.

## Uninstall

```bash
./uninstall.sh
```

Uninstall retains the shared Deja runtime and its local data so other native
launchers continue to work.

## Test

```bash
make native-jcode-profile
```
