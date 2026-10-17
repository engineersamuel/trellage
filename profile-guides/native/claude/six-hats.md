---
schemaVersion: 1
goalExecution:
  controller: claude-goal
  workflowIds:
    - run-six-hats-deliberation
capabilities:
  - six-hats-deliberation
  - parallel-perspective-analysis
  - green-hat-scratch-prototyping
bestFor:
  - Decisions that need facts, intuition, benefits, risks, alternatives, and a final plan kept distinct
  - Technical choices where a disposable prototype can test the green hat's ideas
avoidFor:
  - Factual lookups or small, reversible edits
  - Tasks that should change the launching checkout during deliberation
prerequisites:
  - id: proxy
    description: Host Claude Code, curl, jq, and the local copilot-proxy-rs endpoint must be available.
workflows:
  - id: run-six-hats-deliberation
    description: Run all six thinking hats and finish with the blue hat's decision plan without changing the checkout.
    skill: six-hats:decide
    examples:
      - Decide whether to replace this queue with a transactional outbox
      - Choose an API migration strategy for these clients
    promptTemplate: |
      /six-hats:decide Decide: {{intent}}

      Run every hat, show me the blue hat's plan, and stop before changing this checkout.
---

# claude / six-hats

Launch this profile with `trx run claude six-hats`. It runs on the host and uses the local proxy at `http://127.0.0.1:8080`.
`trx` loads this repository's `plugins/six-hats` plugin for that session only, from the shipped
`preset-claude-six-hats` profile in `config.toml`.

The white hat gathers the facts first. The red, yellow, black, and green hats
then work in parallel on intuition, benefits, risks, and alternatives. The blue
hat combines their findings into the final plan.

The green hat may test an idea in a git-ignored `.six-hats/green-*` scratch copy.
It does not change the checkout that launched the session. The round ends when
the blue hat reports its plan and prints `Six Hats round complete`.
