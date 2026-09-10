---
schemaVersion: 1
capabilities:
  - evidence-backed-rpi-delivery
  - rundown-briefing-output-style
  - autopilot-no-ask-user-launch
  - native-common-skill-bundle
  - isolated-copilot-home
  - customer-engagement-lifecycle-routing
bestFor:
  - Durable Research-Plan-Implement (RPI) SDLC work with GitHub Copilot CLI — research notes, plan critique, implementation evidence, and review
  - Specialist HVE Core workflows spanning accessibility, coding-standards, data-science, design-thinking, project-planning, rai, and security categories
  - Sessions where an autonomous, non-interactive Copilot CLI run with a durable evidence trail is preferred over ad hoc prompting
  - Host-native RPI work with Copilot CLI and shared floating skills, rather than the containerized GitHub-native `copilot-hve` Sandbox harness
  - Customer engagement work spanning Design Thinking discovery, meeting analysis, BRD or PRD authoring, and specialist review before a formal RPI handoff
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
  - id: rpi-agent-cycle
    description: Run HVE Core's dedicated RPI Agent through a complete Research, Plan, Implement, and Review cycle.
    examples:
      - Build this feature through research, planning, implementation, and review
      - Investigate and fix this issue with durable evidence at every stage
      - Take this repository change through the full RPI workflow
    promptTemplate: |
      Take this request through a complete Research, Plan, Implement, and
      Review cycle. Keep durable evidence for each stage, challenge the plan
      before implementation, and verify the final result: {{intent}}
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
      - Execute this reviewed migration plan and record the evidence from the affected checks
    promptTemplate: |
      Use the rpi-implement skill to execute the approved plan for
      {{intent}}, then use rpi-review to record verification evidence.
  - id: customer-engagement-lifecycle
    description: Route a customer engagement across Design Thinking discovery and concept validation, meeting analysis, BRD or PRD authoring, and specialist review (UX/UI, ADR, privacy, RAI, security, and supply chain), then functional planning and backlog management once requirements are mature, with a formal handoff into rpi-research.
    launchAgent: hve-core:dt-coach
    examples:
      - We're starting discovery with a customer on a new capability and need to validate the problem before committing to a design
      - Turn this customer meeting into structured requirements without skipping design validation
      - Our design thinking work is validated; carry it through requirements, specialist review, and into RPI research
    promptTemplate: |
      Treat this as a connected customer-engagement lifecycle, not a single
      agent request. When the problem is not yet well understood, start with
      the DT Coach agent for stakeholder-centered Design Thinking discovery,
      framing, and concept validation, preserving its ability to return
      non-linearly to earlier methods. When attributed requirements already
      exist in customer material, use the Meeting Analyst agent first,
      respecting its sensitive-data handling. Convert validated needs into a
      BRD or PRD with the BRD Builder or PRD Builder agent, matched to
      problem and solution maturity, and route to the UX UI Designer, ADR
      Creator, Privacy Planner, RAI Planner, Security Planner, or SSSC
      Planner agent whenever their concerns arise. Use the Functional
      Planner and Backlog Manager agents only once requirements are
      sufficiently mature. Preserve every source artifact, constraint,
      assumption, and validated/assumed/unknown/conflicting confidence
      marker across each handoff, and continue mature Design Thinking or
      requirements work through the formal DT-to-RPI handoff into
      rpi-research; never skip a lifecycle phase or bypass evidence
      gathering: {{intent}}
---

# Native Copilot CLI (`cpx`) — `hve` profile

`cpx hve` runs the host GitHub Copilot CLI with the `hve-core` plugin from
`microsoft/hve-core`, giving Copilot CLI the same RPI (Research → Plan →
Implement) skill set. See
`prototypes/trellage-copilot-profiles/README.md`.

## Use This Profile When

- You want a full RPI-centered SDLC suite — `rpi-research`, `rpi-plan`,
  `rpi-plan-critique`, `rpi-challenger`, `rpi-implement`, `rpi-quick`, and
  `rpi-review` under upstream `.github/skills/rpi/` — applied to Copilot CLI.
- You want the dedicated `hve-core:rpi-agent` to own the complete Research →
  Plan → Implement → Review cycle.
- You want durable, evidence-backed research and plan artifacts before any
  implementation begins, rather than jumping straight to code.
- You want the built-in Rundown output style (TL;DR, checklist, "Your move:")
  applied automatically, since the launcher installs it for every profile.
- You are engaging a customer or stakeholder before implementation is
  scoped — Design Thinking discovery, meeting-transcript analysis, BRD/PRD
  authoring, or specialist routing (UX/UI, ADR, privacy, RAI, security,
  supply chain) — and want that work to hand off into RPI once requirements
  are mature, rather than jumping straight to `rpi-research`.

## Avoid This Profile When

- The task is discovering or importing Copilot agents/instructions/skills —
  that is `cpx awesome`'s job, not `hve`'s.
- You want superpowers' TDD/debugging/branch-finishing discipline instead —
  use `cpx superpowers`; each profile installs exactly one cataloged plugin.
- You need an approval pause before Copilot acts — launch always passes
  `--autopilot --allow-all --no-ask-user`.

## Workflow Notes

- The guide's pinned HVE RPI lens launches
  `cpx hve --agent hve-core:rpi-agent` and supplies the selected prompt to the
  interactive Copilot session.
- The RPI skill identifiers above are verified directory names under
  `microsoft/hve-core`'s `.github/skills/rpi/`; treat them as the skill
  vocabulary to reference in prompts. This repository has no documented
  explicit slash-command syntax for HVE Core skills in Copilot CLI, so
  prompts describe the skill by name rather than invoking a `/hve-core:...`
  command.
- The `customer-engagement-lifecycle` workflow names the same installed
  `hve-core` agents (`DT Coach`, `Meeting Analyst`, `BRD Builder`,
  `PRD Builder`, `UX UI Designer`, `ADR Creator`, `Privacy Planner`,
  `RAI Planner`, `Security Planner`, `SSSC Planner`, `Functional Planner`,
  `Backlog Manager`) by their verified `.agent.md` frontmatter `name` values
  rather than pinning a new profile per agent; it treats these agents as one
  connected discovery-to-delivery lifecycle and defers to Design Thinking's
  own non-linear method-return protocol and its tiered `rpi-research`
  handoff contract instead of forcing every engagement through every step.
  Its `launchAgent: hve-core:dt-coach` setting makes guide command previews,
  terminal launches, and Herdr jobs include `--agent hve-core:dt-coach`.
  This selects the installed DT Coach at startup rather than merely naming
  it in a prompt. Other workflows do not inherit this selection; the pinned
  HVE RPI lens continues to select `hve-core:rpi-agent`.
- `cpx update --check hve` / `cpx update hve` remove-and-reinstall only
  `hve-core@hve-core`; a failed reinstall stays visible and repairable.
- The profile also carries the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard, `show-me`, and manually
  activated `i-have-adhd`), so
  general-purpose repository skills remain available alongside HVE Core's.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `cpx`/`hve` as `untested`: it was
  previously observed unhealthy (missing the `hve-core-all` plugin) and was
  repaired locally via `cpx repair hve`, but a fresh end-to-end Herdr
  verification run has not yet confirmed the full round trip.
- `cpx list --json` only advertises the exact prompt/`--no-ask-user`
  hard-deny/model-override contract for Copilot CLI `1.0.81`; other versions
  report conservative `headless` values.
