const draft = {
  artifact: "Parser patch",
  task: "Fix parsing",
  criteria: ["Accept valid input", "Reject malformed input", "Preserve source bytes"],
}
export type Fixture = { id: string; value?: unknown; valid: boolean }
export const guideGoalFixtures: Fixture[] = [
  { id: "omitted", valid: true },
  { id: "minimum-criteria", value: draft, valid: true },
  {
    id: "maximum-criteria",
    value: { ...draft, criteria: Array.from({ length: 32 }, (_, i) => `Criterion ${i}`) },
    valid: true,
  },
  { id: "maximum-artifact", value: { ...draft, artifact: "a".repeat(1000) }, valid: true },
  { id: "maximum-task", value: { ...draft, task: "t".repeat(30000) }, valid: true },
  {
    id: "maximum-criterion",
    value: { ...draft, criteria: ["a".repeat(2000), "B", "C"] },
    valid: true,
  },
  ...[
    ["null", null],
    ["array", []],
    ["missing-artifact", { task: draft.task, criteria: draft.criteria }],
    ["unknown-field", { ...draft, extra: true }],
    ["empty-artifact", { ...draft, artifact: "" }],
    ["artifact-newline", { ...draft, artifact: "a\nb" }],
    ["artifact-over", { ...draft, artifact: "a".repeat(1001) }],
    ["empty-task", { ...draft, task: " " }],
    ["task-over", { ...draft, task: "t".repeat(30001) }],
    ["criteria-type", { ...draft, criteria: "A B C" }],
    ["too-few-criteria", { ...draft, criteria: ["A", "B"] }],
    ["too-many-criteria", { ...draft, criteria: Array.from({ length: 33 }, (_, i) => `Criterion ${i}`) }],
    ["duplicate-criteria", { ...draft, criteria: ["One  criterion", "one criterion", "Third"] }],
    ["criterion-newline", { ...draft, criteria: ["A\nB", "C", "D"] }],
    ["criterion-over", { ...draft, criteria: ["a".repeat(2001), "B", "C"] }],
    ["placeholder", { ...draft, artifact: "[describe exactly what you want produced]" }],
    ["expanded-request-field", { ...draft, maxIterations: 5 }],
  ].map(([id, value]) => ({ id: id as string, value, valid: false })),
]
