---
schemaVersion: 1
capabilities:
  - hve-core-rpi-skill-bundle
  - codex-workspace-write-sandbox
  - keyless-proxy-model-routing
  - isolated-codex-profile-home
  - explicit-mcp-per-profile
bestFor:
  - Durable Research-Plan-Implement (RPI) work — research notes, plan critique, implementation evidence, and review — using HVE Core's Microsoft-maintained skill set
  - Specialist engineering workflows that benefit from HVE Core's accessibility, coding-standards, data-science, design-thinking, project-planning, rai, and security skill categories
  - Sessions that should keep network access and host-wide reads but must not write outside the workspace, since Codex's native sandbox enforces that boundary
avoidFor:
  - Tasks that require native OpenAI authentication by default; the profile routes through copilot-proxy-rs unless you opt in with cdx --native-auth
  - Anything needing an interactive approval pause; launch always passes --ask-for-approval never and disables user-input requests
  - Importing host ~/.codex/config.toml MCP servers — MCPs are profile-local and must be configured explicitly per profile
prerequisites:
  - id: codex-cli
    description: Codex CLI 0.146.0 or later installed on the host.
  - id: fish-shell-config
    description: An existing readable, writable, regular, non-symlink ~/.config/fish/config.fish (installer requires Fish).
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 for the default keyless model routing.
  - id: cli-tools
    description: jq and curl available on the host for setup, doctor, and launch health checks.
workflows:
  - id: rpi-research
    description: Open a durable research phase before planning or implementing, producing a research note that a later plan phase can cite.
    examples:
      - Research how the existing retry logic handles partial failures before we change it
      - Investigate why this endpoint intermittently times out and write up findings
    promptTemplate: |
      Use the rpi-research skill to investigate {{intent}} and produce a
      durable research note before any planning or implementation begins.
  - id: rpi-plan-and-critique
    description: Draft an implementation plan from prior research, then subject it to rpi-plan-critique before implementation starts.
    examples:
      - Turn the research above into a phased implementation plan
      - Critique this plan for missed edge cases before I start coding
    promptTemplate: |
      Use the rpi-plan skill to draft a plan for {{intent}}, then use
      rpi-plan-critique to challenge it before implementation begins.
  - id: rpi-implement-and-review
    description: Implement against an approved plan and close the loop with rpi-review evidence.
    examples:
      - Implement the approved plan and show the verification evidence
    promptTemplate: |
      Use the rpi-implement skill to execute the approved plan for
      {{intent}}, then use rpi-review to record verification evidence.
---

# Native Codex (`cdx`) — `hve` profile

`cdx hve` runs the host Codex CLI in an isolated, named profile home with the
`hve-core-all` plugin installed from `microsoft/hve-core` (via Trellage's local
marketplace adapter). See `prototypes/trellage-codex-profiles/README.md` and
`prototypes/trellage-codex-profiles/marketplaces/hve-core/.agents/plugins/marketplace.json`.

## Use This Profile When

- You want Microsoft's HVE Core RPI (Research → Plan → Implement) discipline —
  including `rpi-research`, `rpi-plan`, `rpi-plan-critique`, `rpi-challenger`,
  `rpi-implement`, `rpi-quick`, and `rpi-review` skills under
  `.github/skills/rpi/` upstream — applied to a Codex CLI session.
- You want Codex's native OS-level sandbox (Seatbelt on macOS,
  Landlock+bubblewrap on Linux): writes are restricted to the workspace and
  temp directories, while reads and network access remain allowed and no
  approval prompts interrupt the run.
- You want a keyless, proxy-routed model (defaults resolved by the profile's
  managed config) without copying `~/.codex/auth.json`.

## Avoid This Profile When

- You need native OpenAI authentication for this launch — use
  `cdx --native-auth hve exec "..."` instead of the default proxy routing.
- You need MCP servers shared from your personal `~/.codex/config.toml` — each
  profile's MCPs are isolated and must be added explicitly to this profile.
- You need a human to answer a clarifying question mid-run; launch disables
  `default_mode_request_user_input` and never pauses for approval.

## Workflow Notes

- `cdx hve` launches immediately; `cdx setup hve` (or `--all`) installs or
  repairs the plugin first. `cdx doctor hve` is the strict, read-only check.
- The exact RPI skill identifiers above are verified directory names under
  `microsoft/hve-core`'s `.github/skills/rpi/`; treat them as the skill
  vocabulary to reference in prompts, not as slash commands — this repo has no
  evidence of a documented explicit-invocation syntax for HVE Core skills in
  Codex, unlike the `pstack` profile's `$name` convention.
- `cdx update --check hve` / `cdx update hve` remove-and-reinstall only
  `hve-core-all@hve-core`; a failed reinstall stays visible and repairable.

## Gotchas

- Unlike `cldx`, `cpx`, `grx`, `jcx`, `omp`, `picx`, and `prx`, this
  launcher's `bin/cdx` script has no observed wiring to the shared
  `native-common` floating-skills bundle — do not assume `engineersamuel` or
  `show-me` skills are present here even though the repository's general
  policy calls for every native launcher to include them.
- Post-exit cleanup strips only Codex-generated project-trust stanzas; other
  concurrent writes (hooks, marketplace metadata) are left alone.
