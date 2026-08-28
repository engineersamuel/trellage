---
schemaVersion: 1
capabilities:
- multi-perspective-deliberation
- architecture-tradeoff-analysis
- dissent-preservation
- compressed-communication
bestFor:
- Hard architecture or product tradeoffs where a single-shot answer is likely to miss real risks
- High-stakes design calls that benefit from structured, multi-lens deliberation with preserved dissent
  and kill criteria
avoidFor:
- Factual lookups or simple research questions
- Small, reversible edits
- Pure implementation throughput where deliberation only adds latency
prerequisites: []
workflows:
- id: run-council-deliberation
  description: Run a structured multi-lens council deliberation on a hard decision, preserving dissenting
    views, kill criteria, and next steps.
  skill: council
  examples:
  - Should we adopt event sourcing for the billing service?
  - /council pick a database migration strategy for our multi-tenant SaaS
  promptTemplate: |
    /council Pressure-test this idea and its implementation: {{intent}}

    Challenge the assumptions, identify risks and failure modes, compare credible alternatives,
    assess feasibility and implementation tradeoffs, and recommend concrete next steps.
- id: compressed-handoff-notes
  description: Use caveman compressed-communication mode to turn a council verdict into terse status or
    handoff notes.
  examples:
  - Summarize the council's verdict in compressed notes for the team channel
  promptTemplate: |
    {{intent}}
---

# claude-council

## Use This Profile When

- You face a hard architecture, product, or design tradeoff and want more than one perspective before committing.
- You need the disagreement itself recorded — dissenting views and kill criteria, not just a single recommended answer.
- You want a terse, compressed summary of a deliberation for a status update or handoff.

## Avoid This Profile When

- You just need a fact looked up or a small, obviously-reversible edit made.
- You are optimizing for raw implementation speed rather than decision quality.

## Workflow Notes

- Invoke deliberation with `/council <prompt>`; this comes from the `0xNyk/council-of-high-intelligence` plugin bundled by default.
- The `JuliusBrussee/caveman` plugin is also bundled by default and provides a compressed communication mode usable alongside or after a council run.
- This profile pins an exact Claude Code release recorded in the repo's live-validation evidence; do not expect `latest` semantics.

## Gotchas

- Council deliberation trades speed for rigor — expect a longer response than a normal single-pass answer.
- Like other proxy-backed Claude profiles, this requires the external `copilot-proxy-rs_default` Docker network.
