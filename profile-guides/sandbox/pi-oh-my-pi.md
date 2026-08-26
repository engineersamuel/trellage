---
schemaVersion: 1
capabilities:
- high-throughput-terminal-coding
- lsp-aware-editing
- browser-tool-integration
- prompt-compaction
- minimal-ceremony-agent-loop
bestFor:
- High-throughput repo work wanting minimal ceremony and maximum tool surface
- Sessions that benefit from LSP, debugger, and browser tool access in one loop
avoidFor:
- Strict RPI process gates
- Multi-perspective deliberation — use claude-council
- Wanting a simple, lightweight CLI with few tools
prerequisites: []
workflows:
- id: rapid-repo-editing
  description: Make fast, tool-rich repo edits (LSP, debug, browser) without process ceremony.
  examples:
  - Fix the failing integration tests in this repo and show me the diff
  - Wire up a debugger session to find why this endpoint returns 500
  promptTemplate: |
    {{intent}}
- id: compacted-long-session
  description: Keep a long agent session productive via automatic prompt/output compaction when context
    grows large.
  examples:
  - Keep working through this large refactor without losing context
  promptTemplate: |
    {{intent}}
---

# pi-oh-my-pi

## Use This Profile When

- You want a batteries-included terminal agent (LSP, debugger, browser tools) with minimal process ceremony.
- You are doing high-throughput repo work and want maximum tool surface rather than strict gating.
- A session is expected to run long and needs automatic compaction to stay productive.

## Avoid This Profile When

- You need strict RPI process gates — use copilot-hve instead.
- You need multi-perspective deliberation on a hard decision — use claude-council instead.
- You want a simple, lightweight CLI with a small tool surface.

## Workflow Notes

- This profile runs Oh My Pi on GitHub Copilot models (`gpt-5.6-terra`) with `--yolo`, so it does not pause for approval prompts inside the container.
- Bundled `omp-native` skills (semantic-compression, system-prompts, tool-prompt-optimization) tune the agent's own prompt handling rather than exposing user-facing slash commands.
- Describe the task directly; there is no documented command syntax layered on top of the natural terminal-agent loop.

## Gotchas

- Because approvals are bypassed (`--yolo`), rely on the Trellage container boundary for isolation rather than in-session confirmation prompts.
- The native `omp` launcher outside Trellage Sandbox is a separate, independent install from this Docker profile.
