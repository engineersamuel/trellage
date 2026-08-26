---
schemaVersion: 1
capabilities:
- research-plan-implement-review-workflow
- github-native-pr-delivery
- durable-sdlc-gates
- security-and-a11y-review-loops
bestFor:
- 'GitHub-native, process-heavy delivery: features, PRs, issues'
- Security, accessibility, or work-item loops needing durable SDLC gates
avoidFor:
- One-line edits
- Offline or private-only work
- Experimental non-Copilot runtimes
prerequisites: []
workflows:
- id: rpi-agent-cycle
  description: Run the RPI Agent (Research, Plan, Implement, Review) for a GitHub-native feature or fix.
  skill: rpi
  examples:
  - /rpi add rate limiting to the public API and open a PR
  - 'Research, plan, implement, and review a fix for issue #482'
  promptTemplate: |
    /rpi {{intent}}
- id: adapt-hve-patterns
  description: Use the HVE Builder skill to adapt or copy HVE Core patterns into an independently maintained
    agentic SDLC.
  skill: hve-builder
  examples:
  - Help me fork the RPI pattern into our own agent instructions
  promptTemplate: |
    /hve-builder {{intent}}
---

# copilot-hve

## Use This Profile When

- You want a default, GitHub-native engineering harness with durable SDLC gates for features, PRs, and issues.
- You want the Research → Plan → Implement → Review cycle run explicitly via `/rpi` rather than ad hoc.
- You want to adapt or fork HVE Core's patterns into your own agent instructions via `/hve-builder`.

## Avoid This Profile When

- The task is a one-line edit that doesn't need a full SDLC cycle.
- You need offline or private-only work — this profile is GitHub-native.
- You want an experimental non-Copilot runtime — use a Claude, Codex, or other harness profile instead.

## Workflow Notes

- HVE Core is explicitly called out upstream as opinionated and rapidly evolving — treat it as a source of patterns rather than a stable, unchanging platform.
- `/rpi` selects the RPI Agent for the Research-Plan-Implement-Review cycle; `/hve-builder` helps fork or adapt those patterns into an independently owned agentic SDLC.
- This profile installs the `microsoft/hve-core` plugin via the Copilot marketplace adapter, pinned to a specific commit.

## Gotchas

- Because HVE Core is described upstream as not backward-compatible across versions, do not assume the same workflow surface persists across profile rebuilds without checking `docs/verification.md` evidence.
- This profile uses native or logged-in GitHub Copilot auth (`host-or-login`), not the `copilot-proxy-rs` gateway used by Claude/Codex profiles.
