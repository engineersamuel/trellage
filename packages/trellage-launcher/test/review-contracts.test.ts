import { describe, expect, it } from "vitest"
import {
  assignReviewModels,
  defaultReviewChecks,
  fleetLenses,
  reviewCheckCatalog,
  reviewCoordinatorModel,
  selectReviewChecks,
} from "../src/review-catalog.ts"
import { parseGuideHeadlessArgv } from "../src/guide-api.ts"

describe("shared review catalog", () => {
  it("accepts shared context options and rejects conflicting modes", () => {
    expect(
      parseGuideHeadlessArgv([
        "--review",
        "--base",
        "main",
        "--intent",
        "Preserve behavior",
        "--model",
        "gpt-6-sol",
        "--effort",
        "high",
      ]),
    ).toMatchObject({
      review: true,
      optimizeBase: "main",
      intent: "Preserve behavior",
      model: "gpt-6-sol",
      effort: "high",
    })
    expect(parseGuideHeadlessArgv(["--review", "--intent-stdin"])).toMatchObject({ review: true, intentStdin: true })
    expect(() => parseGuideHeadlessArgv(["--review", "--optimize"])).toThrow("cannot be combined")
    for (const flag of ["--json", "--engagement", "--next-steps"])
      expect(() => parseGuideHeadlessArgv(["--review", flag])).toThrow(/review|optimize|engagement/u)
  })
  it("offers six independent checks with compatible entry defaults", () => {
    expect(reviewCheckCatalog).toHaveLength(6)
    expect(defaultReviewChecks("review")).toEqual([])
    expect(defaultReviewChecks("optimize")).toEqual(["first-principles", "behavior-preservation"])
    expect(selectReviewChecks(reviewCheckCatalog.map((entry) => entry.id))).toEqual(reviewCheckCatalog)
    expect(() => selectReviewChecks([])).toThrow("Select")
    expect(() => selectReviewChecks(["fleet", "fleet"])).toThrow("distinct")
    expect(() => selectReviewChecks(["unknown"])).toThrow("Unsupported")
  })

  it("keeps built-in and skill defaults distinct", () => {
    const models = assignReviewModels([
      "first-principles",
      "behavior-preservation",
      "ponytail",
      "fleet",
      "matt-code-review",
    ])
    expect(models.map((entry) => entry.model)).toEqual([
      { model: "gpt-5.6-sol", effort: "medium" },
      { model: "gpt-5.6-luna", effort: "medium" },
      { model: "claude-opus-5.5", effort: "high" },
      { model: "gpt-6.1-sol", effort: "high" },
      { model: "gpt-6-sol", effort: "low" },
    ])
    expect(models[3]!.workers.map((entry) => entry.name)).toEqual(fleetLenses)
    expect(models[4]!.workers.map((entry) => entry.name)).toEqual(["Standards"])
  })

  it("applies explicit overrides to all selected sessions and guarded workers", () => {
    const model = { model: "explicit-model", effort: "high" } as const
    const assignments = assignReviewModels(
      reviewCheckCatalog.map((entry) => entry.id),
      undefined,
      model,
    )
    for (const assignment of assignments) {
      expect(assignment.model).toEqual(model)
      for (const worker of assignment.workers) expect(worker.model).toEqual(model)
    }
    const effortOnly = assignReviewModels(["fleet"], undefined, { effort: "max" })[0]!
    expect(new Set(effortOnly.workers.map((entry) => entry.model.model)).size).toBe(3)
    expect(effortOnly.workers.every((entry) => entry.model.effort === "max")).toBe(true)
  })

  it("uses Astra max for coordination without losing explicit overrides", () => {
    expect(reviewCoordinatorModel()).toEqual({ model: "gpt-6-astra", effort: "max" })
    expect(reviewCoordinatorModel({ effort: "high" })).toEqual({ model: "gpt-6-astra", effort: "high" })
    expect(reviewCoordinatorModel({ model: "explicit-model" })).toEqual({ model: "explicit-model", effort: "max" })
  })
})
