---
schemaVersion: 1
capabilities:
  - evidence-backed-rpi-delivery
  - rundown-briefing-output-style
  - autopilot-no-ask-user-launch
  - native-common-skill-bundle
  - isolated-copilot-home
  - interactive-customer-discovery
  - assumption-testing
  - evidence-backed-requirements
bestFor:
  - Durable Research-Plan-Implement (RPI) SDLC work with GitHub Copilot CLI — research notes, plan critique, implementation evidence, and review
  - Specialist HVE Core workflows spanning accessibility, coding-standards, data-science, design-thinking, project-planning, rai, and security categories
  - Sessions where an autonomous, non-interactive Copilot CLI run with a durable evidence trail is preferred over ad hoc prompting
  - Host-native RPI work with Copilot CLI and shared floating skills, rather than the containerized GitHub-native `copilot-hve` Sandbox harness
  - Human-led customer discovery, Minimum Viable Experiments, business or product requirements, and focused UX or architecture work
avoidFor:
  - Tasks scoped to discovering/importing Copilot agents, instructions, or skills — use trx run copilot awesome instead
  - Unattended customer interviews or automatic customer signoff; interactive workflows require a human present
  - Live meeting ingestion or external reporting without separately approved access and data handling
  - Mixing in the superpowers plugin in the same profile; setup and launch manage exactly one cataloged plugin per profile
prerequisites:
  - id: copilot-cli
    description: GitHub Copilot CLI 1.0.74 or later, already authenticated, on the host.
  - id: cli-tools
    description: jq and curl available on the host; verified interactive customer workflows also need Python 3 and Copilot CLI 1.0.81 or later.
workflows:
  - id: rpi-agent-cycle
    description: Run HVE Core's dedicated RPI Agent through a complete Research, Plan, Implement, and Review cycle.
    launchAgent: hve-core:rpi-agent
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
  - id: customer-discovery
    description: Discover the customer's problem and stakeholders, or resume Design Thinking at the method supported by existing evidence. Use for vague AI ambitions or an unvalidated solution request, not approved implementation work.
    launchAgent: hve-core:dt-coach
    interaction:
      mode: interactive
      requiredSkills: [dt-coaching-foundation, dt-methods, dt-rpi-integration]
    frame: fixed
    examples:
      - A customer wants an AI chatbot; help us discover the real user problem before choosing a solution
      - Resume customer discovery from these validated concepts without restarting the workshop
      - Start Design Thinking discovery to validate an unproven customer problem before we build a new capability
    promptTemplate: |
      Work with me as DT Coach. Read dt-coaching-foundation, dt-methods,
      dt-rpi-integration, and their applicable references explicitly; stop
      and report missing capabilities rather than simulate them. First
      confirm the current problem, evidence, stakeholders, and method.
      Reuse existing evidence and return to earlier methods when needed.
      Ask focused questions and wait for my answers. Never invent user
      observations, customer agreement, or evidence. Preserve source
      labels, contradictions, unknowns, fidelity constraints, and canonical
      .copilot-tracking/dt artifacts. A Guide-approved brief is context,
      not customer signoff. Formal exits from problem, solution, or
      implementation space go to rpi-research with bounded scope; they
      do not authorize coding. Do not implement or publish without a
      separate human decision.

      Request:
      {{intent}}
  - id: test-assumption
    description: Design a Minimum Viable Experiment for a falsifiable customer, feasibility, adoption, or performance assumption before investment. Separate learning and partner ownership from a demo or mini-product.
    launchAgent: hve-core:experiment-designer
    interaction:
      mode: interactive
      requiredSkills: [experiment-design]
    frame: fixed
    examples:
      - Design a feasibility experiment with our partner before we commit to a full product
      - Test whether this intervention improves task completion without assuming the claimed 30 percent benefit
    promptTemplate: |
      Work with me as Experiment Designer. Read experiment-design and the
      agent's applicable instructions and references explicitly; report
      missing capabilities and stop. Confirm one falsifiable assumption,
      the decision it informs, baseline, population, and measurement owner.
      Define success, failure, and inconclusive criteria before execution.
      Keep this a Minimum Viable Experiment, not a demo or mini-product.
      In a collaborative engagement, agree on joint work, progressive
      ownership transfer, and independent partner replication. Missing
      facts stay unknown. Obtain approval of the experiment and data
      handling before running it. Personal or sensitive measurement needs
      privacy review first. Keep execution conformance separate from
      hypothesis outcome; a disproved hypothesis can be useful evidence.
      Do not automatically start rpi-challenger, create backlog items,
      implement a product, or publish results.

      Request:
      {{intent}}
  - id: business-requirements
    description: Agree on solution-neutral business requirements, constraints, owners, and signoff from an understood customer problem. Use BRD Builder when problem evidence exists.
    launchAgent: hve-core:brd-builder
    interaction:
      mode: interactive
      requiredSkills: [requirements-author]
    frame: fixed
    examples:
      - Turn these confirmed business needs into a BRD with requirement IDs and explicit signoff
      - We understand the customer problem; agree on business constraints without designing the product yet
    promptTemplate: |
      Work with me as BRD Builder using requirements-author and its
      applicable references. Stop if required content is unavailable.
      Reuse supported customer evidence and keep requirements
      solution-neutral. Preserve source labels, contradictions, canonical
      artifacts, requirement IDs, and decision authority. Ask for missing
      decisions; never manufacture customer approval. Research can supply
      evidence but cannot clear the builder's quality or signoff gates.
      Do not implement, mutate a tracker, or publish.

      Request:
      {{intent}}
  - id: product-requirements
    description: Define product behavior and acceptance criteria from supported customer needs. Use PRD Builder for product scope and approval, not BRD business framing or automatic implementation.
    launchAgent: hve-core:prd-builder
    interaction:
      mode: interactive
      requiredSkills: [requirements-author]
    frame: fixed
    examples:
      - Write a PRD from the agreed business needs with product acceptance criteria and traceable requirements
      - Refine this product specification with the customer without silently approving or implementing it
    promptTemplate: |
      Work with me as PRD Builder using requirements-author and its
      applicable references. Stop if required content is unavailable.
      Reuse supported needs and existing approvals without restarting
      discovery. Define product behavior, scope, and acceptance criteria.
      Keep source labels, unknowns, canonical artifacts, and requirement
      IDs. Ask for unresolved decisions and retain the builder's quality,
      signoff, and handoff gates. A Guide-approved brief or an RPI research
      result does not approve requirements. Do not implement or publish.

      Request:
      {{intent}}
  - id: focused-ux-coaching
    description: Resolve one bounded UX problem-framing, critique, or stakeholder-advocacy question through UX UI Designer. Do not start the full Design Thinking lifecycle for a single coaching moment.
    launchAgent: hve-core:ux-ui-designer
    interaction:
      mode: interactive
      requiredSkills: [ux-coaching]
    frame: fixed
    examples:
      - Help frame this single UX problem without running a full customer-discovery workshop
      - Help me explain this design critique to stakeholders with honest evidence rather than persuasion claims
    promptTemplate: |
      Work with me as UX UI Designer using ux-coaching and its references.
      Confirm whether this is problem-framing, critique, or
      stakeholder-advocacy, then address only that moment. Stop if the
      required references are missing. Preserve Observed, Reported,
      Assumed, and Unresolved labels with their sources. Do not replace
      missing observations with stakeholder authority or model opinion.
      Ask focused questions and wait for answers. Do not turn the result
      into customer signoff, code, or external Figma or Mural changes.

      Request:
      {{intent}}
  - id: review-architecture
    description: Review system architecture trade-offs against customer needs and constraints with System Architecture Reviewer. Produce evidence for a human decision rather than coding or approving the design.
    launchAgent: hve-core:system-architecture-reviewer
    interaction:
      mode: interactive
      requiredSkills: [architecture-review]
    frame: fixed
    examples:
      - Review this system architecture against the customer's availability and privacy constraints
      - Compare these architecture options using our agreed needs and identify decisions the owner must make
    promptTemplate: |
      Work with me as System Architecture Reviewer using
      architecture-review and its applicable references. Stop if required
      content is missing. Confirm the system boundary, evidence, and
      decision owner. Preserve trade-offs, source labels, unknowns, and
      existing requirement IDs. Route relevant privacy, security,
      accessibility, AI-risk, or supply-chain questions to the responsible
      specialist with explicit scope. Do not infer certification, approve
      a design for its owner, implement changes, or publish.

      Request:
      {{intent}}
  - id: functional-planning
    description: Convert mature, agreed requirements into a reviewed work hierarchy with Functional Planner. Prepare a tracker-ready plan without creating or updating work items.
    launchAgent: hve-core:functional-planner
    interaction:
      mode: interactive
      requiredSkills: [functional-planner]
    frame: fixed
    examples:
      - Break this approved PRD into a reviewed hierarchy of work without writing to the tracker
      - Plan dependencies from our mature requirements while keeping requirement IDs and approval boundaries
    promptTemplate: |
      Work with me as Functional Planner using the functional-planner
      skill and its references. Stop if required content is missing.
      Confirm that requirements are mature enough for planning; reuse
      their approvals rather than inventing new ones. Preserve requirement
      IDs, dependencies, uncertainties, and acceptance criteria in the
      canonical plan. Ask for missing decisions. This is planning only:
      tracker mutation requires a separate approved backlog-executor
      action with a confirmed destination. Do not create work items,
      implement code, or publish.

      Request:
      {{intent}}
---

# Native Copilot CLI (`copilot`) — `hve` profile

`trx run copilot hve` runs the host GitHub Copilot CLI with the `hve-core` plugin from
`microsoft/hve-core`, giving Copilot CLI the same RPI (Research → Plan →
Implement) skill set. See
`prototypes/trellage-copilot-profiles/README.md`.

## Use This Profile When

- You want a full RPI-centered SDLC suite — `rpi-research`, `rpi-plan`,
  `rpi-plan-critique`, `rpi-challenger`, `rpi-implement`, and
  `rpi-review` under upstream `.github/skills/rpi/` — applied to Copilot CLI.
- You want the dedicated `hve-core:rpi-agent` to own the complete Research →
  Plan → Implement → Review cycle.
- You want durable, evidence-backed research and plan artifacts before any
  implementation begins, rather than jumping straight to code.
- You want the built-in Rundown output style (TL;DR, checklist, "Your move:")
  applied automatically, since the launcher installs it for every profile.
- You need an interactive customer workflow with its own evidence and
  decision owner, rather than one prompt that automatically chains agents.

## Avoid This Profile When

- The task is discovering or importing Copilot agents/instructions/skills —
  that is `trx run copilot awesome`'s job, not `hve`'s.
- You want superpowers' TDD/debugging/branch-finishing discipline instead —
  use `trx run copilot superpowers`; each profile installs exactly one cataloged plugin.
- You need an unattended customer workflow. Interactive workflows wait for
  answers and approval; they cannot run in the Guide batch queue.

## Workflow Notes

- The guide's pinned HVE RPI lens launches
  `trx run copilot hve --agent hve-core:rpi-agent` and supplies the selected prompt to the
  interactive Copilot session.
- The RPI skill identifiers above are verified directory names under
  `microsoft/hve-core`'s `.github/skills/rpi/`; treat them as the skill
  vocabulary to reference in prompts. This repository has no documented
  explicit slash-command syntax for HVE Core skills in Copilot CLI, so
  prompts describe the skill by name rather than invoking a `/hve-core:...`
  command.
- Customer workflows use `trx run copilot hve -- --agent <agent>` with the
  authored `--require-skill` checks. This mode does not set `--autopilot`,
  `--allow-all`, or `--no-ask-user`. Default `trx run copilot hve` behavior is unchanged.
  A terminal is required for input and output; piped or batch use is refused.
- Guide checks the installed manifest, exact agent, and required skill
  files and enabled registration before launch. Missing capabilities are reported, not emulated.
  CLI plugin instructions do not automatically apply through `applyTo`;
  the workflow must explicitly load its applicable references.
- Discovery and Experiment are entry lenses. Requirements, focused UX,
  architecture review, and functional planning are contextual choices.
  Existing evidence determines the entry point; do not force every stage.
- HVE owns canonical artifacts and human gates. Guide's local customer
  brief is approved context, not an HVE result or customer signoff.
- Live meeting ingestion, reporting, proposals, and tracker writes require
  separate source-access, privacy, retention, and action controls. These
  are not silently performed by the Guide's preparation workflow.
- `trx upgrade copilot hve --check hve` / `trx upgrade copilot hve` remove-and-reinstall only
  `hve-core@hve-core`; a failed reinstall stays visible and repairable.
- The profile also carries the shared `native-common` floating skill bundle
  (see `config.toml`: `engineersamuel` wildcard, `show-me`, and manually
  activated `i-have-adhd`), so
  general-purpose repository skills remain available alongside HVE Core's.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `copilot`/`hve` as `untested`: it was
  previously observed unhealthy (missing the `hve-core-all` plugin) and was
  repaired locally via `trx repair copilot hve`, but a fresh end-to-end Herdr
  verification run has not yet confirmed the full round trip.
- `trx list copilot --json` only advertises the exact prompt/`--no-ask-user`
  hard-deny/model-override contract for Copilot CLI `1.0.81`; other versions
  report conservative `headless` values.
