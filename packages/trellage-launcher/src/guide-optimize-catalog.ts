// The Optimize skill catalog. No imports, so other packages (the software factory) can reuse it.
/** One Optimize skill: a standing instruction an agent applies to the whole repository. */
export interface GuideOptimizeSkill {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly prompt: string
  /** Skills loaded into a harness run, as `owner/repo:name` for `trx run --skill`. */
  readonly harnessSkills?: ReadonlyArray<string>
}

export const guideOptimizeSkills: ReadonlyArray<GuideOptimizeSkill> = [
  {
    id: "first-principles",
    title: "First principles",
    description: "Challenge assumptions. Prefer deletion, then simplification. Leave good code alone.",
    prompt:
      "Review the implementation from first principles. Challenge weak assumptions and unnecessary complexity. Find only high-impact opportunities to delete or simplify. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. It is valid to recommend no change.",
  },
  {
    id: "behavior-preservation",
    title: "Behavior preservation",
    description: "Protect requirements, edge cases, and existing behavior.",
    prompt:
      "Check the implementation against the repository contracts and relevant tests. Find concrete behavioral risks and simpler alternatives that preserve requirements. Do not manufacture objections. A necessary safeguard is not needless complexity.",
  },
  {
    id: "improve-codebase-architecture",
    title: "Improve codebase architecture",
    description: "Matt Pocock's skill: deepen modules, improve locality, and remove shallow layers.",
    harnessSkills: ["mattpocock/skills:improve-codebase-architecture", "mattpocock/skills:codebase-design"],
    prompt:
      "Use the improve-codebase-architecture and codebase-design skills (invoke them; they are loaded). Deepen shallow modules, improve locality, and remove layers that only pass calls through. Read GLOSSARY.md and relevant ADRs if present. State ADR conflicts instead of overriding them.",
  },
  {
    id: "ui-css",
    title: "UI and CSS",
    description: "Modern CSS from good-css.com: intrinsic layout, focus, motion, and color.",
    prompt: [
      "Review the repository's stylesheets and UI markup (CSS, HTML, JSX, TSX). If there are none, report that and stop.",
      "Read https://good-css.com and its linked entries when network access is available. Apply its rules, including:",
      "- Set min-width: 0 where flex or grid children overflow.",
      "- Prefer intrinsic layout (clamp(), auto-fit grids, container queries) over breakpoint ladders.",
      "- Use logical properties (inline, block) instead of left, right, top, and bottom.",
      "- Use :focus-visible and never remove outlines without a replacement.",
      "- Guard motion with @media (prefers-reduced-motion: no-preference).",
      "- Use :user-invalid for form feedback, :has() for parent state, and @starting-style for entry transitions.",
      "- Use OKLCH colors and color-mix() for consistent palettes; text-wrap: pretty or balance for text.",
      "Rank the improvements by user impact. Prefer CSS over JavaScript when both work.",
    ].join("\n"),
  },
]
