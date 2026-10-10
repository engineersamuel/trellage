---
schemaVersion: 1
capabilities:
  - native-agent
  - host-context
bestFor:
  - Work that needs existing GitHub CLI, Git, SSH, shell, or Fx state
  - Interactive Fx sessions launched through Trellage
avoidFor:
  - Work requiring profile-scoped credentials or configuration isolation
  - Strict selected-only skill isolation
prerequisites:
  - id: mise
    description: mise installed on the host; setup uses it to resolve and pin the eligible Fx release.
  - id: copilot-proxy
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 with gpt-6.1-sol and gpt-6-astra available.
  - id: shared-host-state
    description: Accept that Fx will read and write the existing host ~/.fx state rather than a profile-scoped home.
workflows:
  - id: interactive
    description: Start Fx with the host context intact
    examples:
      - Inspect and modify this repository
      - Use my existing GitHub CLI and SSH authentication
    promptTemplate: |
      {{intent}}
---
# Fx default

Launch with `trx run fx`. Trellage manages the Fx binary and disables upstream
automatic upgrades, while Fx receives the real host `HOME` and uses `~/.fx`.
This preserves `gh`, Git, SSH, shell, credentials, sessions, MCP state, and Fx
skills. Those resources are shared with direct host Fx runs and are not isolated
by this profile. `--require-proven-isolation` rejects the launch.

Trellage adds a namespaced proxy connection without replacing other Fx settings.
Normal launches use `gpt-6.1-sol` at `medium` effort. Since Fx 0.0.13 does not
provide a separate plan-mode model policy, launch `trx run fx --plan` to use
`gpt-6-astra` at `max` effort for the session.
