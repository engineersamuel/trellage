---
schemaVersion: 2
templates:
  rundown-status-and-handoff: |-
    Use the Rundown output style to provide a clear status and handoff for
    {{intent}}.
  general-engineering-task: "{{intent}}"
---

# Native Claude Code (`claude`) — `default` profile

`claude` runs the host-installed Claude Code CLI with one isolated `default`
profile, routed through keyless `copilot-proxy-rs` and defaulting to
`claude-opus-5`. See `prototypes/trellage-claude-profiles/README.md` for the
authoritative operational reference.

## Use This Profile When

- You want a clean, isolated Claude Code session (separate `CLAUDE_CONFIG_DIR`)
  that never touches a developer's real `~/.claude` state or credentials.
- You want Claude Sonnet 5.5 and Opus 5.5 without managing a personal Anthropic key, by routing
  through the shared local proxy.
- You want status-style output (TL;DR, checklist, "Your move:") to appear by
  default, since the profile installs a Rundown output style at setup.
- You need a fully autonomous, non-interactive run: permission prompts are
  bypassed and `AskUserQuestion` is disallowed on every launch.

## Avoid This Profile When

- You need native Anthropic/Bedrock/Vertex authentication — launch removes
  those credential variables before starting Claude.
- You need a real OS-level sandbox or container boundary. `claude` is one of
  the seven native launchers that remain unsandboxed by design (see
  `docs/native-sandbox-research.md`); Claude runs with full host access.
- The task genuinely needs a human-in-the-loop question; the profile cannot
  pause for `AskUserQuestion`.

## Workflow Notes

- Launch with `trx run claude default`; explicit `--model` wins over
  the default `claude-opus-5` (for example `trx run claude default --model claude-sonnet-5`).
- Every `setup`, `doctor`, `repair`, and launch verifies proxy health and that
  `claude-opus-5` is advertised before running.
- The profile also installs the shared `native-common` floating skill bundle
  (see `config.example.toml`: `engineersamuel` wildcard selection, `show-me`, and
  manually activated `i-have-adhd`), so
  general-purpose repository skills remain available alongside Claude's own
  tool use.
- The Rundown output style is applied at the launcher level (all launches of
  this profile), not per-prompt — no explicit request is needed for the
  TL;DR/checklist format.

## Gotchas

- Uninstalling only removes the owned command and runtime; profile state,
  sessions, and the Rundown output style asset are preserved for reuse.
- Because permission prompts are bypassed, treat this profile as trusted-repo
  only — Claude can read/write anything the host process can reach.
