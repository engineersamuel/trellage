---
schemaVersion: 2
templates:
  rpi-agent-cycle: |-
    Take this request through a complete Research, Plan, Implement, and
    Review cycle. Keep durable evidence for each stage, challenge the plan
    before implementation, and verify the final result: {{intent}}
  rpi-research: |-
    Use the rpi-research skill to investigate {{intent}} and produce a
    durable research note before any planning or implementation begins.
  rpi-plan-and-critique: |-
    Use the rpi-plan skill to draft a plan for {{intent}}, then use
    rpi-plan-critique to challenge it before implementation begins.
  rpi-implement-and-review: |-
    Use the rpi-implement skill to execute the approved plan for
    {{intent}}, then use rpi-review to record verification evidence.
  customer-discovery: |-
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
  test-assumption: |-
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
  business-requirements: |-
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
  product-requirements: |-
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
  focused-ux-coaching: |-
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
  review-architecture: |-
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
  functional-planning: |-
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
  (see `config.example.toml`: `engineersamuel` wildcard, `show-me`, and manually
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
