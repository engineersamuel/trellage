---
schemaVersion: 2
templates:
  visual-artifact: |-
    Use the html skill to create a self-contained visual artifact for
    {{intent}}.
  wireframe-or-prototype: |-
    Use html-wireframe for a low-fidelity structure or html-prototype for a
    polished interactive result that addresses {{intent}}.
  plan-or-diagram: |-
    Use html-plan for execution structure or html-diagram for relationships
    and sequence while presenting {{intent}}.
---

# Native Copilot CLI (`copilot`) — `plannotator` profile

`trx run copilot plannotator` runs the host GitHub Copilot CLI with the Effective HTML
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
- The installed plugin list has no displayed version. `copilot` reads version
  `0.4.0` from the plugin's validated `.codex-plugin/plugin.json` manifest.

## Gotchas

- The profile also carries the shared `native-common` floating skill bundle,
  including `engineersamuel/skills`, `show-me`, and manually activated
  `i-have-adhd`.
- `trx upgrade copilot plannotator --check plannotator` compares the installed manifest version
  with the official upstream `.codex-plugin/plugin.json`.
