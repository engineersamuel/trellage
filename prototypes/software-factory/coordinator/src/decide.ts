// One decision API for every factory judgment (gates, lenses, findings, triage, next step, shadow).
// The engine is read on every call, so a settings change applies to the next decision with no restart.
// Jev and the copilot-proxy-rs decision models (POST /v1/systemone) both take all questions in one call
// and answer in the same shape: { noul } or { choice, confidence, probabilities }.
import { TypeSafeClient, type ChoiceQuestion, type NoulQuestion } from "@typesafe-ai/sdk"
import { jevKey } from "./steps.ts"

import { DECISION_ENGINES } from "./settings.ts"

export type DecisionEngine = string

type Question = NoulQuestion | ChoiceQuestion
/** Jev answer shape; `noul` for yes/no, the rest for choices. Always set for the asked type. */
export type Answer = { noul: number; choice: string; confidence: number; probabilities: Record<string, number> }
export type DecideRequest = { state: string; questions: Record<string, Question>; timeoutMs?: number }

let engine: DecisionEngine = "jev"
let proxyUrl = process.env.SF_PROXY_URL ?? "http://localhost:8080/v1"

/** Called by the factory at start and on every settings change. */
export const setDecisionEngine = (e: string, url?: string): void => {
  engine = DECISION_ENGINES.includes(e) ? e : "jev"
  if (url) proxyUrl = url
}
export const decisionEngine = (): DecisionEngine => engine
/** Short name for reasons shown to people: "Jev" or the model id. */
export const decisionLabel = (): string => (engine === "jev" ? "Jev" : engine)

/** True when the current engine can answer: Jev needs a key; the proxy models need nothing local. */
export const decisionsAvailable = (): boolean => engine !== "jev" || !!jevKey()

/** One copilot-proxy-rs `POST /v1/systemone` call: same request and answer shape as Jev, one upstream request for all questions. */
const askProxy = async (model: string, state: string, questions: Record<string, Question>, timeoutMs: number): Promise<Record<string, Answer>> => {
  const r = await fetch(`${proxyUrl.replace(/\/$/, "")}/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, state, questions }),
  })
  if (!r.ok) throw new Error(`${model} ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const body: any = await r.json()
  return body?.answers ?? {}
}

/** copilot-proxy-rs returns a question the model declined as `{type: "refusal"}` (#63). It is no answer: drop it, so
 * every caller sees a missing answer and takes its per-question fail-safe path. */
export const withoutRefusals = (answers: Record<string, any>): { answers: Record<string, Answer>; refused: string[] } => {
  const refused = Object.keys(answers).filter((k) => answers[k]?.type === "refusal")
  return { answers: Object.fromEntries(Object.entries(answers).filter(([k]) => !refused.includes(k))), refused }
}

/** Ask the current engine. Throws when it is unavailable or fails; callers keep their fail-safe paths. */
export const systemOne = async ({ state, questions, timeoutMs = 10_000 }: DecideRequest): Promise<{ answers: Record<string, Answer>; engine: DecisionEngine; refused?: string[] }> => {
  const e = engine
  if (e === "jev") {
    const apiKey = jevKey()
    if (!apiKey) throw new Error("Jev unavailable: no TYPESAFE_API_KEY")
    const client = new TypeSafeClient({ apiKey, defaultModel: "jev-1.13.0", retry: { maxRetries: 0 }, timeout: timeoutMs, logLevel: "off" })
    const res: any = await client.systemOne({ model: "jev-1.13.0", state, questions: questions as any })
    return { answers: res.answers ?? {}, engine: e }
  }
  return { ...withoutRefusals(await askProxy(e, state, questions, Math.max(timeoutMs, 30_000))), engine: e }
}
