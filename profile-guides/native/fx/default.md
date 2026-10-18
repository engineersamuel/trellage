---
schemaVersion: 2
templates:
  interactive: "{{intent}}"
---

# Fx default

Launch with `trx run fx default`. Trellage manages the Fx binary and disables upstream
automatic upgrades, while Fx receives the real host `HOME` and uses `~/.fx`.
This preserves `gh`, Git, SSH, shell, credentials, sessions, MCP state, and Fx
skills. Those resources are shared with direct host Fx runs and are not isolated
by this profile. `--require-proven-isolation` rejects the launch.

Trellage adds a namespaced proxy connection without replacing other Fx settings.
Normal launches use `gpt-6.1-sol` at `medium` effort. Since Fx 0.0.13 does not
provide a separate plan-mode model policy, launch `trx run fx default --plan` to use
`gpt-6-astra` at `max` effort for the session.
