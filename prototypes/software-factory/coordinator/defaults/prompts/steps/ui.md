+++
order = 4.5
best_for = ["Building or redesigning a web UI: pages, screens, components, styling", "Front-end work where look, accessibility and polish matter"]
avoid_for = ["Back-end, CLI or data work with no user interface", "A one-line style fix"]
skills = ["visual-hierarchy", "typography-scale", "color-system", "layout-grid", "responsive-design", "interfaces-that-feel", "impeccable"]
skill_dirs = ["designer-skills/ui-design/skills", "designer-skills/interaction-design/skills", "impeccable/.claude/skills"]
gate_tools = false
harness = { kind = "claude", profiles = ["default"] }
# The UI skill tournament (t-2026-11-15-f4f711) measured Opus 5.5 with these skills: 88-94% fewer WCAG AA violations than no skill, and visually level or ahead.
model = "claude-opus-5.5"
instructions = "Design before code. Read the skills in this order and apply them: visual-hierarchy (what leads on each screen), typography-scale (type scale and pairing as CSS variables), color-system (semantic palette with accessible contrast as CSS variables), layout-grid (grid, spacing, widths), responsive-design (every screen works on desktop and a 320 px phone), interfaces-that-feel (hover, press, focus and feedback states). Use the same tokens on every screen. Then run the impeccable skill: read its reference/craft-floor.md before writing markup, and after the build refine with its typeset, layout, colorize, light animate and polish playbooks. Do not wait for its interactive init: write PRODUCT.md and DESIGN.md yourself. Before you finish: check every page in a browser at desktop and 320 px, and fix any text contrast below WCAG AA (4.5:1, 3:1 for large text), missing labels, and horizontal overflow. Save the final desktop and 320 px screenshots as PNG in .factory/screenshots/ (git ignores it): the ship card shows them."
+++
Build or change a web user interface with the two skill sets that won the factory's UI skill tournament: Owl-Listener designer-skills (hierarchy, type, colour, layout, responsive, interaction) and Impeccable (craft floor and refine passes). Measured result: accessible by default (WCAG AA), level with or ahead of an unaided model visually.
