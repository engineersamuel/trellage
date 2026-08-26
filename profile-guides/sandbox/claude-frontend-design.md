---
schemaVersion: 1
capabilities:
- landing-page-design
- ui-design-system-generation
- anti-slop-design-critique
- gsap-motion-animation
- html-to-video-rendering
bestFor:
- Agency-quality landing pages and marketing UI polish with explicit constraints (audience, one CTA, ban
  lists, reference screenshots)
- Motion-heavy frontends needing GSAP animation work plus a taste/anti-slop critique pass
- Turning a finished HTML page or component into a HyperFrames product-launch or PR video
avoidFor:
- Backend-only work
- Short social copy (use claude-social-media instead)
- Quick one-off UI tweaks with no design constraints or polish pass needed
prerequisites: []
workflows:
- id: design-system-pass
  description: Generate or critique a UI design system (styles, palettes, type pairings, stack guidance)
    for a stated audience and constraint set.
  examples:
  - Design a landing page for a fintech SaaS, one CTA, audience is CFOs, no stock photos
  promptTemplate: |
    {{intent}}
- id: anti-slop-review
  description: Run a taste/anti-slop critique pass on a drafted UI to remove generic AI-design tells before
    it ships.
  examples:
  - Review this landing page draft for generic AI-slop patterns and suggest fixes
  promptTemplate: |
    {{intent}}
- id: motion-polish
  description: Add or refine GSAP-driven scroll and interaction motion on an existing frontend as a separate
    polish pass.
  examples:
  - Add a GSAP ScrollTrigger reveal animation to this pricing section
  promptTemplate: |
    {{intent}}
- id: html-to-video
  description: Convert a finished HTML page or component into a HyperFrames product-launch or PR video.
  examples:
  - Turn this landing page into a 30-second product launch video
  promptTemplate: |
    {{intent}}
---

# claude-frontend-design

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

- This is an Opus-routed proxy profile and needs the external `copilot-proxy-rs_default` Docker network, same as other proxy-backed Claude profiles.
- HyperFrames HTML-to-video work depends on the HTML being finished first — expect a two-step flow (build the page, then convert it).
