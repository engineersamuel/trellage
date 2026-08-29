---
schemaVersion: 1
capabilities:
- persistent-agent-world
- autonomous-exploration
- durable-identity-and-memory
- background-thinkers
- shell-based-agency
- append-only-trajectory
- loopback-web-dashboard
bestFor:
- Long-running work that benefits from continuous background thinking, durable identity, memory, and trajectory
- Exploration, research, or implementation that should continue after the attached terminal exits
avoidFor:
- Short, one-shot requests that should end with the terminal session
- Tasks that require a stateless or disposable agent environment
prerequisites:
- id: explicit-lifecycle
  description: Plan to stop or destroy the persistent Headlong service explicitly when the work is complete
- id: interactive-entry
  description: After Trellage opens the Headlong shell, type ada to enter the interactive TUI
workflows:
- id: persistent-investigation
  description: Turn a concise investigation request into persistent work with background progress, durable evidence, root-cause analysis, tested fixes, and dashboard visibility.
  examples:
  - Investigate intermittent test failures
  - Diagnose a difficult reliability problem over several days
  - Track down a nondeterministic production issue while I am away
  promptTemplate: |
    {{intent}}

    Keep working between my interactions. Maintain a durable record of hypotheses and evidence, identify root causes, test potential fixes, and make progress visible in the local dashboard so I can monitor and redirect the investigation.
- id: start-persistent-exploration
  description: Start a persistent agent and give it a long-running research or implementation objective.
  examples:
  - Explore this codebase over several days and maintain a durable map of its architecture and unresolved risks
  - Keep investigating this recurring deployment failure after I leave the terminal, and preserve each
    hypothesis and result
  promptTemplate: |
    {{intent}}
- id: continue-agent-world
  description: Continue an existing Headlong identity with its memories, trajectory, and background thinkers intact.
  examples:
  - Continue the architecture investigation and connect new findings to the existing trajectory
  - Resume the reliability investigation and let the existing agent identity test the next lead
  promptTemplate: |
    {{intent}}
- id: inspect-and-direct
  description: Follow the agent's thought stream in the loopback dashboard, then direct it from the TUI.
  examples:
  - Review the dashboard, then ask Ada to focus its next cycles on unresolved deployment risks
  - Inspect the current trajectory and redirect the autonomous investigation toward the remaining memory leak
  promptTemplate: |
    {{intent}}
---

# headlong

Headlong is a persistent agent microharness. Instead of waiting for one
prompt at a time, its agent keeps thinking in a self-guided loop. Messages
enter the same ongoing thought stream, and the agent decides how and when to
respond. Its identity, memories, and append-only trajectory persist across
attachments.

The agent reasons and acts through shell commands. Headlong records those
steps in a trajectory DAG and uses tiered context compaction so older work
remains available at progressively summarized levels.

## Use This Profile When

- The work should continue beyond one attached terminal session.
- Continuous background thinking is useful between your interactions.
- The objective benefits from durable identity, memory, and a reviewable trajectory.
- You want to watch the agent's thought stream and activity in a local dashboard.

## Avoid This Profile When

- The request is small, stateless, or must leave no durable agent state.
- You need a conventional prompt-in, answer-out coding session.
- You do not want a persistent process that can continue making model calls.

## Workflow Notes

For a concise but substantial request such as `Investigate intermittent test
failures`, `trx guide` can offer Headlong as a persistence-oriented
alternative. Its generated prompt should add continued background work,
durable hypotheses and evidence, root-cause analysis, tested fixes, and
dashboard visibility.

1. Launch the `headlong` profile with Trellage.
2. When the attached Headlong shell opens, type `ada` to enter the interactive TUI.
3. Follow the agent's thought stream at <http://127.0.0.1:18080>.
4. Use the TUI to provide objectives, answer the agent, and redirect its focus.

Useful commands inside the attached shell:

```bash
ada                  # Enter the interactive TUI
ada hello            # Send one message and wait for the reply
ada status           # Show mind and dashboard status
ada stop             # Pause background thinking
ada start            # Resume background thinking
ada dash             # Print the dashboard URL
```

Headlong runs as a persistent service. Exiting the attached shell does not
stop its mind. Use Trellage `stop`, `start`, and `destroy` commands to manage
the profile container lifecycle.

## Gotchas

- Stop or destroy the profile explicitly when the work is complete.
- Headlong can make model calls continuously. Monitor usage and pause it when background thinking is not needed.
- The profile uses the outer Trellage container as its sandbox and does not mount the Docker socket.
- Prompt, resume, model selection, and headless flags are not conventional one-shot harness controls for this service.
