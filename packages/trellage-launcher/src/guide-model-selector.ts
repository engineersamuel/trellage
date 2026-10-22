import { assertLiveProviderAllowed } from "./provider-isolation.ts"
import { automaticGuideModel, type GuideModelConfig } from "./guide-model-routing.ts"

const modelsUrl = "http://127.0.0.1:8080/v1/models"
const maximumInputBytes = 16 * 1024

export interface GuideModelSelectionInput {
  readonly prompt: string
  readonly systemPrompt?: string
  readonly signal?: AbortSignal
}

export type GuideModelSelector = (input: GuideModelSelectionInput) => Promise<string>

// Routing receives excerpts only when the proxy's 16 KiB limit requires it.
// The execution prompt is never shortened.
const excerpt = (text: string, budget: number): string => {
  const bytes = Buffer.from(text)
  if (bytes.length <= budget) return text
  const marker = "\n[Excerpt for model selection; full text supplied at execution]\n"
  const available = budget - Buffer.byteLength(marker) - 8
  return bytes.subarray(0, Math.floor(available * 0.75)).toString("utf8") + marker +
    bytes.subarray(bytes.length - Math.floor(available * 0.25)).toString("utf8")
}

export const guideModelSelectionPrompt = (input: GuideModelSelectionInput): string => {
  const instructions = input.systemPrompt ? `Instructions:\n${excerpt(input.systemPrompt, 4096)}\n\n` : ""
  return instructions + excerpt(input.prompt, maximumInputBytes - Buffer.byteLength(instructions))
}

export type GuideModelFetch = (url: string, options: RequestInit) => Promise<Response>

const fetchModels: GuideModelFetch = (url, options) => {
  assertLiveProviderAllowed("guide model selection")
  return fetch(url, options)
}

/** copilot-proxy-rs owns Jev credentials and selection from its current model catalog. */
export const createGuideModelSelector = (request: GuideModelFetch = fetchModels): GuideModelSelector => async (input) => {
  input.signal?.throwIfAborted()
  const signal = AbortSignal.any([AbortSignal.timeout(25_000), ...(input.signal ? [input.signal] : [])])
  const response = await request(modelsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: guideModelSelectionPrompt(input) }),
    signal,
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Guide model selection failed (HTTP ${response.status}). Check copilot-proxy-rs and its TYPESAFE_API_KEY, then retry.`)
  }
  const result: unknown = await response.json()
  if (typeof result !== "object" || result === null || !("recommended" in result) ||
    typeof result.recommended !== "object" || result.recommended === null || !("id" in result.recommended) ||
    typeof result.recommended.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(result.recommended.id) ||
    result.recommended.id === automaticGuideModel) {
    throw new Error("Guide model selection returned no valid recommended model.")
  }
  return result.recommended.id
}

export const selectGuideModel = createGuideModelSelector()

export const resolveGuideTaskModel = async (
  config: GuideModelConfig,
  input: GuideModelSelectionInput,
  select: GuideModelSelector = selectGuideModel,
): Promise<GuideModelConfig> => {
  input.signal?.throwIfAborted()
  const model = config.model === automaticGuideModel ? await select(input) : config.model
  input.signal?.throwIfAborted()
  return { model, effort: config.effort ?? "medium" }
}
