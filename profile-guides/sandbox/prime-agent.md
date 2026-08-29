---
schemaVersion: 1
capabilities:
- persistent-ipython-research-loop
- user-directed-long-horizon-automation
- detachable-resumable-control-state
- persistent-subagent-experiments
bestFor:
- Experimental long-horizon research and automation where the user directs a persistent IPython control loop
- Detachable work that must resume with its control state and subagent experiments intact
avoidFor:
- Everyday feature work
- GitHub PR factories
- Anything needing a stable, low-surprise harness
- Autonomous background investigation while unattended — use Headlong's continuous mind instead
- Host-native Prime work that requires the native prx runtime rather than a reproducible Sandbox
prerequisites: []
workflows:
- id: long-horizon-research-loop
  description: Run an open-ended, self-improving research loop that can detach and resume across sessions.
  examples:
  - Explore and iterate on a self-improving prompt-compression strategy over several sessions
  - Resume the long-horizon automation session from yesterday and continue
  - Keep a user-directed IPython research loop for this agent evaluation, then detach and resume it tomorrow
  promptTemplate: |
    {{intent}}
- id: delegate-to-subagents
  description: Spin up subagents from the persistent control loop to parallelize exploratory automation.
  examples:
  - Delegate three subagents to try different approaches to this optimization problem
  - Use subagents to compare three automation designs, then bring their results back to this control loop
  promptTemplate: |
    {{intent}}
---

# prime-agent

## Use This Profile When

- You are doing experimental, long-horizon agent research or novel automation rather than conservative production delivery.
- You need a session that can detach and resume later without losing its persistent iPython control-loop state.
- You want to delegate exploratory work to subagents from within a single long-running loop.
- You want to direct the control loop yourself. For continuous autonomous work between interactions, use
  Headlong; for host-native Prime, use the native `prx` runtime.

## Avoid This Profile When

- The task is everyday feature work or a GitHub PR factory — use codex-superpowers or copilot-hve instead.
- You need a stable, low-surprise harness rather than a self-improving, experimental one.

## Workflow Notes

- Prime Agent runs Opus via `copilot-proxy-rs` with the Anthropic Messages API and a persistent iPython control loop rather than a conventional single-turn agent loop.
- No documented slash-command surface is published locally for this harness — describe the research or automation task directly.
- Detach/resume is a first-class feature of this profile; long-horizon work is expected to span multiple sessions.
- Headlong persists an autonomous background mind and dashboard; Prime persists a user-directed IPython
  control loop. This Sandbox is separate from the host-native `prx` runtime.

## Gotchas

- Because this is an experimental, self-improving runtime, behavior can drift between sessions in ways a stable harness would not — review its own decisions before trusting them for production work.
- This is an Opus-routed proxy profile and needs the external `copilot-proxy-rs_default` Docker network.
