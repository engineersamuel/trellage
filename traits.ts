import { OpenRouterClient, OpenRouterDecisionModel, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { Config, Layer } from "effect"
import type { TraitsConfig } from "traits"

const layerClient = OpenRouterClient.layerConfig({
  apiKey: Config.Redacted("OPENROUTER_API_KEY"),
})

export default {
  layerDecisionModel: OpenRouterDecisionModel.layer({
    model: "~typesafe/jev-latest",
  }).pipe(Layer.provide(layerClient)),
  layerLanguageModel: OpenRouterLanguageModel.layer({
    model: "openai/gpt-6.1-sol",
    config: { strictJsonSchema: true, reasoning: { effort: "low" } },
  }).pipe(Layer.provide(layerClient)),
} satisfies TraitsConfig
