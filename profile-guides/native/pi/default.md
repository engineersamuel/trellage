---
schemaVersion: 2
templates:
  daily-coding-with-extension-support: |
    Use Pi's available coding tools and explicitly selected skills to complete
    and verify {{intent}}. Base tool choices on the tools actually exposed in
    this session, not on an assumed extension inventory.
  goal-and-plan-tracking: |
    Use the managed pi-plan-mode and pi-goal support to keep the plan and
    completion criteria current while carrying out {{intent}}.
  subagent-and-workflow-fanout: |
    For {{intent}}, first check whether subagent or dynamic-workflow tools are
    actually available in this session. This profile does not itself install
    pi-subagents or pi-dynamic-workflows. If those tools are absent, explain
    the limitation rather than claiming delegation occurred. When available,
    coordinate bounded tasks and verify the integrated result.
---

# Native Pi — default workflow instructions

`trx run pi default` composes upstream Pi with
keyless `copilot-proxy-rs/gpt-5.6-sol:medium` and one fixed, ordered extension
set. Install and update the `pi` harness binary outside Trellage.

Use the tools exposed by the running session. Keep the task's plan and goal
criteria separate from a claim that implementation or verification succeeded.
No workflow here defines a separate native goal-execution controller.

Ordinary runs use profile-scoped state but can still load repository context.
They are not an OS sandbox. Use `trx run pi clean` when the task requires
suppressing repository and host skills, extensions, context files, MCP servers,
and themes rather than using the configured profile.

## Avoid This Profile When

- You need host-specific Claude, Codex, Cursor, or OMP MCP configuration
  auto-loaded; managed `mcp.json` sets `hostConfigDiscovery` to `off`, and
  only the documented `pi-mcp-adapter` precedence applies.
- You need a different extension list mid-session; the `default` preset keeps
  its ten extensions fixed.
- You assume host Copilot, OpenAI, or Azure OpenAI credentials are available
  to the session; launches remove those variables because the managed proxy
  provider uses no API key.

## Workflow Notes

- `trx run pi default` selects the built-in `default` preset.
- `trx inventory pi default --json` probes the host `pi` binary and reports
  readiness and its version. Pi lifecycle commands are unavailable because the
  harness is installed and updated outside Trellage.
- No documented explicit slash/invocation syntax exists for any of the ten
  bundled extensions in this repository's sources — treat extension names as
  descriptive vocabulary in prompts rather than commands.
- The bare Pi runtime no longer needs the former Oh My Pi source patches for
  `pi-context-view` or `pi-fff`.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `pi`/`default` as `untested`:
  static harness, catalog, inventory, and headless contracts pass, but an
  end-to-end Herdr round trip has not yet run.
