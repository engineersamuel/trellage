import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Approval } from "../src/approvals.ts"
import { ConfigStore, setConfigStore, snapshotConfig, pinnedConfig } from "../src/config.ts"
import { setDecisionEngine } from "../src/decide.ts"
import {
  checkTemplate,
  defaultPromptsDir,
  hashText,
  loadPrompt,
  parsePromptFile,
  promptErrors,
  snapshotPrompts,
  stalePrompts,
  userCopy,
  userPromptsDir,
  withPinned,
} from "../src/prompt.ts"
import { evaluatePrompt, recordCase } from "../src/promptEval.ts"

let root = ""
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sf-pf-"))
  process.env.SF_CONFIG = path.join(root, "cfg", "config.toml")
  setConfigStore(new ConfigStore(process.env.SF_CONFIG))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const userFile = (name: string, text: string) => {
  const f = path.join(userPromptsDir(), `${name}.md`)
  mkdirSync(path.dirname(f), { recursive: true })
  writeFileSync(f, text)
}

test("front matter is TOML between +++ lines; the body loses one final newline", () => {
  const f = parsePromptFile('+++\ninputs = ["a"]\norder = 2\n+++\nHello {{a}}\n')
  expect(f.meta).toEqual({ inputs: ["a"], order: 2 })
  expect(f.body).toBe("Hello {{a}}")
  expect(parsePromptFile("plain\n")).toMatchObject({ meta: {}, body: "plain" })
})

test("every shipped prompt declares exactly the inputs its body uses (besides config keys)", async () => {
  const { promptNames } = await import("../src/prompt.ts")
  const { configVars } = await import("../src/prompt.ts")
  const { factoryConfig } = await import("../src/config.ts")
  const cfg = new Set(Object.keys(configVars(factoryConfig())))
  for (const name of promptNames()) {
    const f = parsePromptFile(readFileSync(path.join(defaultPromptsDir, `${name}.md`), "utf8"))
    const used = [...f.body.matchAll(/\{\{[#^/]?([\w.-]+)\}\}/g)].map((m) => m[1]!).filter((n) => !cfg.has(n))
    const declared = Array.isArray(f.meta.inputs) ? f.meta.inputs : []
    expect({ name, inputs: [...new Set(used)].sort() }).toEqual({ name, inputs: [...declared].sort() })
  }
})

test("a caller must pass every declared input; a user copy may use only those and config keys", () => {
  expect(() => loadPrompt("jev/lens")).toThrow("caller did not pass focus")
  expect(() => checkTemplate("{{focus}} {{review.max_rounds}}", ["focus"])).not.toThrow()
  expect(() => checkTemplate("{{focus}} {{secret}}", ["focus"])).toThrow("unknown placeholder {{secret}}")
  userFile("jev/lens", "Uses {{secret}}")
  expect(loadPrompt("jev/lens", { focus: "x" })).toContain("Is a review focused on x")
  expect(promptErrors.get("jev/lens")).toContain("{{secret}}")
})

test("a delivery run keeps the prompts and config it pinned; new runs read the edits", () => {
  const promptsId = snapshotPrompts(root)
  const configId = snapshotConfig(root)
  const pinned = pinnedConfig(root, configId)
  userFile("jev/growth", "Edited after the run started.")
  expect(loadPrompt("jev/growth")).toBe("Edited after the run started.")
  const inRun = withPinned(root, { promptsId, configId }, pinned, () => loadPrompt("jev/growth"))
  expect(inRun).toStartWith("The diff grew well past the first implementation.")
  expect(withPinned(root, {}, pinned, () => loadPrompt("jev/growth"))).toBe("Edited after the run started.")
})

test("a user copy records the shipped version it replaced, and is reported stale when the default moves on", () => {
  const copy = userCopy("jev/lens", "My {{focus}} question")
  const shipped = readFileSync(path.join(defaultPromptsDir, "jev/lens.md"), "utf8")
  expect(parsePromptFile(copy).meta).toEqual({ inputs: ["focus"], based_on: hashText(shipped) })
  userFile("jev/lens", copy)
  expect(stalePrompts()).toEqual([])
  userFile("jev/lens", copy.replace(hashText(shipped), "000000000000"))
  expect(stalePrompts()).toEqual([{ name: "jev/lens", basedOn: "000000000000", shipped: hashText(shipped) }])
  expect(loadPrompt("jev/lens", { focus: "tests" })).toBe("My tests question")
})

test("replay: shadow-pick agreement with the human's answers; other prompts count flipped answers", async () => {
  setDecisionEngine("microsoft-decision-1", "http://fake/v1")
  // The fake engine picks option 0 for the current text and option 1 for any text containing "NEW".
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: { body: string }) => {
    const { questions } = JSON.parse(init.body) as { questions: Record<string, { text?: string; question?: string }> }
    const answers = Object.fromEntries(
      Object.entries(questions).map(([k, q]) => {
        const isNew = JSON.stringify(q).includes("NEW")
        return [k, { choice: isNew ? "o1" : "o0", confidence: 1, probabilities: {}, noul: isNew ? 0.9 : 0.1 }]
      }),
    )
    return new Response(JSON.stringify({ answers }))
  }) as never)
  try {
    const answered = (answer: string) =>
      ({
        kind: "approval",
        status: "answered",
        answer,
        options: ["Ship", "Hold"],
        optionDetails: [],
        title: "t",
        context: "c",
        summary: "s",
      }) as unknown as Approval
    const shadow = await evaluatePrompt(
      root,
      [answered("Hold"), answered("Hold"), answered("Ship")],
      "jev/shadow-pick",
      "old",
      "NEW",
    )
    expect(shadow).toEqual({ kind: "agreement", cases: 3, current: 1, proposed: 2 })
    recordCase({ prompt: "jev/growth", vars: {}, state: "{}", answer: 0.1 }, root)
    recordCase({ prompt: "jev/growth", vars: {}, state: "{}", answer: 0.1 }, root)
    expect(await evaluatePrompt(root, [], "jev/growth", "old", "NEW")).toEqual({
      kind: "stability",
      cases: 2,
      changed: 2,
    })
    expect((await evaluatePrompt(root, [], "desk", "a", "b")).kind).toBe("skipped")
  } finally {
    fetchMock.mockRestore()
    setDecisionEngine("jev")
  }
})

test("coordinator models have one home: an old settings.json value moves to a config override; UI changes write there", async () => {
  const { Factory } = await import("../src/factory.ts")
  const state = path.join(root, "state")
  mkdirSync(state, { recursive: true })
  writeFileSync(
    path.join(state, "settings.json"),
    JSON.stringify({ agent: { model: "gpt-old" }, subAgent: { model: "opus-old" } }),
  )
  const store = new ConfigStore(process.env.SF_CONFIG, undefined, path.join(state, "config-overrides.json"))
  setConfigStore(store)
  const f = new Factory({ SF_STATE_DIR: state })
  expect([f.settings.agent.model, f.settings.subAgent.model]).toEqual(["gpt-old", "opus-old"])
  expect(store.values().find((v) => v.key === "models.coordinator")).toMatchObject({
    value: "gpt-old",
    source: "override",
  })
  const saved = JSON.parse(readFileSync(path.join(state, "settings.json"), "utf8"))
  expect([saved.agent.model, saved.subAgent.model]).toEqual([undefined, undefined])

  store.setOverride("models.coordinator", null)
  expect(f.settings.agent.model).toBe("gpt-6-astra")
  await f.updateSettings({ subAgent: { model: "claude-x" } })
  expect(store.current.models.sub_coordinator).toBe("claude-x")
  expect(JSON.parse(readFileSync(path.join(state, "settings.json"), "utf8")).subAgent.model).toBeUndefined()
})
