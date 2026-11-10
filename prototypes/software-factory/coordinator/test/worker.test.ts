import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, Worker } from "../src/factory.ts"

const factory: any = { publish: (workerId: string, type: string, agentId: string | null, timestamp: string, data: unknown) => ({ seq: 0, workerId, type, agentId, timestamp, data }) }
const ev = (type: string) => ({ type, timestamp: "0", data: {} }) as any

test("onDone fires once, on the first idle after the task's turn starts", () => {
  const w = new Worker("w1", "impl", "worker", "native", "/tmp/h", "task", {} as any, "m")
  const done: string[] = []
  w.onDone = (x) => done.push(x.id)
  w.observe(factory, ev("session.idle"))
  expect(done).toEqual([])
  w.observe(factory, ev("assistant.turn_start"))
  expect(done).toEqual([])
  w.observe(factory, ev("session.idle"))
  w.observe(factory, ev("assistant.turn_start"))
  w.observe(factory, ev("session.idle"))
  expect(done).toEqual(["w1"])
})

test("a worker whose first prompt fails is stopped and unregistered, and the error is rethrown", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-w-")) })
  const stopped: string[] = []
  const client: any = { stop: async () => void stopped.push("client") }
  const w = new Worker("w-1", "impl", "worker", "native", "/tmp/h", "task", client, "m")
  w.session = { send: () => Promise.reject(new Error("send failed")), disconnect: async () => void stopped.push("session") } as any
  await expect(f.register(w, "task")).rejects.toThrow("send failed")
  expect([f.workers.has("w-1"), stopped]).toEqual([false, ["session", "client"]])
})

test("a registered worker without a prompt stays registered", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-w-")) })
  const w = new Worker("w-2", "coord", "coordinator", "native", "/tmp/h", null, {} as any, "m")
  expect(await f.register(w)).toBe(w)
  expect(f.workers.get("w-2")).toBe(w)
})

test("Copilot workers get a gate by default: push, merge and delete are rejected, the rest approved", async () => {
  const { workerPermissions } = await import("../src/factory.ts")
  const inv: any = { sessionId: "s" }
  const shell = (fullCommandText: string): any => ({ kind: "shell", fullCommandText })
  expect((workerPermissions(shell("git push origin main"), inv) as any).kind).toBe("reject")
  expect((workerPermissions(shell("git -C x branch -D feat"), inv) as any).kind).toBe("reject")
  expect((workerPermissions(shell("bun test && git merge main"), inv) as any).kind).toBe("reject")
  expect(workerPermissions(shell("git status"), inv)).toEqual({ kind: "approve-once" })
  expect(workerPermissions({ kind: "write" } as any, inv)).toEqual({ kind: "approve-once" })
})

test("finish workers push only their branch, may edit files, and never merge", async () => {
  const { finishPermissions } = await import("../src/factory.ts")
  const gate = finishPermissions({ id: "a", scopeId: "s", branch: "factory/x", pushes: 0 })
  const inv: any = { sessionId: "s" }
  const shell = (fullCommandText: string): any => ({ kind: "shell", fullCommandText })
  expect(gate(shell("git push -u origin factory/x"), inv)).toEqual({ kind: "approve-once" })
  expect(gate(shell("gh pr checks --watch"), inv)).toEqual({ kind: "approve-once" })
  expect((gate(shell("git push -u origin factory/y"), inv) as any).kind).toBe("reject")
  expect((gate(shell("git push --force origin factory/x"), inv) as any).kind).toBe("reject")
  expect((gate(shell("gh pr merge"), inv) as any).kind).toBe("reject")
  expect(gate({ kind: "write" } as any, inv)).toEqual({ kind: "approve-once" })
})

test("a finish grant allows the first push and 5 fix rounds, then rejects the next push but not other commands", async () => {
  const { finishPermissions, maxFixRounds } = await import("../src/factory.ts")
  const grant = { id: "a", scopeId: "s", branch: "factory/x", pushes: 0 }
  const saved: number[] = []
  const gate = finishPermissions(grant, (g) => saved.push(g.pushes))
  const shell = (fullCommandText: string): any => ({ kind: "shell", fullCommandText })
  for (let i = 0; i <= maxFixRounds(); i++) expect(gate(shell("git push origin factory/x"), {} as any)).toEqual({ kind: "approve-once" })
  expect(saved).toEqual([1, 2, 3, 4, 5, 6])
  expect((gate(shell("git push origin factory/x"), {} as any) as any).feedback).toContain("limit")
  expect(gate(shell("git commit -m fix"), {} as any)).toEqual({ kind: "approve-once" })
  expect(grant.pushes).toBe(6)
})

test("summary carries the model source; a new worker starts as default", () => {
  const w = new Worker("w-3", "impl", "worker", "native", "/tmp/h", "task", {} as any, "m")
  expect(w.summary().modelSource).toEqual({ kind: "default" })
  w.modelSource = { kind: "routed", by: "jev", confidence: 0.9 }
  expect(w.summary().modelSource).toEqual({ kind: "routed", by: "jev", confidence: 0.9 })
})

test("spawnModel records how the model was picked", async () => {
  const f: any = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-m-")), SF_MODEL: "dflt" })
  f.publish = () => {}
  f.routeModel = async () => ({ id: "gpt-x", confidence: 0.7, routedBy: "jev" })
  expect(await f.spawnModel({ name: "a", role: "worker", task: "t" }, "native")).toEqual({ model: "gpt-x", source: { kind: "routed", by: "jev", confidence: 0.7 } })
  expect(await f.spawnModel({ name: "a", role: "worker", task: "t", model: "pin" }, "native")).toEqual({ model: "pin", source: { kind: "pinned" } })
  expect(await f.spawnModel({ name: "a", role: "coordinator", task: "t" }, "native")).toEqual({ model: "dflt", source: { kind: "default" } })
  f.routeModel = async () => null
  expect(await f.spawnModel({ name: "a", role: "worker", task: "t" }, "native")).toEqual({ model: "dflt", source: { kind: "fallback" } })
})

import { stepSkillDir, workerHarness } from "../src/factory.ts"

test("workers.harness: auto keeps the step's choice; a forced SDK applies to workers, never to coordinators or gated workers", () => {
  const council = { kind: "claude" as const, profiles: ["council"], entry: "/council" }
  expect(workerHarness("auto", "worker", undefined)).toBeUndefined()
  expect(workerHarness("auto", "worker", council)).toBe(council)
  expect(workerHarness("claude", "worker", undefined)).toEqual({ kind: "claude", profiles: ["default"] })
  expect(workerHarness("claude", "worker", council)).toBe(council)
  expect(workerHarness("pi", "worker", council)).toEqual({ kind: "pi", profiles: [] })
  expect(workerHarness("copilot", "worker", council)).toBeUndefined()
  expect(workerHarness("claude", "coordinator", undefined)).toBeUndefined()
  expect(workerHarness("claude", "worker", undefined, true)).toBeUndefined()
})

test("stepSkillDir links the step's skills into .claude/skills (no plugin prefix)", () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs")
  const { tmpdir } = require("node:os")
  const path = require("node:path")
  const root = mkdtempSync(path.join(tmpdir(), "sf-plug-"))
  mkdirSync(path.join(root, "src", "ub-mode"), { recursive: true })
  writeFileSync(path.join(root, "src", "ub-mode", "SKILL.md"), "---\nname: ub-mode\ndescription: x\n---\n")
  const dir = stepSkillDir(path.join(root, "step"), [{ name: "ub-mode", dir: path.join(root, "src", "ub-mode") }])
  expect(existsSync(path.join(dir, ".claude", "skills", "ub-mode", "SKILL.md"))).toBe(true)
})
