---
schemaVersion: 1
capabilities:
  - claude-opus-5-proxy-routing
  - keyless-copilot-proxy-auth
  - isolated-claude-profile-home
  - rundown-briefing-output-style
  - native-common-skill-bundle
  - autonomous-no-prompt-launch
bestFor:
  - One-shot or scripted Claude Code sessions that must not read or write a developer's personal ~/.claude state, theme, or credentials
  - Teams standardizing on Claude Opus 5 through a shared keyless copilot-proxy-rs endpoint instead of individual Anthropic API keys
  - Status updates, standups, or PR summaries where the built-in Rundown TL;DR-plus-checklist output style should apply automatically
avoidFor:
  - Tasks that require direct Anthropic, Bedrock, Vertex, AWS, Google, or Azure credentials, since launch strips those environment variables before starting Claude
  - Work that needs OS-level sandboxing or containment; cldx grants Claude full host access with no security boundary
  - Sessions that need interactive approval prompts or AskUserQuestion; every launch bypasses permissions and disallows that tool
prerequisites:
  - id: claude-code-cli
    description: Host `claude` (Claude Code) executable installed and resolvable on PATH.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 and advertising claude-opus-5.
  - id: cldx-setup-complete
    description: cldx setup run once so first-run onboarding and the managed output style are staged.
  - id: cli-tools
    description: curl and jq available on the host for health checks used by setup, doctor, and launch.
workflows:
  - id: launch-smoke-test
    description: Confirm the isolated profile launches, copilot-proxy-rs is healthy, and claude-opus-5 responds before starting real work.
    examples:
      - Reply exactly CLDX_OK
      - Confirm the proxy is healthy and reply OK
    promptTemplate: |
      {{intent}}
  - id: rundown-status-update
    description: Ask for a status update, standup note, or PR summary and receive it in the built-in Rundown TL;DR, checklist, and Your-move format automatically, without requesting that format explicitly.
    examples:
      - Give me a status update on the current branch's open PRs
      - Summarize what changed in this session and what's blocked
    promptTemplate: |
      {{intent}}
  - id: general-engineering-task
    description: Delegate an implementation, debugging, or review task to Claude Opus 5, with the shared native-common skill bundle (engineersamuel skills plus show-me) available for repository hygiene, naming, and review support.
    examples:
      - Review this PR diff for correctness and naming issues
      - Debug why this test intermittently fails
    promptTemplate: |
      {{intent}}
---

# Native Claude Code (`cldx`) — `default` profile

`cldx` runs the host-installed Claude Code CLI with one isolated `default`
profile, routed through keyless `copilot-proxy-rs` and defaulting to
`claude-opus-5`. See `prototypes/trellage-claude-profiles/README.md` for the
authoritative operational reference.

## Use This Profile When

- You want a clean, isolated Claude Code session (separate `CLAUDE_CONFIG_DIR`)
  that never touches a developer's real `~/.claude` state or credentials.
- You want Claude Opus 5 without managing a personal Anthropic key, by routing
  through the shared local proxy.
- You want status-style output (TL;DR, checklist, "Your move:") to appear by
  default, since the profile installs a Rundown output style at setup.
- You need a fully autonomous, non-interactive run: permission prompts are
  bypassed and `AskUserQuestion` is disallowed on every launch.

## Avoid This Profile When

- You need native Anthropic/Bedrock/Vertex authentication — launch removes
  those credential variables before starting Claude.
- You need a real OS-level sandbox or container boundary. `cldx` is one of
  the five native launchers that remain unsandboxed by design (see
  `docs/native-sandbox-research.md`); Claude runs with full host access.
- The task genuinely needs a human-in-the-loop question; the profile cannot
  pause for `AskUserQuestion`.

## Workflow Notes

- Bare `cldx` and `cldx default` are equivalent; explicit `--model` wins over
  the default `claude-opus-5` (for example `cldx --model claude-sonnet-5`).
- Every `setup`, `doctor`, `repair`, and launch verifies proxy health and that
  `claude-opus-5` is advertised before running.
- The profile also installs the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard selection plus `show-me`), so
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
