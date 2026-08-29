---
schemaVersion: 1
capabilities:
- multi-node-coding-orchestration
- git-worktree-isolation
- specialist-agent-roles
- research-fan-out-with-code-gate
- persistent-task-memory
- tdd-workflow
- stop-hook-review-gate
bestFor:
- Reversible multi-node coding that needs isolated worktrees, persistent memory, and the ability to take
  'done' back
- Long-running feature work that needs research fan-out proven by a code spike before a review gate
avoidFor:
- One-shot Q&A
- Content-only profiles (blogs, social posts) — use claude-blog or claude-social-media instead
- Small, single-file edits that don't need worktree isolation or memory
- Conventional structured feature delivery that does not need a graph, isolated worktrees, or retryable
  nodes
prerequisites: []
workflows:
- id: start-isolated-feature-branch
  description: Start a new coding task in an isolated git worktree, staffed with a curated specialist
    agent role from wshobson/agents, backed by beads memory.
  examples:
  - Start a new worktree to implement the rate-limiter service and staff the full-stack-orchestration
    role
  - Build the billing migration as retryable implementation nodes, keeping each risky change in an isolated
    worktree
  promptTemplate: |
    {{intent}}
- id: fan-out-research-with-gate
  description: Run the insane-research fan-out across candidate approaches, gated by a working code spike
    before committing to one.
  examples:
  - Research three approaches to our webhook retry problem and gate them against a working code spike
  - Compare queue designs for this ingest service, then prove the preferred option with a small working
    implementation
  promptTemplate: |
    {{intent}}
- id: resume-with-review-gate
  description: Resume a paused task from persistent memory and pass it through the Stop-hook review gate
    before marking it done.
  examples:
  - Resume the auth-refactor task and run it through the review gate before closing it out
  - Continue the paused authorization migration, retry the failed node, and challenge the completed work
    before marking it done
  promptTemplate: |
    {{intent}}
---

# claude-graph-of-loops

## Use This Profile When

- The task spans multiple coding nodes/steps and needs the ability to resume, retry, or roll a step back rather than commit to a single linear pass.
- You want curated specialist agent roles (orchestration, TDD, comprehensive review, conductor) staffed instead of a single generalist agent.
- You need a research fan-out that is gated by working code, not just competing write-ups.
- You specifically need the Sandbox graph, isolated worktrees, and retryable nodes; a conventional structured
  engineering workflow is less suitable when those controls are unnecessary.

## Avoid This Profile When

- The request is a one-shot question or a single small edit — the worktree/memory/gate machinery is unnecessary overhead.
- The deliverable is content, not code — use claude-blog or claude-social-media instead.

## Workflow Notes

- This profile wires together: bernstein DAG orchestration, `wt` git-worktree isolation, curated `wshobson/agents` specialist roles, `insane-research` fan-out with a code gate, `beads` memory (`bd`/`bv`), the `waku` loop, `serena` symbol retrieval (via MCP), Superpowers TDD, and a Stop-hook review gate (`hamelsmu/claude-review-loop`).
- No documented slash-command surface is published for this bundle locally — describe the coding task and let the graph-of-loops orchestration route it through worktrees, roles, and gates.
- The Stop-hook review gate fails open if Codex is absent in the container, so review-loop behavior may degrade silently if that tool is missing.

## Gotchas

- Staffing is deliberately curated (full-stack-orchestration, agent-orchestration, agent-teams, comprehensive-review, tdd-workflows, conductor) rather than all 93 upstream `wshobson/agents` roles, to avoid burning the context window.
- Runtime allocates a 2g tmpfs; very large intermediate artifacts across multiple worktrees can still exhaust it.
- This is an Opus-routed proxy profile and needs the external `copilot-proxy-rs_default` Docker network.
