import { expect, test } from "vitest"
import { parseSelectionMetadata } from "../src/run-selection.ts"
import { assembleProfileGuide, parseProfileInstructions } from "../src/profile-instructions.ts"
const selection = () => parseSelectionMetadata({ description: "Review", best_for: ["Review a patch"] }, "selection")
const policy = { identity: { surface: "native", harness: "pi", profile: "review" } as const }
const document = (template = "{{intent}}") => `---
schemaVersion: 2
templates:
  review: ${JSON.stringify(template)}
---
Review notes.
`
const workflow = {
  id: "review",
  description: "Review the requested changes",
  examples: ["Review this patch", "Check my changes for regressions"],
}
test("a custom profile without specialized workflows receives an honest task workflow", () => {
  const guide = assembleProfileGuide(selection(), [], undefined, policy)
  expect(guide.schemaVersion).toBe(2)
  expect(guide.workflows).toEqual([
    {
      id: "task",
      description: "Perform the requested task with this profile.",
      examples: [],
      promptTemplate: "{{intent}}",
    },
  ])
  expect(guide.goalExecution).toBeUndefined()
})
test("specialized workflow instructions preserve their exact template and body", () => {
  const instructions = parseProfileInstructions(document("Review {{intent}} carefully."), "guide")
  expect(instructions.body).toBe("Review notes.")
  expect(assembleProfileGuide(selection(), [workflow], instructions, policy).workflows[0]?.promptTemplate).toBe(
    "Review {{intent}} carefully.",
  )
})
test.each(["missing intent", "{{intent}} {{intent}}", "{{intent}} {{secret}}"])(
  "rejects unsafe template %s",
  (template) => {
    expect(() => parseProfileInstructions(document(template), "guide")).toThrow()
  },
)
test("explicit missing workflows do not silently become generic", () => {
  expect(() => assembleProfileGuide(selection(), [workflow], undefined, policy)).toThrow()
  expect(() => assembleProfileGuide(selection(), [], undefined, { ...policy, workflowsDeclared: true })).toThrow()
})
test("duplicate IDs and invalid invocation or goal policies remain rejected", () => {
  const instructions = parseProfileInstructions(document(), "guide")
  expect(() => assembleProfileGuide(selection(), [workflow, workflow], instructions, policy)).toThrow()
  expect(() =>
    assembleProfileGuide(selection(), [{ ...workflow, launchAgent: "bad agent" }], instructions, policy),
  ).toThrow()
  expect(() =>
    assembleProfileGuide(selection(), [workflow], instructions, {
      ...policy,
      goalExecution: { controller: "codex-goal", workflowIds: ["review"] },
    }),
  ).toThrow()
})
test("goal policies cannot declare empty or duplicate workflow sets", () => {
  const instructions = parseProfileInstructions(document(), "guide")
  const codex = { identity: { surface: "native", harness: "codex", profile: "review" } as const }
  for (const workflowIds of [[], ["review", "review"]])
    expect(() =>
      assembleProfileGuide(selection(), [workflow], instructions, {
        ...codex,
        goalExecution: { controller: "codex-goal", workflowIds },
      }),
    ).toThrow()
})

test("instruction documents cannot author duplicate selection metadata", () => {
  expect(() =>
    parseProfileInstructions(document().replace("templates:", "bestFor: [review]\ntemplates:"), "guide"),
  ).toThrow()
})
