---
schemaVersion: 1
capabilities:
- bounded-factual-research
- source-backed-comparisons
- recency-scored-social-pulls
- persistent-research-vault
bestFor:
- Source-backed answers to bounded factual queries, surveys, and comparisons
- Checking what people are currently saying across Reddit, X, YouTube, HN, Polymarket, GitHub, and the
  web in the last ~30 days
avoidFor:
- Full adversarial/deep-research pipelines that need maximum rigor over cost
- App coding or feature implementation
- Short social copy drafting — use claude-social-media
prerequisites: []
workflows:
- id: vault-backed-research
  description: Run the focused 5-step hyperresearch pipeline for a bounded factual query, survey, or comparison,
    saved to the persistent research vault.
  skill: hyperresearch
  examples:
  - /hyperresearch compare Postgres and CockroachDB for a multi-region OLTP workload
  promptTemplate: |
    /hyperresearch Research the evidence that should inform this request before implementation: {{intent}}

    Find relevant prior art and source-backed evidence, identify unresolved questions and risks,
    compare implementation options, and explain how the findings should change the approach.
- id: last-30-days-pulse
  description: Pull recency-scored takes on a topic from the last ~30 days across social and community
    sources.
  skill: last30days
  examples:
  - /last30days nvidia earnings reaction
  - /last30days OpenClaw vs Hermes
  promptTemplate: |
    /last30days {{intent}}
- id: diagnose-sources
  description: Diagnose missing sources or authentication for the last30days pipeline.
  skill: last30days
  examples:
  - /last30days doctor
  promptTemplate: |
    /last30days doctor
    {{intent}}
---

# claude-research

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

- This profile allocates a 2g tmpfs and installs a large set of headless-browser shared libraries (needed for `last30days` source scraping) — expect a heavier image than a plain coding profile.
- This is an Opus-routed proxy profile and needs the external `copilot-proxy-rs_default` Docker network.
