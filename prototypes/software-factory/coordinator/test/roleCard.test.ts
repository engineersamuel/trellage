import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { encode } from "gpt-tokenizer/encoding/o200k_base"
import type { CopilotClient, SessionConfig, Tool } from "@github/copilot-sdk"
import { ConfigStore, setConfigStore } from "../src/config.ts"
import { Factory } from "../src/factory.ts"
import { roleCard } from "../src/roleCard.ts"

const as = <T>(value: unknown): T => value as T

const spawnFactory = () => {
  const f = new Factory({
    SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-role-")),
    SF_MODEL: "gpt-x",
  })
  type Spy = {
    isUiImplement: () => Promise<boolean>
    spawnModel: () => Promise<{ model: string; source: { kind: "pinned" } }>
    prepareSpawn: () => {
      workdir: string
      setup: { skillDirectories: string[]; extraPath: string[]; prefix: string }
      skills: []
    }
    startClient: () => Promise<CopilotClient>
    nativeServes: () => Promise<boolean>
    spawn: Factory["spawn"]
  }
  const spy = f as unknown as Spy
  const configs: SessionConfig[] = []
  const session = {
    send: async () => {},
    disconnect: async () => {},
    setModel: async () => {},
  }
  const client = as<CopilotClient>({
    createSession: async (config: SessionConfig) => (configs.push(config), session),
    stop: async () => {},
  })
  spy.isUiImplement = async () => false
  spy.spawnModel = async () => ({ model: "gpt-x", source: { kind: "pinned" } })
  spy.prepareSpawn = () => ({
    workdir: "/tmp/work",
    setup: { skillDirectories: [], extraPath: [], prefix: "" },
    skills: [],
  })
  spy.startClient = async () => client
  spy.nativeServes = async () => true
  return { f, configs }
}

const tool = (name: string) => as<Tool<Record<string, unknown>>>({ name })
const cardFrom = (config: SessionConfig): string => {
  const text = config.systemMessage?.content ?? ""
  expect(text.match(/<role-card>/g)).toHaveLength(1)
  return text.match(/<role-card>[\s\S]*?<\/role-card>/)?.[0] ?? ""
}

test("AC-1: real worker spawn appends the step role card and stores the byte-identical text", async () => {
  const { f, configs } = spawnFactory()
  const w = await f.spawn({
    id: "w-impl",
    name: "implementer",
    role: "worker",
    step: "implement",
    task: "Fix the parser.\nDetailed acceptance criteria follow.",
    tools: [tool("read_goal"), tool("apply_patch")],
    system: "Existing worker system prompt.",
  })
  const card = cardFrom(configs[0]!)
  expect(configs[0]!.systemMessage?.content).toStartWith("Existing worker system prompt.\n\n<role-card>")
  expect(card).toContain("Purpose: implement: Fix the parser.")
  expect(card).toContain("Do not push, merge or delete branches.")
  expect(card).toContain("Budget: $4")
  expect(card).toContain("Autonomy: Report up every deviation")
  expect(card).toContain("apply_patch, generate_image, read_goal")
  expect(w.summary().roleCard).toBe(card)
  expect(encode(card).length).toBeLessThanOrEqual(200)
})

test("AC-1: a step without a card uses default exclusions", async () => {
  const { f, configs } = spawnFactory()
  await f.spawn({
    id: "w-plan",
    name: "planner",
    role: "worker",
    step: "plan",
    task: "Plan the migration.",
  })
  const card = cardFrom(configs[0]!)
  expect(card).toContain("Purpose: plan: Plan the migration.")
  expect(card).toContain("Do not push, merge or delete branches.")
  expect(card).toContain("Budget: $1.5")
  expect(encode(card).length).toBeLessThanOrEqual(200)
})

test("AC-1: a step-specific verify card reaches the real spawn prompt", async () => {
  const { f, configs } = spawnFactory()
  const w = await f.spawn({
    id: "w-verify",
    name: "verifier",
    role: "worker",
    step: "verify",
    task: "Run the test suite.",
    tools: [tool("read_goal")],
  })
  const card = cardFrom(configs[0]!)
  expect(card).toContain("Do not edit code or tracked files.")
  expect(card).toContain("Budget: $3")
  expect(card).toContain("generate_image, read_goal")
  expect(w.summary().roleCard).toBe(card)
  expect(encode(card).length).toBeLessThanOrEqual(200)
})

test("AC-1: sub-coordinators get no role card", async () => {
  const { f, configs } = spawnFactory()
  const w = await f.spawn({
    id: "sub-plan",
    name: "sub",
    role: "coordinator",
    step: "plan",
    task: "Coordinate the plan.",
  })
  expect(configs[0]!.systemMessage?.content ?? "").not.toContain("<role-card>")
  expect(w.summary().roleCard).toBeNull()
})

test("AC-1: disabled accountability adds no card", async () => {
  const store = new ConfigStore(path.join(mkdtempSync(path.join(tmpdir(), "sf-role-cfg-")), "config.toml"))
  store.current = {
    ...store.current,
    accountability: { ...store.current.accountability, enabled: false },
  }
  setConfigStore(store)
  const { f, configs } = spawnFactory()
  await f.spawn({
    id: "w-off",
    name: "implementer",
    role: "worker",
    step: "implement",
    task: "Fix it.",
  })
  expect(configs[0]!.systemMessage).toBeUndefined()
  expect(f.get("w-off").summary().roleCard).toBeNull()
  store.close()
})

test("role card golden values are stable for step and fallback cards", () => {
  const c = new ConfigStore(path.join(mkdtempSync(path.join(tmpdir(), "sf-role-cfg-")), "config.toml")).current
  expect(roleCard("implement", "Fix the parser.", ["apply_patch", "generate_image"], c)).toStartWith("<role-card>")
  expect(roleCard("verify", "Run the checks.", ["generate_image"], c)).toContain("Do not edit code or tracked files.")
  expect(roleCard("plan", "Plan it.", [], c)).toContain("Do not push, merge or delete branches.")
})
