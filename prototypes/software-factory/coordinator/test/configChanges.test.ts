import { beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigStore, setConfigStore } from "../src/config.ts"
import { APPLY, REJECT, checkProposal, saveProposal, settleProposal, type Proposal } from "../src/configChanges.ts"
import { loadPrompt, userPromptsDir } from "../src/prompt.ts"

let root = ""
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sf-proposal-"))
  process.env.SF_CONFIG = path.join(root, "factory", "config.toml")
  setConfigStore(new ConfigStore(process.env.SF_CONFIG, undefined, path.join(root, "overrides.json")))
})

type ConfigProposal = Extract<Proposal, { kind: "config" }>
const config = (value: unknown): ConfigProposal => ({
  kind: "config",
  key: "review.lens_threshold",
  value: value as number,
  reason: "fewer lenses",
})

test("proposals are checked before they reach the human", () => {
  expect(() => checkProposal(config(0.5))).not.toThrow()
  expect(() => checkProposal(config("0.5"))).toThrow("takes a number")
  expect(() => checkProposal({ ...config(0.5), key: "nope" })).toThrow("unknown config key")
  expect(() => checkProposal({ ...config(0.5), reason: " " })).toThrow("reason is empty")
  const prompt = (name: string, text: string): Proposal => ({ kind: "prompt", name, text, reason: "clearer" })
  expect(() => checkProposal(prompt("jev/lens", "Will a {{focus}} review find a real problem?"))).not.toThrow()
  expect(() => checkProposal(prompt("jev/lens", "Uses {{typo}}"))).toThrow("unknown placeholder {{typo}}")
  expect(() => checkProposal(prompt("../secrets", "x"))).toThrow("unknown prompt")
})

test("only the human's Apply writes a proposal; Reject and unknown decisions change nothing", () => {
  saveProposal(root, "a1", config(0.45))
  expect(settleProposal(root, { id: "a1", answer: REJECT })).toBe("rejected: review.lens_threshold")
  expect(settleProposal(root, { id: "a1", answer: APPLY })).toBeNull()
  expect(settleProposal(root, { id: "other", answer: APPLY })).toBeNull()

  saveProposal(root, "a2", config(0.45))
  expect(settleProposal(root, { id: "a2", answer: APPLY })).toBe("applied: review.lens_threshold = 0.45")
  expect(JSON.parse(readFileSync(path.join(root, "overrides.json"), "utf8"))).toEqual({ "review.lens_threshold": 0.45 })

  saveProposal(root, "a3", { kind: "prompt", name: "jev/growth", text: "Is the growth needed?", reason: "shorter" })
  expect(existsSync(path.join(userPromptsDir(), "jev", "growth.md"))).toBe(false)
  settleProposal(root, { id: "a3", answer: APPLY })
  expect(loadPrompt("jev/growth")).toBe("Is the growth needed?")
})

test("coordinators cannot write the human's factory config folder; other writes and reads pass", async () => {
  const { touchesFactoryConfig } = await import("../src/factory.ts")
  const dir = path.dirname(process.env.SF_CONFIG!)
  expect(touchesFactoryConfig({ kind: "write", fileName: path.join(dir, "config.toml") })).toBe(true)
  expect(touchesFactoryConfig({ kind: "write", fileName: path.join(dir, "prompts", "desk.md") })).toBe(true)
  expect(
    touchesFactoryConfig({ kind: "shell", fullCommandText: "echo x > ~/.config/trellage/factory/config.toml" }),
  ).toBe(true)
  expect(touchesFactoryConfig({ kind: "write", fileName: "/tmp/report.md" })).toBe(false)
  expect(touchesFactoryConfig({ kind: "shell", fullCommandText: "git status" })).toBe(false)
  expect(touchesFactoryConfig({ kind: "read", fileName: path.join(dir, "config.toml") })).toBe(false)
})
