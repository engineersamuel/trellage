export const automaticGuideModel = "auto"

export type GuideReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max"

export interface GuideModelConfig<Effort extends string = GuideReasoningEffort> {
  readonly model: string
  readonly effort: Effort
}

export interface GuideModelRouting<Effort extends string = GuideReasoningEffort> {
  readonly match: GuideModelConfig<Effort>
  readonly generate: GuideModelConfig<Effort>
  readonly optimize: GuideModelConfig<Effort>
  readonly refine: GuideModelConfig<Effort>
  readonly enrich: GuideModelConfig<Effort>
}

export type GuideModelPhase = keyof GuideModelRouting

export const guideGoalModelConfig = {
  model: automaticGuideModel,
  effort: "medium",
} as const satisfies GuideModelConfig

export const defaultGuideModelRouting = {
  match: { model: automaticGuideModel, effort: "medium" },
  generate: { model: automaticGuideModel, effort: "medium" },
  optimize: { model: automaticGuideModel, effort: "medium" },
  refine: { model: automaticGuideModel, effort: "medium" },
  enrich: { model: automaticGuideModel, effort: "medium" },
} as const satisfies GuideModelRouting

export const guideModelLabel = (config: GuideModelConfig): string =>
  `${config.model === automaticGuideModel ? "Jev selection" : config.model} (${config.effort})`
