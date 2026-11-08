// One decision API for every factory judgment (gates, lenses, findings, triage, next step, shadow).
// The engine is read on every call, so a settings change applies to the next decision with no restart.
// Jev answers all questions in one call; the copilot-proxy-rs decision models get one request per
// question (in parallel) and answers come back in Jev's shape: { noul } or { choice, confidence, probabilities }.
import { TypeSafeClient, type ChoiceQuestion, type EntryType, type NoulQuestion } from "@typesafe-ai/sdk"
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

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/** User text for one question. Choice criteria become `Option A: ..` lines the proxy expands to one question each. */
const flat = (e: EntryType | undefined): string => (typeof e === "string" ? e : e == null ? "" : JSON.stringify(e)).replace(/\s+/g, " ").trim()
export const proxyPrompt = (q: Question): { text: string; keys: string[] } => {
  if (q.type === "noul") return { text: flat(q.instructions), keys: [] }
  const keys = Object.keys(q.criteria).slice(0, LETTERS.length)
  return { text: `${flat(q.instructions)}\n${keys.map((k, i) => `Option ${LETTERS[i]}: ${flat(q.criteria[k]) || k}`).join("\n")}`, keys }
}

/** Parse the proxy reply: `Yes (probability 0.82)` or `Option B (0.72); Option A 0.28`. */
export const parseProxyAnswer = (q: Question, keys: string[], text: string): Answer => {
  if (q.type === "noul") {
    const m = text.match(/probability\s+([\d.]+)/)
    if (!m) throw new Error(`unparsed decision reply: ${text.slice(0, 120)}`)
    return { noul: Number(m[1]), choice: "", confidence: 0, probabilities: {} }
  }
  const probabilities: Record<string, number> = {}
  for (const m of (text.split("\n")[0] ?? "").matchAll(/Option ([A-Z])\s*\(?([\d.]+)\)?/g)) {
    const k = keys[LETTERS.indexOf(m[1]!)]
    if (k !== undefined) probabilities[k] = Number(m[2])
  }
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  if (!ranked.length) throw new Error(`unparsed decision reply: ${text.slice(0, 120)}`)
  return { noul: Number.NaN, choice: ranked[0]![0], confidence: ranked[0]![1], probabilities }
}

const askProxy = async (model: string, state: string, q: Question, timeoutMs: number): Promise<Answer> => {
  const { text, keys } = proxyPrompt(q)
  const r = await fetch(`${proxyUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, messages: [{ role: "system", content: state }, { role: "user", content: text }] }),
  })
  if (!r.ok) throw new Error(`${model} ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const body: any = await r.json()
  return parseProxyAnswer(q, keys, body?.choices?.[0]?.message?.content ?? "")
}

/** Ask the current engine. Throws when it is unavailable or fails; callers keep their fail-safe paths. */
export const systemOne = async ({ state, questions, timeoutMs = 10_000 }: DecideRequest): Promise<{ answers: Record<string, Answer>; engine: DecisionEngine }> => {
  const e = engine
  if (e === "jev") {
    const apiKey = jevKey()
    if (!apiKey) throw new Error("Jev unavailable: no TYPESAFE_API_KEY")
    const client = new TypeSafeClient({ apiKey, defaultModel: "jev-1.13.0", retry: { maxRetries: 0 }, timeout: timeoutMs, logLevel: "off" })
    const res: any = await client.systemOne({ model: "jev-1.13.0", state, questions: questions as any })
    return { answers: res.answers ?? {}, engine: e }
  }
  const entries = await Promise.all(Object.entries(questions).map(async ([id, q]) => [id, await askProxy(e, state, q, Math.max(timeoutMs, 30_000))] as const))
  return { answers: Object.fromEntries(entries), engine: e }
}
