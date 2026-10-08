# Native jcode profile

Public commands use the [`trx` router](../trellage-router/README.md). Install it alongside this canonically named private backend, which is not published on `PATH`.

`trx run jcode PROFILE` runs [jcode](https://github.com/1jehuang/jcode) directly on the host with
an isolated profile. It uses keyless `copilot-proxy-rs` at
`http://127.0.0.1:8080/v1` and defaults to `gpt-5.6-sol` with `medium`
reasoning.

## Requirements

- `mise`
- `node`
- `curl`
- `jq`
- `copilot-proxy-rs` listening on `http://127.0.0.1:8080`

No API key is written. The launcher materializes an owned, keyless named
OpenAI-compatible provider and also applies the provider, model, and reasoning
defaults through process environment variables. It forces cross-provider
failover to `manual`, clears inherited `JCODE_*` overrides, and neutralizes
file-based request-body overrides so a proxy failure cannot resend the prompt
through another provider.

Every launch sets `JCODE_NO_TELEMETRY=1`. Setup seeds jcode's launch state past
the first-run threshold, and launches repair a lowered counter while preserving
other setup preferences, so guided onboarding and setup hints do not appear.

## Install and lifecycle

```bash
./install.sh
trx setup jcode default
trx doctor jcode default
trx upgrade jcode default --check
trx upgrade jcode default
trx repair jcode default
```

The installer keeps `jcode` as a private backend and owns its runtime beneath
`~/.local/share/trellage/jcode`. `setup` resolves the latest jcode release
eligible under `mise` policy on first use, installs it into the managed
runtime, and records the exact installed version in the local
`installed-version` receipt. Ordinary launches reuse that version without a
network request. Only explicit `trx upgrade jcode default` resolves latest again, and a failed
update preserves the last good installed version and receipt.

`trx upgrade jcode default --skills-only` copies and verifies only the refreshed
`native-common` cache after `trx skills update`. It requires an existing owned
profile and managed skill state. Custom skills, configuration, authentication,
and runtime receipts are preserved. Missing caches, invalid ownership, unsafe
paths, and name collisions fail closed. It never fetches, runs jcode, or
checks or starts the proxy.

## Manual output skill

The shared bundle includes `i-have-adhd`, but JCode does not honor its
`disable-model-invocation` metadata. `jcode` keeps a complete managed skill library
outside `JCODE_HOME` and excludes this skill from `home/skills`, where JCode
discovers skills automatically. Other skills remain available as before.

Apply the skill to one explicit request:

```bash
trx skill jcode i-have-adhd "Summarize the current branch"
```

This command uses JCode's `run` command and exits after the response. It does not
register `/i-have-adhd` or enable the skill for later ordinary launches.
For an existing interactive JCode session, explicitly ask JCode to read and apply:

```text
~/.local/share/trellage/profiles/jcode/default/skill-library/i-have-adhd/SKILL.md
```

The mode then follows the upstream session rules; request `stop adhd mode` or
`normal mode` to stop it. Install the updated launcher before `trx skills update`.
Setup, launch, repair, and `skills-update` maintain both managed copies. An
unmanaged `home/skills/i-have-adhd` collision stops the operation rather than
deleting user content or allowing automatic discovery.

## Profile state and launch

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

Launch the profile explicitly:

```bash
trx run jcode default
trx run jcode default -- run "Reply exactly JCODE_OK"
```

The launcher passes `--no-update` before caller arguments; explicit jcode CLI
flags can override other launcher defaults. `doctor` and every launch verify the
proxy health response and confirm that `gpt-5.6-sol` is advertised. JCode can
expand `config.toml` with its own defaults during normal use. The launcher
preserves those normalized settings while strictly checking the managed
provider, model, proxy URL, keyless authentication, catalog, pinning, and
reasoning fields through a Bun source TOML manager and JCode's own
parser. Launches and `repair` preserve valid JCode-owned values, including
multiline arrays, while restoring managed fields. A missing or malformed config
is replaced with the minimal managed config. Unsafe paths and unowned profile
state still fail closed.

`jcode` adds no containment. jcode runs with all host access available to the
process.

## Uninstall

```bash
./uninstall.sh
```

## Test

```bash
make native-jcode-profile
```

`config-manager.ts` is the authored runtime. Bun runs it directly with the
locked `smol-toml` dependency. There is no generated manager or bundle to rebuild.
Reinstall the Native launcher after changing its source.
