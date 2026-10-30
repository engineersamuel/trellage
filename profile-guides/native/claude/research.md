---
schemaVersion: 2
templates:
  vault-backed-research: >-
    /hyperresearch:deep-research Research the evidence that should inform this request before
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

- Two independent entry points: `/hyperresearch:deep-research <prompt>` for vault-backed research; `/last30days <topic>` for recency-scored social pulls.
- `/last30days doctor` diagnoses missing sources or authentication issues in the last30days pipeline before you rely on its results.
- The Hyperresearch plugin supplies the `deep-research` bootstrap skill, not the pipeline itself. Launch checks for its Python CLI and automatically runs `uv tool install --python '>=3.11,<3.14' hyperresearch` when missing, including non-interactive Guide handoffs. Dry runs do not install anything.
- On first use, the bootstrap runs `hyperresearch install . --json` in the current project. This creates `.hyperresearch/` and `research/`, installs skills, subagents, and a hook under `.claude/`, and adds a block to `CLAUDE.md`.
- The pipeline selects `light` or `full` per query. Bounded queries use the five-step light path; this profile does not install or force a separate light variant.

## Gotchas

- Automatic CLI setup needs `uv` on PATH and network access. It uses Python 3.11–3.13; Python 3.14 is excluded because Hyperresearch warns that its crawler does not support it. A failed install, or a CLI still missing from PATH after installation, stops launch with an error.
- Existing CLI installs are reused. To replace an earlier Python 3.14 install, stop active research first, then run `uv tool install --reinstall --python '>=3.11,<3.14' hyperresearch`.
- Claude may need a restart after first-use setup to discover the new skills and subagents. After restarting in the same project, `/hyperresearch <prompt>` invokes the installed pipeline directly.
- Research fetches need network access and may need browser dependencies.
- The local `copilot-proxy-rs` service must be available at `http://127.0.0.1:8080`.
