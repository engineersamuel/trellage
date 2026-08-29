---
schemaVersion: 1
capabilities:
  - awesome-copilot-discovery-meta-skills
  - rundown-briefing-output-style
  - autopilot-no-ask-user-launch
  - isolated-copilot-home
bestFor:
  - Discovering and importing curated GitHub Copilot agents, instructions, and skills into the current repository
  - Auditing a repository for outdated or duplicate agents/instructions/skills against the upstream awesome-copilot collection
  - Bootstrapping a new repository's Copilot configuration from community-curated assets rather than writing it from scratch
avoidFor:
  - General coding, debugging, or review work unrelated to discovering/importing Copilot assets — use cpx hve or cpx superpowers instead
  - Environments without Docker; the awesome-copilot plugin's bundled MCP server starts via docker run and fails without it
  - Sessions that need a human approval pause; every launch passes --autopilot --allow-all --no-ask-user
prerequisites:
  - id: copilot-cli
    description: GitHub Copilot CLI 1.0.74 or later, already authenticated, on the host.
  - id: docker
    description: Docker installed and on PATH; the awesome-copilot plugin's MCP server runs via docker run ... ghcr.io/microsoft/mcp-dotnet-samples/awesome-copilot:latest.
  - id: cli-tools
    description: jq and curl available on the host for setup, doctor, and update checks.
workflows:
  - id: suggest-agents
    description: Suggest relevant GitHub Copilot custom agents from the awesome-copilot repository based on current repository context, avoiding duplicates with existing custom agents.
    skill: awesome-copilot:suggest-awesome-github-copilot-agents
    examples:
      - Suggest custom agents from awesome-copilot that fit this repository
      - Find agents relevant to our current tech stack and flag any that are already installed but outdated
    promptTemplate: |
      /awesome-copilot:suggest-awesome-github-copilot-agents {{intent}}
  - id: suggest-instructions
    description: Suggest relevant GitHub Copilot instruction files from the awesome-copilot repository, avoiding duplicates with existing instructions and flagging outdated ones.
    skill: awesome-copilot:suggest-awesome-github-copilot-instructions
    examples:
      - Suggest instruction files that match the languages and frameworks used here
      - Find a maintained instruction file for our test conventions and identify duplicates we already have
    promptTemplate: |
      /awesome-copilot:suggest-awesome-github-copilot-instructions {{intent}}
  - id: suggest-skills
    description: Suggest relevant GitHub Copilot skills from the awesome-copilot repository, avoiding duplicates with existing skills and flagging outdated ones.
    skill: awesome-copilot:suggest-awesome-github-copilot-skills
    examples:
      - Suggest skills we're missing given the current repository content
      - Recommend curated skills for this API project and flag installed skills that overlap
    promptTemplate: |
      /awesome-copilot:suggest-awesome-github-copilot-skills {{intent}}
---

# Native Copilot CLI (`cpx`) — `awesome` profile

`cpx awesome` runs the host GitHub Copilot CLI with the `awesome-copilot`
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
  every `cpx` profile.

## Avoid This Profile When

- The task is general implementation, debugging, or review work — pick
  `cpx hve` (RPI-centered SDLC) or `cpx superpowers` (TDD/debugging/review
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
- `cpx list --json` only advertises the exact prompt/`--no-ask-user`
  hard-deny/model-override contract for Copilot CLI `1.0.80`; other installed
  versions still work but report conservative `headless` values.

## Gotchas

- A known compatibility issue (`known-issue: F` in `trx`'s Herdr ledger)
  reports repo-context role confusion when this profile is delegated within
  the orchestrator's own repo/worktree and never finishes — avoid delegating
  `cpx awesome` against Trellage's own working tree.
- Update checks compare the installed plugin version against the official
  manifest; retired plugin identities are removed automatically during
  setup, launch, update, and repair.
