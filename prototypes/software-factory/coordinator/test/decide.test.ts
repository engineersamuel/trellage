import { afterAll, expect, test } from "bun:test"
import { choice, noul } from "@typesafe-ai/sdk"
import { decisionEngine, decisionLabel, setDecisionEngine, systemOne } from "../src/decide.ts"
import { patched, defaultSettings } from "../src/settings.ts"

const sec = choice("Fix it?", { keep: "Real, fix now.", drop: "Low risk." })

test("settings accept only known engines; default is jev", () => {
  expect(defaultSettings().decisions.engine).toBe("jev")
  expect(patched(defaultSettings(), { decisions: { engine: "microsoft-decision-1" } }).decisions.engine).toBe("microsoft-decision-1")
  expect(() => patched(defaultSettings(), { decisions: { engine: "gpt-5" } })).toThrow(/decisions.engine/)
})

const seen: { path: string; body: any }[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json()
    seen.push({ path: new URL(req.url).pathname, body })
    if (body.state === "fail") return new Response("upstream down", { status: 502 })
    return Response.json({ model: body.model, answers: { ship: { type: "noul", noul: 0.2 }, fix: { type: "choice", choice: "keep", confidence: 0.9, probabilities: { keep: 0.9, drop: 0.1 } } } })
  },
})
afterAll(() => {
  server.stop()
  setDecisionEngine("jev")
})

test("proxy engines get all questions in one /v1/systemone call; swapping applies to the next decision", async () => {
  setDecisionEngine("gpt-6-luna-decisions", `http://127.0.0.1:${server.port}/v1`)
  const q = { state: '{"x":1}', questions: { ship: noul("Ship?"), fix: sec } }
  const a = await systemOne(q)
  expect([a.engine, a.answers.ship!.noul, a.answers.fix!.choice]).toEqual(["gpt-6-luna-decisions", 0.2, "keep"])
  setDecisionEngine("microsoft-decision-1")
  expect(decisionLabel()).toBe("microsoft-decision-1")
  await systemOne(q)
  expect(seen.map((s) => [s.path, s.body.model])).toEqual([["/v1/systemone", "gpt-6-luna-decisions"], ["/v1/systemone", "microsoft-decision-1"]])
  expect(seen[0]!.body).toEqual({ model: "gpt-6-luna-decisions", state: '{"x":1}', questions: q.questions })
  setDecisionEngine("nonsense")
  expect(decisionEngine()).toBe("jev")
})

test("a proxy error throws, so callers keep their fail-safe path", async () => {
  setDecisionEngine("microsoft-decision-1", `http://127.0.0.1:${server.port}/v1`)
  await expect(systemOne({ state: "fail", questions: { ship: noul("Ship?") } })).rejects.toThrow(/microsoft-decision-1 502/)
})

test("a declined question is dropped, so the caller takes its fail-safe path for that one only", () => {
  const { withoutRefusals } = require("../src/decide.ts")
  expect(withoutRefusals({ a: { type: "noul", noul: 0.7 }, b: { type: "refusal", refusal: "declined" } })).toEqual({ answers: { a: { type: "noul", noul: 0.7 } }, refused: ["b"] })
})
