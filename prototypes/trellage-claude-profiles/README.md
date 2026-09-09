# Native Claude Code profile

`cldx` runs the host-installed
[Claude Code](https://github.com/anthropics/claude-code) executable with one
isolated `default` profile. It uses keyless `copilot-proxy-rs` at
`http://127.0.0.1:8080` and defaults to `claude-opus-5`.

Trellage Native isolates agent state but is not a container or security
boundary.

## Requirements

- `claude`
- `curl`
- `jq`
- `copilot-proxy-rs` listening on `http://127.0.0.1:8080`

No host model credential is copied. Launch removes ambient Anthropic, Claude
OAuth, Bedrock, Vertex, AWS, Google, Azure, OpenAI, Copilot, and GitHub token
variables before setting the local proxy endpoint and non-secret auth sentinel.

## Install and use

```bash
./install.sh
cldx setup
cldx doctor
cldx
cldx -p "Reply exactly CLDX_OK"
cldx --model claude-sonnet-5 -p "Reply exactly CLDX_SONNET_OK"
cldx repair
cldx harness-update
```

`cldx harness-update` updates the shared host Claude Code executable with its
built-in updater. It takes no profile argument, requires no profile setup or
running proxy, and does not run an agent session. It uses the shared runtime's
credential-environment scrub without adding profile, model, or proxy settings.
Updater output and failure status pass through unchanged.

In `trx admin`, select `claude / default`, then press `U` and confirm with `y`.
Native Claude updates remain separate from Claude container updates.

`cldx skills-update default` copies and verifies only managed `native-common`
skills after `trx skills update` refreshes the shared cache. It requires an
existing owned profile. It preserves custom skills, authentication, settings,
output styles, and session hooks. Missing caches, invalid ownership, unsafe
paths, and name collisions fail closed. It never fetches, starts Claude, or
checks or starts the proxy.

The installer publishes `~/.local/bin/cldx` and owns its runtime beneath
`~/.local/share/trellage/cldx/`. Claude profile state lives at:

```text
~/.local/share/trellage/profiles/claude/default/home/
```

`CLAUDE_CONFIG_DIR` points to that home. Setup completes first-run onboarding
without managing the user's theme preference in `settings.json` or changing
unrelated state. Sessions remain isolated from direct `claude` use.

Bare and explicit launches are equivalent:

```bash
cldx
cldx default
```

If the arguments do not contain `--model` or `--model=...`, `cldx` adds
`--model claude-opus-5`. Explicit model selection wins. All other arguments and
the Claude process exit status pass through unchanged.

Every launch also bypasses permission prompts and disallows `AskUserQuestion`,
so profiles run without waiting for interactive user input.

Every setup, doctor, repair, and launch checks proxy health and confirms that
`claude-opus-5` is advertised.

## Uninstall

```bash
./uninstall.sh
```

Uninstall removes only the owned runtime and command symlink. Profile state and
sessions are preserved.

## Test

```bash
make native-claude-profile
```
