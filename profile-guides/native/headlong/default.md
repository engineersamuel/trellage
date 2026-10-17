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
  - Long investigations that should keep making progress between your terminal sessions
  - Implementation and reliability work that benefits from persistent background progress
  - Work that benefits from durable identity, memory, evidence, and dashboard visibility
avoidFor:
  - Short tasks that should end with the terminal session
  - Work that needs a sandbox or must not use persistent model calls
prerequisites:
  - id: install-headlong
    description: Install Headlong on the host and ensure ada and headlong-init are available on PATH.
  - id: local-proxy
    description: Run copilot-proxy-rs on the host at 127.0.0.1:8080.
  - id: explicit-shutdown
    description: Use ada stop when the background mind should stop making model calls.
workflows:
  - id: persistent-investigation
    description: Investigate a difficult problem with durable evidence and continued work between interactions.
    examples:
      - Investigate intermittent test failures and keep testing likely causes after I leave the terminal
      - Diagnose a recurring production outage and track evidence across several days
    promptTemplate: |
      {{intent}}

      Keep working between my interactions. Maintain a durable record of hypotheses and evidence, identify root causes, test potential fixes, and make progress visible in the local dashboard so I can monitor and redirect the investigation.
  - id: continue-agent-world
    description: Continue an existing Headlong identity without losing its memories or trajectory.
    examples:
      - Continue the architecture investigation and test the next unresolved lead
      - Resume the deployment reliability investigation and add new evidence to its trajectory
    promptTemplate: |
      {{intent}}
---

# Headlong Native

Headlong keeps an agent active between terminal sessions. It stores a durable
identity, memories, and an append-only trajectory. Its agent acts through host
shell commands. This Native adapter runs on your macOS host; it is not a
container or a security boundary.

`trx run headlong default` starts the `ada` TUI. The local dashboard uses
<http://127.0.0.1:18080>. Exiting the TUI does not stop the persistent mind.
Run `ada stop` to pause background thinking and `ada start` to resume it.

Trellage routes Headlong through the local Copilot proxy. On each launch, it
syncs selected Native skills into Headlong's managed skill store and registers
automatic skills with the `ada` identity. The `i-have-adhd` skill stays outside
the identity skill registries. If you ask to use it, Headlong can read
`~/.headlong/.trellage/skills/i-have-adhd/SKILL.md` for that request only.

Headlong can keep making model calls after your terminal closes. Monitor the
dashboard and stop the mind when you do not need background work.
