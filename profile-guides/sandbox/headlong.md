---
schemaVersion: 1
capabilities:
- persistent-agent-world
- autonomous-exploration
- durable-identity-and-memory
- background-thinkers
- loopback-web-dashboard
bestFor:
- Long-running exploration that benefits from persistent identity, memory, and background work
- Agent work that must continue after the attached terminal exits
avoidFor:
- Short, one-shot requests that should end with the terminal session
- Tasks that require a stateless or disposable agent environment
prerequisites:
- id: explicit-lifecycle
  description: Plan to stop or destroy the persistent Headlong service explicitly when the work is complete
workflows:
- id: start-persistent-exploration
  description: Start a durable agent world for a long-running research or implementation objective.
  examples:
  - Explore how autonomous coding agents can maintain useful project memory over several days
  promptTemplate: |
    {{intent}}
- id: continue-agent-world
  description: Continue an existing Headlong world while preserving its identity, memory, and background thinkers.
  examples:
  - Continue the existing architecture exploration and synthesize what the background thinkers found
  promptTemplate: |
    {{intent}}
- id: inspect-and-direct
  description: Inspect the loopback dashboard, then give the persistent world a focused next objective.
  examples:
  - Review the current dashboard state and focus the next cycle on unresolved deployment risks
  promptTemplate: |
    {{intent}}
---

# headlong

## Use This Profile When

- The work should persist beyond one attached terminal session.
- Identity, memory, and background thinkers are useful to the objective.
- A loopback-only dashboard helps you inspect and direct a long-running agent world.

## Avoid This Profile When

- The request is small, stateless, or must leave no durable agent state.
- You need a conventional prompt-in, answer-out coding session.

## Workflow Notes

- Headlong runs as a persistent service. Exiting the attached shell does not stop it.
- Use the loopback dashboard at `http://127.0.0.1:18080` to inspect the world.
- Use Trellage `stop`, `start`, and `destroy` commands to manage its lifecycle.

## Gotchas

- Stop or destroy the profile explicitly when the work is complete.
- The profile uses the outer Trellage container as its sandbox and does not mount the Docker socket.
- Prompt, resume, model selection, and headless flags are not conventional one-shot harness controls for this service.
