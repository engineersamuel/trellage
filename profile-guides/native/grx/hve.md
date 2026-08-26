---
schemaVersion: 1
capabilities:
  - hve-core-rpi-skill-bundle
  - grok-workspace-sandbox
  - keyless-proxy-model-routing
  - isolated-grok-profile-home
  - never-authenticate-guarantee
bestFor:
  - Durable Research-Plan-Implement (RPI) SDLC work using Grok's native sessions and subagents with HVE Core's skill set
  - Sessions that should keep network access but restrict filesystem writes to the working directory, ~/.grok/, and temp, via Grok's native workspace sandbox
  - Teams that want a hard guarantee Grok never shows an xAI login/device-code prompt during automation
avoidFor:
  - Tasks that need the awesome-copilot-style discovery skills; the grx catalog intentionally excludes awesome-copilot due to a global-instruction/thought-logging hang risk on older Grok installations
  - Sessions where no genuine grok login has ever been performed on the host; grx fails closed rather than prompting for login itself
  - Work needing MCP servers imported from ~/.grok/config.toml; MCPs are profile-local and must be configured explicitly per profile
prerequisites:
  - id: grok-build-cli
    description: Grok Build CLI 0.2.112 or later, tested with 0.2.112.
  - id: host-grok-login
    description: A genuine grok login performed once on the host outside grx, producing a usable ~/.grok/auth.json.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080/v1 for the default grok-4.6 model routing.
  - id: cli-tools
    description: jq and curl available on the host for setup, doctor, and update checks.
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

# Native Grok (`grx`) — `hve` profile

`grx hve` runs Grok Build with the `hve-core-all` plugin (source
`microsoft/hve-core@plugins-v3.3.106#plugins/hve-core-all`), Grok-native
sessions and subagents, and a separate Caveman plugin. See
`prototypes/trellage-grok-profiles/README.md`.

## Use This Profile When

- You want HVE Core's RPI skill set — `rpi-research`, `rpi-plan`,
  `rpi-plan-critique`, `rpi-challenger`, `rpi-implement`, `rpi-quick`, and
  `rpi-review` — applied to a Grok session with its own subagents.
- You want Grok's native `--sandbox workspace` profile: filesystem writes
  restricted to the current working directory, `~/.grok/`, and temp, while
  network access stays allowed and `bypassPermissions`/`--always-approve`
  remove approval prompts as an independent layer.
- You want the never-authenticate guarantee: `grx` never performs xAI login
  itself and fails closed if the host session is missing or unusable, rather
  than falling back to an interactive or device-code prompt.

## Avoid This Profile When

- You want awesome-copilot-style discovery skills — the `grx` catalog
  intentionally excludes `awesome-copilot` because older direct Grok
  installations could treat its Copilot-wide instruction files as global
  Grok instructions, including a thought-logging workflow that could end with
  no user-visible response.
- No genuine `grok login` has ever been run on this host outside `grx` — the
  launcher will exit with a diagnostic rather than prompting for login.
- You need MCP servers from your personal `~/.grok/config.toml`; configure
  each profile's MCPs explicitly instead (`grx hve mcp add ...`).

## Workflow Notes

- The RPI skill identifiers above are verified directory names under
  `microsoft/hve-core`'s `.github/skills/rpi/`; treat them as the skill
  vocabulary to reference in prompts — this repo has no evidence of a
  documented explicit slash/command syntax for HVE Core skills in Grok.
- Pass `-m`/`--model` to select another model from the proxy catalog instead
  of the `grok-4.6` default; `grx` forwards the option unchanged.
- The profile also carries the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard plus `show-me`).
- Profile policy disables Claude/Cursor compatibility loading and Codex
  sessions; personal `~/.agents/skills` and `~/.agents/commands` are ignored,
  while repository-native `.grok`, `.agents`, and `AGENTS.md` remain visible.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `grx`/`hve` as `known-issue: E`:
  `"Agent is outside run scope"` from `ScopedHerdr`/`createHerdrTrellageBackend`
  — a Herdr-side scoping issue, not a plugin defect.
- `GRX_DISABLE_AUTH_CHECK=1` exists only for trusted local proxy setups that
  intentionally route all model traffic through `copilot-proxy-rs`; it skips
  the host `~/.grok/auth.json` viability check and should not be set for
  ordinary use.
