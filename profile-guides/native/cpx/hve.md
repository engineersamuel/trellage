---
schemaVersion: 1
capabilities:
  - hve-core-rpi-skill-bundle
  - rundown-briefing-output-style
  - autopilot-no-ask-user-launch
  - native-common-skill-bundle
  - isolated-copilot-home
bestFor:
  - Durable Research-Plan-Implement (RPI) SDLC work with GitHub Copilot CLI — research notes, plan critique, implementation evidence, and review
  - Specialist HVE Core workflows spanning accessibility, coding-standards, data-science, design-thinking, project-planning, rai, and security categories
  - Sessions where an autonomous, non-interactive Copilot CLI run with a durable evidence trail is preferred over ad hoc prompting
avoidFor:
  - Tasks scoped to discovering/importing Copilot agents, instructions, or skills — use cpx awesome instead
  - Sessions that need an approval pause; every launch passes --autopilot --allow-all --no-ask-user
  - Mixing in the superpowers plugin in the same profile; setup and launch manage exactly one cataloged plugin per profile
prerequisites:
  - id: copilot-cli
    description: GitHub Copilot CLI 1.0.74 or later, already authenticated, on the host.
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

# Native Copilot CLI (`cpx`) — `hve` profile

`cpx hve` runs the host GitHub Copilot CLI with the `hve-core` plugin from
`microsoft/hve-core`, giving Copilot CLI the same RPI (Research → Plan →
Implement) skill set used by `cdx hve` and `grx hve`. See
`prototypes/trellage-copilot-profiles/README.md`.

## Use This Profile When

- You want a full RPI-centered SDLC suite — `rpi-research`, `rpi-plan`,
  `rpi-plan-critique`, `rpi-challenger`, `rpi-implement`, `rpi-quick`, and
  `rpi-review` under upstream `.github/skills/rpi/` — applied to Copilot CLI.
- You want durable, evidence-backed research and plan artifacts before any
  implementation begins, rather than jumping straight to code.
- You want the built-in Rundown output style (TL;DR, checklist, "Your move:")
  applied automatically, since the launcher installs it for every profile.

## Avoid This Profile When

- The task is discovering or importing Copilot agents/instructions/skills —
  that is `cpx awesome`'s job, not `hve`'s.
- You want superpowers' TDD/debugging/branch-finishing discipline instead —
  use `cpx superpowers`; each profile installs exactly one cataloged plugin.
- You need an approval pause before Copilot acts — launch always passes
  `--autopilot --allow-all --no-ask-user`.

## Workflow Notes

- The RPI skill identifiers above are verified directory names under
  `microsoft/hve-core`'s `.github/skills/rpi/`; treat them as the skill
  vocabulary to reference in prompts. This repository has no documented
  explicit slash-command syntax for HVE Core skills in Copilot CLI, so
  prompts describe the skill by name rather than invoking a `/hve-core:...`
  command.
- `cpx update --check hve` / `cpx update hve` remove-and-reinstall only
  `hve-core@hve-core`; a failed reinstall stays visible and repairable.
- The profile also carries the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard plus `show-me`), so
  general-purpose repository skills remain available alongside HVE Core's.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `cpx`/`hve` as `untested`: it was
  previously observed unhealthy (missing the `hve-core-all` plugin) and was
  repaired locally via `cpx repair hve`, but a fresh end-to-end Herdr
  verification run has not yet confirmed the full round trip.
- `cpx list --json` only advertises the exact prompt/`--no-ask-user`
  hard-deny/model-override contract for Copilot CLI `1.0.80`; other versions
  report conservative `headless` values.
