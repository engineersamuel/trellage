---
schemaVersion: 1
capabilities:
  - vox-daily-coding-extension-set
  - keyless-proxy-model-routing
  - isolated-pi-profile-home
  - native-common-skill-bundle
  - mcp-adapter-precedence
bestFor:
  - Daily coding work that benefits from Pi's ordered extension set — web access, subagents, fast file/context tooling, plan annotation, goal tracking, and dynamic workflows
  - Sessions that want Pi's context-view and mcp-adapter tooling alongside a fixed, reproducible extension list
  - Tasks that should route through proxy-backed gpt-5.6-sol:medium without an API key
avoidFor:
  - Work that needs host-specific Claude, Codex, Cursor, or OMP MCP configuration auto-discovered; hostConfigDiscovery is off and only documented pi-mcp-adapter precedence applies
  - Sessions that need a different or expanded extension list; ordinary launches never change the ten pinned extensions or the Pi release
  - Non-interactive automation that assumes host Copilot/OpenAI/Azure credentials are present; those variables are removed at launch since the managed provider uses none
prerequisites:
  - id: mise
    description: mise installed on the host; setup resolves and pins the eligible Pi coding agent release.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080/v1 and advertising gpt-5.6-sol; picx doctor checks both conditions.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and update checks.
workflows:
  - id: extension-inventory-check
    description: Confirm which of the ten pinned extensions are active before relying on any of their tools.
    examples:
      - What extensions are installed in this session?
      - Confirm pi-subagents and pi-goal are active before I start
    promptTemplate: |
      {{intent}}
  - id: goal-and-plan-tracking
    description: Use the pi-goal and Plannotator extensions to track a multi-step objective and annotate the plan as work proceeds.
    examples:
      - Set a goal for this refactor and annotate the plan as each step completes
    promptTemplate: |
      {{intent}}
  - id: subagent-and-workflow-fanout
    description: Use pi-subagents and pi-dynamic-workflows to split a larger task across coordinated subagents with a dynamic workflow.
    examples:
      - Split this migration into subagent tasks driven by a dynamic workflow
    promptTemplate: |
      {{intent}}
---

# Native Pi (`picx`) — `default` profile

`picx` runs upstream `@earendil-works/pi-coding-agent@0.84.2` routed through
keyless `copilot-proxy-rs/gpt-5.6-sol:medium`, with one fixed, ordered
extension set. See `prototypes/trellage-picx-profiles/README.md`.

## Use This Profile When

- You want Pi's daily-coding extension set in a fixed order: `Ponytail`,
  `pi-web-access`, `pi-subagents`, `pi-fff`, `pi-context-view`,
  `pi-mcp-adapter`, `pi-btw`, `Plannotator`, `pi-goal`, and
  `pi-dynamic-workflows`.
- You want an isolated Pi profile home (`PI_CODING_AGENT_DIR`, dedicated
  sessions directory) that never touches `~/.pi`, `~/.omp`, or a host Pi
  installation.
- You want the shared `native-common` floating skill bundle (`engineersamuel`
  wildcard plus `show-me`) installed into the isolated profile.

## Avoid This Profile When

- You need host-specific Claude, Codex, Cursor, or OMP MCP configuration
  auto-loaded; managed `mcp.json` sets `hostConfigDiscovery` to `off`, and
  only the documented `pi-mcp-adapter` precedence applies.
- You need a different extension list or a newer Pi release mid-session;
  ordinary launches never update the pinned version or the ten extensions.
- You assume host Copilot, OpenAI, or Azure OpenAI credentials are available
  to the session; launches remove those variables because the managed proxy
  provider uses no API key.

## Workflow Notes

- Bare `picx` and `picx default` select the same, only profile.
- `picx inventory default --json` reports the same readiness checks as
  `picx doctor` (`healthy`, `unhealthy`, `not-setup`) without changing
  profile state; use `picx doctor` when a detailed diagnostic is needed.
- No documented explicit slash/invocation syntax exists for any of the ten
  bundled extensions in this repository's sources — treat extension names as
  descriptive vocabulary in prompts rather than commands.
- The bare Pi runtime no longer needs the former Oh My Pi source patches for
  `pi-context-view` or `pi-fff`.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `picx`/`default` as `untested`:
  static launcher, catalog, inventory, and headless contracts pass, but an
  end-to-end Herdr round trip has not yet run.
- The old `~/.omp/profiles/trellage-picx-default` profile path is not used
  or deleted by this launcher; do not confuse it with the current profile
  home.
