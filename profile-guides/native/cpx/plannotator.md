---
schemaVersion: 1
capabilities:
  - visual-html-artifact-creation
  - rundown-briefing-output-style
  - autopilot-no-ask-user-launch
  - native-common-skill-bundle
  - isolated-copilot-home
bestFor:
  - Creating self-contained HTML artifacts with a deliberate visual direction
  - Producing focused HTML wireframes, interactive prototypes, implementation plans, and diagrams
  - Turning technical or product information into pragmatic visual documents that work in a browser
avoidFor:
  - General implementation, debugging, or review work that does not need a visual HTML artifact
  - Native application or production frontend work where a self-contained HTML file is not the deliverable
  - Sessions that need an approval pause; every launch passes --autopilot --allow-all --no-ask-user
prerequisites:
  - id: copilot-cli
    description: GitHub Copilot CLI 1.0.74 or later, already authenticated, on the host.
  - id: cli-tools
    description: jq and curl available on the host for setup, doctor, and update checks.
workflows:
  - id: visual-artifact
    description: Create a polished, self-contained HTML artifact using the broad HTML router and its design guidance.
    skill: html
    examples:
      - Turn this architecture summary into a self-contained visual HTML report
      - Create a polished HTML explainer from these implementation notes
    promptTemplate: |
      Use the html skill to create a self-contained visual artifact for
      {{intent}}.
  - id: wireframe-or-prototype
    description: Choose low-fidelity structure with html-wireframe or polished interaction with html-prototype.
    skill: html-prototype
    examples:
      - Create a responsive wireframe for this workflow
      - Build an interactive HTML prototype for this feature
    promptTemplate: |
      Use html-wireframe for a low-fidelity structure or html-prototype for a
      polished interactive result that addresses {{intent}}.
  - id: plan-or-diagram
    description: Present implementation work with html-plan or explain relationships and sequence with html-diagram.
    skill: html-plan
    examples:
      - Turn this migration plan into a clear visual HTML document
      - Diagram the service interactions and request sequence
    promptTemplate: |
      Use html-plan for execution structure or html-diagram for relationships
      and sequence while presenting {{intent}}.
---

# Native Copilot CLI (`cpx`) — `plannotator` profile

`cpx plannotator` runs the host GitHub Copilot CLI with the Effective HTML
plugin from `plannotator/effective-html`. It provides six focused skills for
self-contained visual artifacts: `design-artifact`, `html`, `html-diagram`,
`html-plan`, `html-prototype`, and `html-wireframe`. See
`prototypes/trellage-copilot-profiles/README.md`.

## Use This Profile When

- You need a self-contained HTML report, explainer, landing page, or visual
  document with a deliberate design direction.
- You want a low-fidelity wireframe or a polished, responsive prototype.
- You need a visual implementation plan or a diagram that explains
  relationships, sequence, topology, state, or hierarchy.

## Avoid This Profile When

- The task is general coding, debugging, or review work without a visual HTML
  deliverable.
- You need a production frontend integrated into an application rather than a
  self-contained artifact.
- You need an approval pause before Copilot acts. Launch always passes
  `--autopilot --allow-all --no-ask-user`.

## Workflow Notes

- `html` is the broad router for visual HTML deliverables.
- Use `html-wireframe`, `html-prototype`, `html-plan`, or `html-diagram`
  directly when the requested artifact type is clear.
- `design-artifact` supplies the shared visual principles used by the artifact
  skills.
- Setup, doctor, repair, and launch verify all six skills as regular,
  non-symlinked files enabled by Copilot from the selected plugin root.
- The installed plugin list has no displayed version. `cpx` reads version
  `0.4.0` from the plugin's validated `.codex-plugin/plugin.json` manifest.

## Gotchas

- The profile also carries the shared `native-common` floating skill bundle,
  including `engineersamuel/skills` and `show-me`.
- `cpx update --check plannotator` compares the installed manifest version
  with the official upstream `.codex-plugin/plugin.json`.
