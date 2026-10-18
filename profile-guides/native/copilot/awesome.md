---
schemaVersion: 2
templates:
  suggest-agents: /awesome-copilot:suggest-awesome-github-copilot-agents {{intent}}
  suggest-instructions: /awesome-copilot:suggest-awesome-github-copilot-instructions {{intent}}
  suggest-skills: /awesome-copilot:suggest-awesome-github-copilot-skills {{intent}}
---

# Native Copilot CLI (`copilot`) — `awesome` profile

`trx run copilot awesome` runs the host GitHub Copilot CLI with the `awesome-copilot`
plugin, providing three meta-skills that discover and import curated
Copilot assets from the community `github/awesome-copilot` repository. See
`prototypes/trellage-copilot-profiles/README.md` and the upstream plugin's
`plugin.json` (`extensions.com.github.awesome-copilot.skills`).

## Use This Profile When

- You want Copilot to recommend agents, instructions, or skills from the
  `awesome-copilot` collection tailored to the current repository's context
  and chat history, and to flag ones that are already installed but stale.
- You are bootstrapping Copilot configuration for a new or under-configured
  repository and want curated starting points instead of writing from
  scratch.
- You want the built-in Rundown output style (TL;DR, checklist, "Your move:")
  applied automatically to responses, since the launcher installs it for
  every `copilot` profile.

## Avoid This Profile When

- The task is general implementation, debugging, or review work — pick
  `trx run copilot hve` (RPI-centered SDLC) or `trx run copilot superpowers` (TDD/debugging/review
  discipline) instead; `awesome` is scoped to discovery and import only.
- Docker is not available on the host — the plugin's MCP server cannot start
  without it, and MCP startup failure blocks the discovery commands.
- You need an approval pause before Copilot acts — every launch passes
  `--autopilot --allow-all --no-ask-user`.

## Workflow Notes

- All three skills are exact, verified slash commands published by the
  upstream plugin: `/awesome-copilot:suggest-awesome-github-copilot-agents`,
  `/awesome-copilot:suggest-awesome-github-copilot-instructions`, and
  `/awesome-copilot:suggest-awesome-github-copilot-skills`.
- The upstream plugin also documents a fourth command,
  `/awesome-copilot:suggest-awesome-github-copilot-collections`, for
  suggesting curated collections; it is not currently reflected in this
  profile's "three meta-skills" catalog description, so treat it as
  unconfirmed for this profile until verified against the installed plugin.
- `trx list copilot --json` only advertises the exact prompt/`--no-ask-user`
  hard-deny/model-override contract for Copilot CLI `1.0.80`; other installed
  versions still work but report conservative `headless` values.

## Gotchas

- A known compatibility issue (`known-issue: F` in `trx`'s Herdr ledger)
  reports repo-context role confusion when this profile is delegated within
  the orchestrator's own repo/worktree and never finishes — avoid delegating
  `trx run copilot awesome` against Trellage's own working tree.
- Update checks compare the installed plugin version against the official
  manifest; retired plugin identities are removed automatically during
  setup, launch, update, and repair.
