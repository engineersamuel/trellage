---
schemaVersion: 1
capabilities:
- research-plan-implement-review-workflow
- github-native-pr-delivery
- durable-sdlc-gates
- security-and-a11y-review-loops
- sandboxed-hve-delivery
- customer-engagement-lifecycle-routing
bestFor:
- GitHub-native, process-heavy Sandbox delivery of features, PRs, and issues through RPI artifacts
- Security, accessibility, or work-item loops needing durable SDLC gates in a reproducible container
- Customer engagement work spanning Design Thinking discovery, meeting analysis, BRD or PRD authoring, and specialist review before a formal RPI handoff
avoidFor:
- One-line edits
- Offline or private-only work
- Experimental non-Copilot runtimes
- Host-native HVE sessions or local-state continuity — use the separate native:cpx/hve profile
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
  - Adapt the HVE review and evidence gates for our internal release workflow
  promptTemplate: |
    /hve-builder {{intent}}
- id: customer-engagement-lifecycle
  description: Route a customer engagement across Design Thinking discovery and concept validation, meeting
    analysis, BRD or PRD authoring, and specialist review (UX/UI, ADR, privacy, RAI, security, and supply chain),
    then functional planning and backlog management once requirements are mature, with a formal handoff into
    rpi-research.
  launchAgent: hve-core:dt-coach
  examples:
  - We're starting discovery with a customer on a new capability and need to validate the problem before committing
    to a design
  - Turn this customer meeting into structured requirements without skipping design validation
  - Our design thinking work is validated; carry it through requirements, specialist review, and into RPI research
  promptTemplate: |
    Treat this as a connected customer-engagement lifecycle, not a single
    agent request. When the problem is not yet well understood, start with
    the DT Coach agent (for example via `/dt-start-project`) for
    stakeholder-centered Design Thinking discovery, framing, and concept
    validation, preserving its ability to return non-linearly to earlier
    methods. When attributed requirements already exist in customer
    material, use the Meeting Analyst agent first, respecting its
    sensitive-data handling. Convert validated needs into a BRD or PRD with
    the BRD Builder or PRD Builder agent, matched to problem and solution
    maturity, and route to the UX UI Designer, ADR Creator, Privacy
    Planner, RAI Planner, Security Planner, or SSSC Planner agent whenever
    their concerns arise. Use the Functional Planner and Backlog Manager
    agents only once requirements are sufficiently mature. Preserve every
    source artifact, constraint, assumption, and
    validated/assumed/unknown/conflicting confidence marker across each
    handoff, and continue mature Design Thinking or requirements work
    through the formal DT-to-RPI handoff into rpi-research; never skip a
    lifecycle phase or bypass evidence gathering: {{intent}}
---

# copilot-hve

## Use This Profile When

- You want a default, GitHub-native engineering harness with durable SDLC gates for features, PRs, and issues.
- You want the Research → Plan → Implement → Review cycle run explicitly via `/rpi` rather than ad hoc.
- You want to adapt or fork HVE Core's patterns into your own agent instructions via `/hve-builder`.
- You need the isolated, reproducible Sandbox profile. Use `native:cpx/hve` when the separately managed
  host-native HVE profile is the required destination.
- You are engaging a customer or stakeholder before implementation is scoped — Design Thinking discovery,
  meeting-transcript analysis, BRD/PRD authoring, or specialist routing (UX/UI, ADR, privacy, RAI, security,
  supply chain) — and want that work to hand off into RPI once requirements are mature, rather than jumping
  straight to `/rpi`.

## Avoid This Profile When

- The task is a one-line edit that doesn't need a full SDLC cycle.
- You need offline or private-only work — this profile is GitHub-native.
- You want an experimental non-Copilot runtime — use a Claude, Codex, or other harness profile instead.

## Workflow Notes

- The default model is `gpt-6-astra` with `max` reasoning.
- HVE Core is explicitly called out upstream as opinionated and rapidly evolving — treat it as a source of patterns rather than a stable, unchanging platform.
- `/rpi` selects the RPI Agent for the Research-Plan-Implement-Review cycle; `/hve-builder` helps fork or adapt those patterns into an independently owned agentic SDLC.
- The `customer-engagement-lifecycle` workflow names the same installed `hve-core` agents (`DT Coach`,
  `Meeting Analyst`, `BRD Builder`, `PRD Builder`, `UX UI Designer`, `ADR Creator`, `Privacy Planner`,
  `RAI Planner`, `Security Planner`, `SSSC Planner`, `Functional Planner`, `Backlog Manager`) by their verified
  `.agent.md` frontmatter `name` values rather than pinning a new profile per agent; it treats these agents as
  one connected discovery-to-delivery lifecycle and defers to Design Thinking's own non-linear method-return
  protocol and its tiered `rpi-research` handoff contract instead of forcing every engagement through every step.
  Its `launchAgent: hve-core:dt-coach` setting makes guide command previews, terminal launches, and Herdr jobs
  include `--agent hve-core:dt-coach`. This selects the installed DT Coach at startup rather than merely
  naming it in a prompt. The existing `/rpi` and `/hve-builder` workflows do not inherit this selection.
- This profile installs the `microsoft/hve-core` plugin via the Copilot marketplace adapter, pinned to a specific commit.
- This Sandbox profile and `native:cpx/hve` are separate profiles. They can share the HVE concept without
  sharing a session, runtime state, or lifecycle.

## Gotchas

- Because HVE Core is described upstream as not backward-compatible across versions, do not assume the same workflow surface persists across profile rebuilds without checking `docs/verification.md` evidence.
- This profile uses native or logged-in GitHub Copilot auth (`host-or-login`), not the `copilot-proxy-rs` gateway used by Claude/Codex profiles.
