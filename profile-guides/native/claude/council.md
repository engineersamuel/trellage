---
schemaVersion: 2
templates:
  run-council-deliberation: >-
    /council Pressure-test this idea and its implementation: {{intent}}


    Challenge the assumptions, identify risks and failure modes, compare
    credible alternatives,

    assess feasibility and implementation tradeoffs, and recommend concrete next
    steps.
  compressed-handoff-notes: "{{intent}}"
---

# claude / council

Launch this profile with `trx run claude council`. It runs on the host and uses the local proxy at `http://127.0.0.1:8080`.

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
- The profile uses the installed Native Claude Code version.

## Gotchas

- Council deliberation trades speed for rigor — expect a longer response than a normal single-pass answer.
- The local `copilot-proxy-rs` service must be available at `http://127.0.0.1:8080`.
