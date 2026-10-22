import { defaultGuideModelRouting, type GuideModelConfig, type GuideModelRouting } from "./guide-model-routing.ts"

export interface ReviewChoice {
  readonly id: string
  readonly label: string
  readonly purpose: string
  readonly models: string
  readonly workers: number
}

export const fleetLenses = [
  "Security & Permissions",
  "Logic & Correctness",
  "Resource Safety & Reliability",
  "Network & Input Boundaries",
  "Sandbox Isolation",
  "SDK/API Consistency & Maintainability",
] as const

export const reviewModels = ["claude-opus-5.5", "gpt-6-sol", "grok-4.7"] as const

export const reviewCoordinatorModel = (override: Partial<GuideModelConfig> = {}): GuideModelConfig => ({
  ...defaultGuideModelRouting.optimize,
  ...override,
})

export interface ReviewDefinition {
  readonly id: string
  readonly skill: string
  readonly model: string
  readonly kind: "leaf" | "fleet" | "two-axis"
}

export const reviewCatalog: ReadonlyArray<ReviewDefinition> = Object.freeze([
  { id: "ponytail", skill: "ponytail-review", model: "claude-opus-5.5", kind: "leaf" },
  { id: "fleet", skill: "fleet-review", model: "gpt-6.1-sol", kind: "fleet" },
  { id: "matt-code-review", skill: "code-review", model: "gpt-6-sol", kind: "two-axis" },
])

const reviewLabel = (review: ReviewDefinition): string => {
  if (review.kind === "fleet") return "Fleet Review"
  if (review.kind === "two-axis") return "Matt Pocock Code Review"
  return review.skill === "ponytail-review" ? "Ponytail Review" : review.id
}

const reviewPurpose = (review: ReviewDefinition): string => {
  if (review.kind === "fleet") return "Six complementary code-review lenses"
  if (review.kind === "two-axis") return "Standards review; no verified spec source"
  return review.skill === "ponytail-review" ? "Find removable complexity" : `Run ${review.skill}`
}

export const reviewChoices: ReadonlyArray<ReviewChoice> = reviewCatalog.map((review) => ({
  id: review.id,
  label: reviewLabel(review),
  purpose: reviewPurpose(review),
  models: review.kind === "fleet" ? "Claude Opus 5.5 · GPT-6 Sol · Grok 4.7" : review.model,
  workers: review.kind === "fleet" ? 6 : 1,
}))

export const pinnedFleetModel = (lens: string): string | undefined => {
  const index = fleetLenses.findIndex((name) => name === lens)
  return index < 0 ? undefined : reviewModels[index % reviewModels.length]
}

export const selectReviews = (ids: ReadonlyArray<string>, catalog = reviewCatalog): ReadonlyArray<ReviewDefinition> => {
  if (ids.length === 0 || new Set(ids).size !== ids.length)
    throw new Error("Select one or more distinct review workflows.")
  return ids.map((id) => {
    const review = catalog.find((entry) => entry.id === id)
    if (
      review === undefined ||
      (review.kind === "fleet" && review.skill !== "fleet-review") ||
      (review.kind === "two-axis" && review.skill !== "code-review")
    ) {
      throw new Error(`Unsupported review workflow: ${id}`)
    }
    return review
  })
}

export type ReviewCheckId =
  | "ponytail"
  | "fleet"
  | "matt-code-review"

export interface ReviewCheckDefinition {
  readonly id: ReviewCheckId
  readonly label: string
  readonly purpose: string
  readonly kind: "leaf" | "fleet" | "two-axis"
  readonly evidence: "patch"
  readonly requiresHead: boolean
  readonly maximumFindings: number
}

/** The skill-only catalog above remains the guarded SDK adapter's input. */
export const reviewCheckCatalog: ReadonlyArray<ReviewCheckDefinition> = Object.freeze([
  ...reviewCatalog.map((entry): ReviewCheckDefinition => ({
    id: entry.id as ReviewCheckId,
    label: reviewLabel(entry),
    purpose: reviewPurpose(entry),
    kind: entry.kind,
    evidence: "patch",
    requiresHead: true,
    maximumFindings: 50,
  })),
])

export interface ReviewCheckAssignment {
  readonly id: ReviewCheckId
  readonly model: GuideModelConfig
  readonly workers: ReadonlyArray<{ readonly name: string; readonly model: GuideModelConfig }>
}

export const selectReviewChecks = (ids: ReadonlyArray<string>): ReadonlyArray<ReviewCheckDefinition> => {
  if (ids.length === 0 || new Set(ids).size !== ids.length)
    throw new Error("Select one or more distinct review checks.")
  return ids.map((id) => {
    const check = reviewCheckCatalog.find((entry) => entry.id === id)
    if (!check) throw new Error(`Unsupported review check: ${id}`)
    return check
  })
}

export const assignReviewModels = (
  ids: ReadonlyArray<string>,
  routing: GuideModelRouting = defaultGuideModelRouting,
  override: Partial<GuideModelConfig> = {},
): ReadonlyArray<ReviewCheckAssignment> =>
  selectReviewChecks(ids).map((check) => {
    const defaults = routing.optimize
    const model = { ...defaults, ...override }
    return {
      id: check.id,
      model,
      workers:
        check.kind === "fleet"
          ? fleetLenses.map((name) => ({
              name,
              model,
            }))
          : check.kind === "two-axis"
            ? [{ name: "Standards", model }]
            : [],
    }
  })
