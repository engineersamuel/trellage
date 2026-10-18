---
schemaVersion: 2
templates:
  design-system-pass: "{{intent}}"
  anti-slop-review: "{{intent}}"
  motion-polish: "{{intent}}"
  html-to-video: "{{intent}}"
---

# claude / frontend-design

Launch this profile with `trx run claude frontend-design`. It runs on the host and uses the local proxy at `http://127.0.0.1:8080`.

## Use This Profile When

- You're building agency-quality landing pages or marketing UI and want design-intelligence, anti-slop critique, and motion polish as distinct passes.
- You need GSAP-driven scroll/interaction animation authored by skills that know the library directly (core, timelines, ScrollTrigger, React).
- You need to turn a finished HTML deliverable into a video (product launch, PR, explainer) via HyperFrames.

## Avoid This Profile When

- The work is backend-only or has no visual/UI surface.
- You want short-form social copy — use claude-social-media instead.
- The UI change is trivial and doesn't need constraint-driven design, taste review, or motion work.

## Workflow Notes

- The bundled skills are triggered by natural-language intent, not documented slash commands — describe the audience, single CTA, ban list, and any reference screenshots directly in your prompt.
- Typography, spacing, and motion are meant to be separate polish passes rather than one combined request; ask for them one at a time for best results.
- Skill sources: `nextlevelbuilder/ui-ux-pro-max-skill` (design intelligence), `leonxlnx/taste-skill` (anti-slop critique), `greensock/gsap-skills` (motion), plus the `impeccable`, `emil-design`, and `hyperframes` skill bundles.

## Gotchas

- The local `copilot-proxy-rs` service must be available at `http://127.0.0.1:8080`.
- HyperFrames HTML-to-video work depends on the HTML being finished first — expect a two-step flow (build the page, then convert it).
