---
schemaVersion: 2
templates:
  vault-backed-research: >-
    /hyperresearch Research the evidence that should inform this request before
    implementation: {{intent}}


    Find relevant prior art and source-backed evidence, identify unresolved
    questions and risks,

    compare implementation options, and explain how the findings should change
    the approach.
  last-30-days-pulse: /last30days {{intent}}
---

# claude / research

Launch this profile with `trx run claude research`. It runs on the host and uses the local proxy at `http://127.0.0.1:8080`.

## Use This Profile When

- You need a bounded, source-backed factual answer, survey, or comparison without the cost of a full adversarial deep-research pipeline.
- You want to know what people are actually saying about a topic in the last ~30 days across Reddit, X, YouTube, HN, Polymarket, GitHub, and the web.
- You want research results saved to a persistent vault for later reuse rather than a one-off chat answer.

## Avoid This Profile When

- You need the most rigorous, adversarial multi-pass research pipeline available — this is the lighter-weight option by design.
- The task is coding or content drafting rather than research — use a coding or social/blog profile instead.

## Workflow Notes

- Two independent entry points: `/hyperresearch <prompt>` for vault-backed factual research, surveys, and comparisons; `/last30days <topic>` for recency-scored social pulls.
- `/last30days doctor` diagnoses missing sources or authentication issues in the last30days pipeline before you rely on its results.
- The Hyperresearch plugin is installed in its `light` variant — a focused 5-step pipeline, not the full adversarial pipeline.

## Gotchas

- This profile needs its managed Python and native browser dependencies for the full research workflow.
- The local `copilot-proxy-rs` service must be available at `http://127.0.0.1:8080`.
