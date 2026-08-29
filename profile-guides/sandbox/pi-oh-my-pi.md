---
schemaVersion: 1
capabilities:
- high-throughput-terminal-coding
- rapid-repository-repair
- end-to-end-issue-resolution
- long-refactor-continuity
- minimal-ceremony-agent-loop
bestFor:
- High-throughput repository work that must move from diagnosis through a validated patch with little process
  overhead
- Large refactors or difficult regressions that benefit from one continuous, compacted execution loop
avoidFor:
- Strict RPI process gates
- Multi-perspective deliberation — use claude-council
- Wanting a simple, lightweight CLI with few tools
prerequisites: []
workflows:
- id: rapid-repo-editing
  description: Turn a diagnosed repository failure into a repaired, verified patch without process ceremony.
  examples:
  - Trace this failing integration test, fix the root cause, and validate the complete patch
  - Investigate why this endpoint returns 500, make the repair, and show the tested diff
  promptTemplate: |
    {{intent}}
- id: compacted-long-session
  description: Keep a long agent session productive via automatic prompt/output compaction when context
    grows large.
  examples:
  - Complete this cross-package refactor in one sustained session without losing the decisions already made
  - Keep reducing this large test-failure backlog while preserving context from each completed fix
  promptTemplate: |
    {{intent}}
---

# pi-oh-my-pi

## Use This Profile When

- You want a fast, low-ceremony path from a repository problem to a tested patch.
- You are doing high-throughput repo work where rapid diagnosis, repair, and validation matter more than
  strict process gates.
- A large refactor or issue backlog needs one continuous session that can retain its working context.

## Avoid This Profile When

- You need strict RPI process gates — use copilot-hve instead.
- You need multi-perspective deliberation on a hard decision — use claude-council instead.
- You want a simple, lightweight CLI with a small tool surface.

## Workflow Notes

- This profile runs Oh My Pi on GitHub Copilot models (`gpt-5.6-terra`) with `--yolo`, so it does not pause for approval prompts inside the container.
- Bundled `omp-native` skills tune prompt handling and context compaction rather than exposing user-facing
  slash commands.
- Describe the task directly; there is no documented command syntax layered on top of the natural terminal-agent loop.

## Gotchas

- Because approvals are bypassed (`--yolo`), rely on the Trellage container boundary for isolation rather than in-session confirmation prompts.
- The native `omp` launcher outside Trellage Sandbox is a separate, independent install from this Docker profile.
