---
schemaVersion: 1
capabilities:
  - daily-coding-extension-workflows
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
    description: copilot-proxy-rs listening on http://127.0.0.1:8080/v1 and advertising gpt-5.6-sol; trx doctor pi checks both conditions.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and update checks.
workflows:
  - id: daily-coding-with-extension-support
    description: Complete a daily coding task with Pi's fixed extension set providing context, fast file work, and workflow support.
    examples:
      - Investigate this bug, update the smallest correct code path, and verify the result
      - Use the available context and file tools to implement this focused repository change
    promptTemplate: |
      Use Pi's available daily-coding extensions to complete and verify
      {{intent}}.
  - id: goal-and-plan-tracking
    description: Use the pi-goal and Plannotator extensions to track a multi-step objective and annotate the plan as work proceeds.
    examples:
      - Set a goal for this refactor and annotate the plan as each step completes
      - Track this migration goal, keep the plan current, and verify each completed stage
    promptTemplate: |
      Use Pi's goal tracking and plan annotation support to complete
      {{intent}}.
  - id: subagent-and-workflow-fanout
    description: Use pi-subagents and pi-dynamic-workflows to split a larger task across coordinated subagents with a dynamic workflow.
    examples:
      - Split this migration into subagent tasks driven by a dynamic workflow
      - Coordinate subagents on this cross-cutting refactor and integrate the verified result
    promptTemplate: |
      Use Pi's subagent and dynamic workflow support to deliver {{intent}}.
---

# Native Pi (`pi`) — `default` profile

`trx run pi default` composes upstream Pi with
keyless `copilot-proxy-rs/gpt-5.6-sol:medium` and one fixed, ordered extension
set. Install and update the `pi` harness binary outside Trellage.

## Use This Profile When

- You want Pi's daily-coding extension set in a fixed order: `Ponytail`,
  `pi-web-access`, `pi-subagents`, `pi-fff`, `pi-context-view`,
  `pi-mcp-adapter`, `pi-btw`, `Plannotator`, `pi-goal`, and
  `pi-dynamic-workflows`.
- You want an isolated Pi profile home (`PI_CODING_AGENT_DIR`, dedicated
  sessions directory) that never touches `~/.pi`, `~/.omp`, or a host Pi
  installation.
- You want the shared `native-common` floating skill bundle (`engineersamuel`
  wildcard, `show-me`, and manually activated `i-have-adhd`) installed into
  the isolated profile.

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
