import { afterAll, expect, test } from "bun:test"
import { choice, noul } from "@typesafe-ai/sdk"
import { decisionEngine, decisionLabel, parseProxyAnswer, proxyPrompt, setDecisionEngine, systemOne } from "../src/decide.ts"
import { patched, defaultSettings } from "../src/settings.ts"

const sec = choice("Fix it?", { keep: "Real, fix now.", drop: "Low risk." })

test("choice criteria become lettered options the proxy expands", () => {
  expect(proxyPrompt(sec)).toEqual({ text: "Fix it?\nOption A: Real, fix now.\nOption B: Low risk.", keys: ["keep", "drop"] })
  expect(proxyPrompt(noul("Ship?")).text).toBe("Ship?")
})

test("proxy replies map back to Jev's answer shape", () => {
  expect(parseProxyAnswer(noul("q"), [], "Yes (probability 0.82)").noul).toBe(0.82)
  const a = parseProxyAnswer(sec, ["keep", "drop"], "Option B (0.72); Option A 0.28\nReason: Option B is favored.")
  expect([a.choice, a.confidence, a.probabilities]).toEqual(["drop", 0.72, { keep: 0.28, drop: 0.72 }])
  expect(() => parseProxyAnswer(noul("q"), [], "maybe")).toThrow(/unparsed/)
})

test("settings accept only known engines; default is jev", () => {
  expect(defaultSettings().decisions.engine).toBe("jev")
  expect(patched(defaultSettings(), { decisions: { engine: "microsoft-decision-1" } }).decisions.engine).toBe("microsoft-decision-1")
  expect(() => patched(defaultSettings(), { decisions: { engine: "gpt-5" } })).toThrow(/decisions.engine/)
})

const seen: { model: string; system: string; user: string }[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const b: any = await req.json()
    seen.push({ model: b.model, system: b.messages[0].content, user: b.messages[1].content })
    const content = b.messages[1].content.includes("Option A") ? "Option A (0.90); Option B 0.10" : "No (probability 0.20)"
    return Response.json({ choices: [{ message: { content } }] })
  },
})
afterAll(() => {
  server.stop()
  setDecisionEngine("jev")
})

test("swapping the engine changes the next decision with no restart", async () => {
  setDecisionEngine("gpt-6-luna-decisions", `http://127.0.0.1:${server.port}/v1`)
  const q = { state: '{"x":1}', questions: { ship: noul("Ship?"), fix: sec } }
  const a = await systemOne(q)
  expect([a.engine, a.answers.ship!.noul, a.answers.fix!.choice]).toEqual(["gpt-6-luna-decisions", 0.2, "keep"])
  setDecisionEngine("microsoft-decision-1")
  expect(decisionLabel()).toBe("microsoft-decision-1")
  await systemOne(q)
  expect(seen.map((s) => s.model).sort()).toEqual(["gpt-6-luna-decisions", "gpt-6-luna-decisions", "microsoft-decision-1", "microsoft-decision-1"])
  expect(seen.every((s) => s.system === '{"x":1}')).toBe(true)
  setDecisionEngine("nonsense")
  expect(decisionEngine()).toBe("jev")
})
