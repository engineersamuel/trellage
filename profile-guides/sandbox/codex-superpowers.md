---
schemaVersion: 1
capabilities:
- tdd-implementation-loop
- multi-day-feature-delivery
- full-stack-orchestration-agents
- structured-debugging
- code-review-workflow
bestFor:
- Multi-day implementation marathons needing disciplined brainstorm-plan-TDD-debug-review execution
- Coordinating parallel full-stack-orchestration agent roles for larger implementation work
avoidFor:
- Pure research tasks
- Content marketing work
- One-shot Q&A without process
prerequisites: []
workflows:
- id: brainstorm-to-plan
  description: Turn a rough feature idea into a reviewed brainstorm and implementation plan before any
    code is written.
  examples:
  - Brainstorm and plan the implementation of a rate-limiting middleware for our API
  promptTemplate: |
    {{intent}}
- id: tdd-implementation
  description: Implement a planned task test-first, iterating red-green through the Superpowers TDD loop.
  examples:
  - Implement the rate-limiting middleware from the plan using TDD
  promptTemplate: |
    {{intent}}
- id: systematic-debug
  description: Diagnose and fix a failing behavior with a systematic-debugging pass before patching it.
  examples:
  - Debug why the rate limiter is dropping legitimate requests under load
  promptTemplate: |
    {{intent}}
---

# codex-superpowers

## Use This Profile When

- You are starting multi-day implementation work and want brainstorm, spec, plan, TDD, debug, and review handled as a disciplined process rather than ad hoc.
- You want full-stack-orchestration agent roles staffed for larger implementation tasks.
- You are debugging a non-obvious failure and want a systematic root-cause pass rather than a quick patch.

## Avoid This Profile When

- The task is pure research or content marketing with no implementation component.
- You want a fast one-shot answer without process overhead.

## Workflow Notes

- Superpowers skills (brainstorming, writing-plans, test-driven-development, systematic-debugging, requesting/receiving-code-review, and related) trigger automatically from natural-language intent — there is no documented slash-command syntax for them.
- The bundled `full-stack-orchestration` role from `wshobson/agents` is available for larger tasks needing coordinated agent roles.
- This profile runs Codex (`gpt-5.6-sol`) with `--dangerously-bypass-approvals-and-sandbox`, so it does not pause for approval prompts inside the container.

## Gotchas

- Because approvals and the sandbox are bypassed, this profile relies entirely on the Trellage container boundary for isolation — do not assume the same guardrails as an approval-gated Codex session.
- Superpowers is process-heavy by design; expect longer turnaround than a no-process profile even for small tasks.
