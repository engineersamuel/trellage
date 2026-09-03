# trellage-claude-common

Shared Native Claude runtime consumed by owned Claude launchers: `cldx` and
`fmx` are both current consumers of this stable internal API. This package
owns exactly one file: `native-claude`, an executable Bash script that
centralizes every piece of Claude-profile logic that must behave
identically across launchers.

## Internal API

`native-claude` exposes a stable, flag-based CLI. All four common flags are
required unless noted; `launch` also requires the `--` separator:

```
native-claude prepare --home ABS --marker ABS --marker-value VALUE \
  --bridge enabled|disabled [--profile NAME] [--require-existing]

native-claude doctor --home ABS --marker ABS --marker-value VALUE \
  --bridge enabled|disabled [--profile NAME]

native-claude launch --home ABS --marker ABS --marker-value VALUE \
  --bridge enabled|disabled [--profile NAME] -- [CLAUDE_ARGS...]

native-claude version      # prints the normalized semantic version (X.Y.Z)
native-claude model-id     # prints the default model id (claude-opus-5)
native-claude exec-clean [--interpreter ABS] -- ABSOLUTE_COMMAND [ARGS...]
```

Flags:

- `--home ABS`: absolute path to the profile's Claude home directory
  (`CLAUDE_CONFIG_DIR`). Must itself be an existing, symlink-free directory
  (on `--require-existing` prepare/`doctor`/`launch`) reachable through a
  symlink-free directory chain; `--marker` must share `--home`'s parent
  directory. `native-claude` fails closed otherwise.
- `--marker ABS` / `--marker-value VALUE`: absolute path to the caller's
  ownership marker file and the exact value it must contain. `native-claude`
  never invents its own ownership scheme — the calling launcher supplies its
  own marker path/value so multiple launchers can never collide.
- `--bridge enabled|disabled`: whether the optional Trellage session-bridge
  hook should be installed (`enabled`) or absent (`disabled`) for this home.
  `launch` asserts the full bridge state (executable presence/absence *and*
  hook presence/absence) before exec-ing into Claude. See "Bridge contract"
  below.
- `--profile NAME` (optional on `prepare`/`doctor`/`launch`, default
  `default`): the profile identifier recorded in the installed
  session-bridge hook command (`--agent claude --profile NAME`). This lets
  the bridge hook be found, asserted, and removed precisely without
  touching unrelated hooks.
- `--require-existing` (optional on `prepare`): when set, `prepare` behaves
  like a repair — it requires the profile to already be owned and refuses to
  create a fresh profile. When unset, `prepare` is idempotent: it creates an
  empty profile if none exists, or refreshes an already-owned one.

`launch` requires a literal `--` separator before `CLAUDE_ARGS...` and execs
the resolved `claude` binary in place (replacing the `native-claude`
process), preserving PID/signal transparency for the calling launcher.

`exec-clean` is the internal preprocessor boundary for another executable
inside the same installed runtime. It applies the shared provider/token scrub,
validates an absolute, non-symlink command under `TRELLAGE_CLAUDE_RUNTIME_ROOT`,
and execs it. `--interpreter ABS` also validates and resolves an explicit
interpreter, then uses it instead of the command's shebang. `fmx-worker` uses
this form so neither of its Bash boundaries depends on a pane daemon's PATH.

## What the shared runtime owns

- Claude executable and version resolution.
- Safe profile path checks (symlink-free, ownership-marked directory chains).
- Onboarding state (`.claude.json`) and trust acceptance for the current
  workspace.
- Claude settings (`settings.json`), including the default `Rundown` output
  style. Theme preferences remain user-owned.
- Installing the floating `native-common` skills bundle.
- copilot-proxy-rs health/model-catalog checks.
- Explicit provider/token environment scrubbing (see "Provider/token scrub
  contract" below) and model defaulting/injection.
- Signal/exec behavior for `launch`.
- Optional Trellage session-bridge installation/removal.

Catalog schema validation, `list`/`inventory` projections, and vendored
output-style assets remain owned by each launcher (e.g. `cldx`), since those
assets/schemas live outside this shared runtime's scope.

## Provider/token scrub contract

`prepare`, `doctor`, `launch`, `exec-clean`, and the standalone `version` verb each call a
single shared `scrub_provider_environment` as early as possible — before
any external child process this runtime spawns (`claude --version`, the
floating-skills `ensure` (node), the copilot-proxy-rs health/model probes
(curl), session-bridge hook installation (python3), or the final launched
Claude process) — so a stale tmux/Herdr daemon environment (the fmx worker
threat model) can never leak into any of them. `model-id` starts no child
process and needs no scrub. The list is always explicit — never a
wildcard/prefix delete — so removals stay auditable:

- **Anthropic/Claude**: `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`,
  `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`,
  `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
  `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_API_KEY`,
  `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE`,
  `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`.
- **AWS/Bedrock**: `CLAUDE_CODE_USE_BEDROCK`, `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`,
  `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`, `AWS_DEFAULT_REGION`,
  `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`,
  `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`.
- **Google/Vertex**: `CLAUDE_CODE_USE_VERTEX`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_CLOUD_PROJECT`,
  `GOOGLE_CLOUD_QUOTA_PROJECT`, `GOOGLE_CLOUD_REGION`, `VERTEX_PROJECT`,
  `VERTEX_REGION`.
- **Azure/OpenAI**: `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TENANT_ID`, `OPENAI_API_KEY`, `AZURE_API_KEY`,
  `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `OPENAI_BASE_URL`.
- **GitHub/Copilot token overrides**: `COPILOT_GITHUB_TOKEN`,
  `COPILOT_PROXY_GITHUB_TOKEN`, `COPILOT_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`,
  `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN`. `GH_CONFIG_DIR` is
  deliberately **not** scrubbed, since fmx workers rely on it for file-backed
  `gh` auth.

After scrubbing, `launch` injects only the managed values
(`CLAUDE_CONFIG_DIR`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and the
default/overridden model ids) before exec-ing `claude`; `prepare`/`doctor`/
`version` run the same scrub with no injected values, since none of them
exec `claude` itself, only probe its version.

## Bridge contract

- `--bridge enabled` on `prepare` installs `$HOME/.trellage/trellage-session-bridge.py`
  (mode `0700`) and ensures `settings.json` has exactly one `SessionStart`
  hook entry for `($bridge_path, $profile)`.
- `--bridge disabled` on `prepare` removes that same bridge executable (if
  safe: a regular, non-symlink file) and removes every `SessionStart` hook
  entry whose `.command` matches this runtime's managed prefix for
  `$bridge_path` — the exact shlex-quoted bridge path plus
  `" native-hook --agent claude --profile "` — regardless of which profile
  the stale entry names. It never touches unrelated hook entries (e.g.
  hooks installed by the user or by other tooling) and never deletes a
  non-empty `.trellage` directory.
- A stale managed hook can otherwise survive a profile rename: the
  reference session-bridge installer only dedupes an exact command match
  for the *current* profile, so it never removes a hook it previously
  installed for a different profile at the same `$bridge_path`. `prepare`
  prunes any such stale managed hook every time it installs or removes the
  bridge, so a bridge-enabled home always ends up with exactly the current
  managed hook (never more), and a bridge-disabled home always ends up with
  none (never a leftover for another profile).
- `doctor`/`launch` use `--bridge` to assert this same full state: enabled
  requires the executable, the exact current-profile hook, and zero stale
  managed hooks for another profile; disabled requires the executable
  absent and zero managed hooks for any profile. Both fail closed with a
  `repair` hint on mismatch.
- Before trusting any hook count, `doctor`/`launch` require `settings.json`
  to be a regular, non-symlink file containing a well-formed JSON object
  (an absent `hooks`/`hooks.SessionStart` is valid and means zero hooks).
  A missing `settings.json` fails with a `repair` hint (an owned profile
  always has one from `prepare`'s `ensure_settings`); a symlinked or
  malformed one fails closed with an `unsafe`/`invalid Claude settings`
  error instead of silently being treated as "zero managed hooks".
- Hook-command strings are built to match the reference session-bridge
  installer (`scripts/trellage-session-bridge.py`) byte-for-byte: the hook
  path is squeezed to a single slash first (`squeeze_slashes`, matching
  Python's `pathlib.Path` normalization), then the hook path and profile are
  each shell-quoted the same way Python's `shlex.quote()`/`shlex.join()`
  would render them, so paths or profile names containing spaces or quotes
  still compare equal.

## Environment contract

Callers must export:

- `TRELLAGE_CLAUDE_LAUNCHER_NAME`: the caller's own command name (e.g.
  `cldx`), used only for `native-claude`'s own error-message prefix and
  `repair`/`setup` hints. Must match `[A-Za-z0-9_-]+`.
- `TRELLAGE_CLAUDE_RUNTIME_ROOT`: the caller's own installed runtime root
  (an absolute, symlink-free, non-redirected directory). `native-claude`
  resolves sibling shared assets (floating-skills manager/catalog, the
  session-bridge source) relative to this root, first as an installed
  sibling (`$runtime_root/../common/...`, `$runtime_root/lib/...`) and
  falling back to the dev-repo layout (`$runtime_root/../../scripts/...`)
  when running uninstalled from a worktree.

## Owned launcher responsibilities

An owned launcher (like `cldx`) remains a thin delegator: it owns its own
public CLI surface, catalog validation, `list`/`inventory` projections, and
any vendored assets, then calls `native-claude prepare`/`doctor`/`launch`
for everything else, exec-ing into `native-claude launch` for the final
Claude invocation so the launcher's own PID is replaced (not wrapped).
