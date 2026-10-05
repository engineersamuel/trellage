export const guideOptimizeReviewers = [
  {
    id: "first-principles",
    title: "First principles",
    description: "Challenge assumptions. Prefer deletion, then simplification. Leave good code alone.",
    prompt:
      "Review the implementation from first principles. Challenge weak assumptions and unnecessary complexity. Find only high-impact opportunities to delete or simplify. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. Do not edit files. It is valid to recommend no change.",
  },
  {
    id: "behavior-preservation",
    title: "Behavior preservation",
    description: "Protect requirements, edge cases, and existing behavior.",
    prompt:
      "Independently review the changed implementation against the task, repository contracts, and relevant tests. Find concrete behavioral risks and simpler alternatives that preserve requirements. Do not manufacture objections or edit files. A necessary safeguard is not needless complexity.",
  },
  {
    id: "improve-codebase-architecture",
    title: "Improve codebase architecture",
    description: "Matt Pocock's managed skill: deepen modules, improve locality, and remove shallow layers.",
    prompt:
      "Read @skill/improve-codebase-architecture and @skill/codebase-design. Apply the managed skills' exploration criteria and architecture vocabulary to the selected changes. Read GLOSSARY.md and relevant ADRs if present. Guide adapts this skill to a read-only review: return the requested JSON, not HTML; do not open a browser, spawn agents, ask questions, or write domain files. State questions and ADR conflicts as risks or limitations. The user must approve a finding before implementation. Do not invent interfaces or expand the edit scope.",
  },
] as const
