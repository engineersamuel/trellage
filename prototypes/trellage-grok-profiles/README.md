# Isolated Grok profiles

`grx` runs Grok with named, clean user-state profiles while keeping the current
repository and host development environment available. The profiles are
`hve` and `superpowers`.

The catalog intentionally excludes `awesome-copilot`. Older direct Grok
installations could treat its Copilot-wide instruction files as global Grok
instructions, including a thought-logging workflow that paused after each phase
and could end with no user-visible response.

## Prerequisites and installation

- Grok Build CLI 0.2.112 or later (tested with 0.2.112).
- An existing Grok login at `~/.grok/auth.json`
- `jq`
- `curl`

grx does not enforce the CLI version; other versions are unverified.

Install the launcher and catalog:

```sh
./install.sh
```

The installer does not modify `PATH`.
`~/.local/bin` must already be on `PATH`, or invoke `~/.local/bin/grx` directly.

The installer places the command at `~/.local/bin/grx`. Its managed runtime is
`~/.local/share/trellage/grx/`, including the launcher at
`~/.local/share/trellage/grx/bin/grx` and the catalog at
`~/.local/share/trellage/grx/catalog.json`.

Each profile has an independent home at
`~/.local/share/trellage/profiles/grok/<profile>/home/`. Plugin state,
requirements, sessions, and authentication created for a profile stay in that
profile home. Authentication is refreshed from the host login before use.

## Commands

```sh
grx list
grx inventory hve --json
grx setup hve
grx setup superpowers
grx setup --all
grx hve
grx superpowers -p "Review this repository"
grx doctor hve
grx update --check hve
grx update --check --all
grx update hve
grx update --all
grx repair hve
```

Use `grx list --json` for the stable machine-readable catalog, including
launcher, harness, plugin, source, marketplace, and standalone MCP metadata.
These are catalog declarations, not proof that profile setup or installed
plugin state is healthy. Use `grx doctor PROFILE` for that validation.
`grx inventory PROFILE --json` is read-only. It reports readiness, the validated
cataloged plugin/version, every enabled user plugin reported by `inspect --json`,
exact package skills counted as `SKILL.md` files beneath the cataloged plugin's
safely validated installed root, broader CLI-visible entries, and enabled MCP
names. Non-cataloged enabled plugins use version `"unknown"` when Grok does not
report a version.

After installing the native launchers and the
[`trx` router](../trellage-router/README.md), run `trx` for one flat Ink
harness/profile picker. Remaining arguments are forwarded to `grx` unchanged
after selection; `trx` never performs setup, repair, or update.

`setup` creates a profile home and installs its cataloged plugin. Launching with
`grx hve` or `grx superpowers` never installs or updates anything. Version
checks and changes are explicit through `grx update --check` and `grx update`.

### Model routing

`grx hve` and `grx superpowers` route model requests through
`copilot-proxy-rs` at `http://127.0.0.1:8080/v1` and default to `grok-4.5`.
Pass `-m` or `--model` to select another model from the proxy catalog; `grx`
forwards the option and its value unchanged.

Profile launches default to `--permission-mode bypassPermissions`. An explicit
permission mode, approval flag, allow rule, or deny rule is forwarded unchanged
and suppresses that default.

Proxy routing applies only to profile launches. Setup, repair, update, doctor,
and other lifecycle operations do not receive the proxy variables. Plain `grok`
and `~/.grok` remain untouched, so direct Grok usage keeps xAI OAuth and its
`grok-4.5` default.

Setup and repair rewrite managed `requirements.toml` to catalog policy.
They normalize the profile home to mode `0700` and managed `requirements.toml` to mode `0644`.
`fail_closed = true` is the first top-level key in the managed policy.
It prevents the Grok Build 0.2.112 session-start managed-config refresh from clearing the local isolation policy when no team principal owns it.
They preserve existing sessions, memory, and permissions.
Repair restores managed policy and a missing cataloged plugin; it is not generic recovery for every doctor failure.
Launch refuses a profile until setup completes, and refuses damaged managed policy or unsafe authentication paths instead of silently repairing them.

### Update checks

`grx update --check` requires `curl` and uses network access to fetch official manifests for installed profiles.
For a valid check with the prerequisites available, the statuses are:

Exit status: 0 means current; 1 means update available or not installed; 2 means an operational error.
Status 1 is expected in automation and is not an operational failure.

## State and compatibility boundary

At launch, `grx` preserves `HOME`, the current working directory (CWD), TTY,
Git and SSH behavior, and the Herdr environment. It points `GROK_HOME` at the
selected profile home and sets only the three model-routing variables described
above.

Source authentication must be a readable, regular, non-symlink file; its source mode may be arbitrary.
Each profile copy is created with mode `0600`.
Before every selected-profile Grok invocation, `grx` atomically refreshes the profile `auth.json` from `~/.grok/auth.json`.
This includes launch, setup, doctor, update checks, update, and repair; `grx list`
does not refresh authentication or invoke Grok.
When source and profile authentication already match, `grx` preserves the profile `auth.json` inode while enforcing mode `0600`.
Authentication is copied independently into each profile home. Refresh failure
leaves the prior profile authentication intact, and source or destination
authentication symlinks are rejected.
Refreshes for the same profile are serialized. If host authentication rotates
during a refresh, `grx` retries and returns only after the profile copy matches
the latest stable readable source. An active lock is bounded by a timeout; a
stale lock is diagnosed and left in place for explicit inspection rather than
removed unsafely. Before verification commits a refresh, HUP, INT, and TERM
remove only the transaction's owned staging file and lock and restore the prior
`auth.json`. After commit, interruption during lock cleanup retains the verified
new `auth.json` so a later refresh cannot be overwritten by stale rollback.

Each profile may define profile-local user-scoped MCP servers in its own
`config.toml`. `grx` does not import MCP servers from `~/.grok/config.toml`;
configure each selected profile explicitly. For example:

```sh
grx superpowers mcp add playwright -- npx -y @playwright/mcp@latest
grx superpowers mcp list --json
```

Setup, repair, update, doctor, and launch preserve and allow valid profile-local
MCP definitions. MCP definitions in one profile are not shared with another.

Profile policy disables Claude and Cursor compatibility loading and disables
Codex sessions. Personal `~/.agents/skills` and `~/.agents/commands` are
ignored. Repository-native `.grok`, `.agents`, and `AGENTS.md` content remains
visible, as does generic repository `CLAUDE.md` guidance.
`inspect --json` may retain personal Claude or Cursor entries; they are operationally disabled either by entry-level `disabled: true` plus `compatibilityStatus: "disabled"` or by the matching disabled `externalCompat` vendor/surface cell. Plugin container metadata is allowed only when every provided invocable surface is disabled.

This is clean user-state separation, not containment and not a security boundary.
Trusted plugin components may execute with host permissions and can reach the
repository and host resources available to Grok.

## Removal and tests

Run `./uninstall.sh` to remove the managed `grx` command and runtime.
Uninstall preserves all profile homes, including authentication, plugins, sessions, memory, and permissions.

Run the contract suite with:

```sh
bash tests/contract.sh
```

The contract uses only temporary fake state. It does not install plugins or
change real Grok profile homes.
