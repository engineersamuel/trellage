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

export const defaultGuideModelRouting = {
  match: { model: "gpt-5.6-sol", effort: "medium" },
  generate: { model: "gpt-5.6-luna", effort: "medium" },
  optimize: { model: "gpt-5.6-sol", effort: "medium" },
  refine: { model: "gpt-5.6-sol", effort: "medium" },
  enrich: { model: "gpt-5.6-sol", effort: "medium" },
} as const satisfies GuideModelRouting
