---
schemaVersion: 1
capabilities:
- long-horizon-agent-research
- self-improving-runtime-loop
- detachable-resumable-sessions
- subagent-delegation
bestFor:
- Experimental long-horizon agent research and novel automation
- Work needing detach/resume across a persistent iPython control loop
avoidFor:
- Everyday feature work
- GitHub PR factories
- Anything needing a stable, low-surprise harness
prerequisites: []
workflows:
- id: long-horizon-research-loop
  description: Run an open-ended, self-improving research loop that can detach and resume across sessions.
  examples:
  - Explore and iterate on a self-improving prompt-compression strategy over several sessions
  - Resume the long-horizon automation session from yesterday and continue
  promptTemplate: |
    {{intent}}
- id: delegate-to-subagents
  description: Spin up subagents from the persistent control loop to parallelize exploratory automation.
  examples:
  - Delegate three subagents to try different approaches to this optimization problem
  promptTemplate: |
    {{intent}}
---

# prime-agent

## Use This Profile When

- You are doing experimental, long-horizon agent research or novel automation rather than conservative production delivery.
- You need a session that can detach and resume later without losing its persistent iPython control-loop state.
- You want to delegate exploratory work to subagents from within a single long-running loop.

## Avoid This Profile When

- The task is everyday feature work or a GitHub PR factory — use codex-superpowers or copilot-hve instead.
- You need a stable, low-surprise harness rather than a self-improving, experimental one.

## Workflow Notes

- Prime Agent runs Opus via `copilot-proxy-rs` with the Anthropic Messages API and a persistent iPython control loop rather than a conventional single-turn agent loop.
- No documented slash-command surface is published locally for this harness — describe the research or automation task directly.
- Detach/resume is a first-class feature of this profile; long-horizon work is expected to span multiple sessions.

## Gotchas

- Because this is an experimental, self-improving runtime, behavior can drift between sessions in ways a stable harness would not — review its own decisions before trusting them for production work.
- This is an Opus-routed proxy profile and needs the external `copilot-proxy-rs_default` Docker network.
