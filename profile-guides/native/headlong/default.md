---
schemaVersion: 2
templates:
  persistent-investigation: >-
    {{intent}}


    Keep working between my interactions. Maintain a durable record of
    hypotheses and evidence, identify root causes, test potential fixes, and
    make progress visible in the local dashboard so I can monitor and redirect
    the investigation.
  continue-agent-world: "{{intent}}"
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
