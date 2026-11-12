import { expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PermissionHandler } from "@github/copilot-sdk"
import { Factory, Worker } from "../src/factory.ts"

type Request = Parameters<PermissionHandler>[0]
type Invocation = Parameters<PermissionHandler>[1]
type Client = ConstructorParameters<typeof Worker>[6]
/** Test doubles: only the fields the code under test reads. */
const as = <T>(v: unknown): T => v as T
const shell = (fullCommandText: string) => as<Request>({ kind: "shell", fullCommandText })
const write = as<Request>({ kind: "write" })
const inv = as<Invocation>({ sessionId: "s" })
const decision = (v: unknown) => v as { kind: string; feedback?: string }

const factory = as<Factory>({
  publish: (workerId: string, type: string, agentId: string | null, timestamp: string, data: unknown) => ({
    seq: 0,
    workerId,
    type,
    agentId,
    timestamp,
    data,
  }),
})
const ev = (type: string) => as<Parameters<Worker["observe"]>[1]>({ type, timestamp: "0", data: {} })

test("onDone fires once, on the first idle after the task's turn starts", () => {
  const w = new Worker("w1", "impl", "worker", "native", "/tmp/h", "task", as<Client>({}), "m")
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
  const client = as<Client>({ stop: async () => void stopped.push("client") })
  const w = new Worker("w-1", "impl", "worker", "native", "/tmp/h", "task", client, "m")
  w.session = {
    send: () => Promise.reject(new Error("send failed")),
    disconnect: async () => void stopped.push("session"),
  } as unknown as Worker["session"]
  await expect(f.register(w, "task")).rejects.toThrow("send failed")
  expect([f.workers.has("w-1"), stopped]).toEqual([false, ["session", "client"]])
})

test("a registered worker without a prompt stays registered", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-w-")) })
  const w = new Worker("w-2", "coord", "coordinator", "native", "/tmp/h", null, as<Client>({}), "m")
  expect(await f.register(w)).toBe(w)
  expect(f.workers.get("w-2")).toBe(w)
})

test("Copilot workers get a gate by default: push, merge and delete are rejected, the rest approved", async () => {
  const { workerPermissions } = await import("../src/factory.ts")
  expect(decision(workerPermissions(shell("git push origin main"), inv)).kind).toBe("reject")
  expect(decision(workerPermissions(shell("git -C x branch -D feat"), inv)).kind).toBe("reject")
  expect(decision(workerPermissions(shell("bun test && git merge main"), inv)).kind).toBe("reject")
  expect(workerPermissions(shell("git status"), inv)).toEqual({ kind: "approve-once" })
  expect(workerPermissions(write, inv)).toEqual({ kind: "approve-once" })
})

test("finish workers push only their branch, may edit files, and never merge", async () => {
  const { finishPermissions } = await import("../src/factory.ts")
  const gate = finishPermissions({ id: "a", scopeId: "s", branch: "factory/x", pushes: 0 })
  expect(gate(shell("git push -u origin factory/x"), inv)).toEqual({ kind: "approve-once" })
  expect(gate(shell("gh pr checks --watch"), inv)).toEqual({ kind: "approve-once" })
  expect(decision(gate(shell("git push -u origin factory/y"), inv)).kind).toBe("reject")
  expect(decision(gate(shell("git push --force origin factory/x"), inv)).kind).toBe("reject")
  expect(decision(gate(shell("gh pr merge"), inv)).kind).toBe("reject")
  expect(gate(write, inv)).toEqual({ kind: "approve-once" })
})

test("finish workers may --force-with-lease their branch while the setting is on; unchecking it applies at the next push", async () => {
  const { finishPermissions } = await import("../src/factory.ts")
  let allowed = true
  const gate = finishPermissions(
    { id: "a", scopeId: "s", branch: "factory/x", pushes: 0 },
    () => {},
    5,
    () => allowed,
  )
  const lease = shell("git push --force-with-lease -u origin factory/x")
  expect(gate(lease, inv)).toEqual({ kind: "approve-once" })
  expect(decision(gate(shell("git push --force origin factory/x"), inv)).kind).toBe("reject")
  allowed = false
  expect(decision(gate(lease, inv)).feedback).toContain("turned off --force-with-lease")
})

test("a finish grant allows the first push and 5 fix rounds, then rejects the next push but not other commands", async () => {
  const { finishPermissions, maxFixRounds } = await import("../src/factory.ts")
  const grant = { id: "a", scopeId: "s", branch: "factory/x", pushes: 0 }
  const saved: number[] = []
  const gate = finishPermissions(grant, (g) => saved.push(g.pushes))
  for (let i = 0; i <= maxFixRounds(); i++)
    expect(gate(shell("git push origin factory/x"), inv)).toEqual({ kind: "approve-once" })
  expect(saved).toEqual([1, 2, 3, 4, 5, 6])
  expect(decision(gate(shell("git push origin factory/x"), inv)).feedback).toContain("limit")
  expect(gate(shell("git commit -m fix"), inv)).toEqual({ kind: "approve-once" })
  expect(grant.pushes).toBe(6)
})

test("summary carries the model source; a new worker starts as default", () => {
  const w = new Worker("w-3", "impl", "worker", "native", "/tmp/h", "task", as<Client>({}), "m")
  expect(w.summary().modelSource).toEqual({ kind: "default" })
  w.modelSource = { kind: "routed", by: "jev", confidence: 0.9 }
  expect(w.summary().modelSource).toEqual({ kind: "routed", by: "jev", confidence: 0.9 })
})

test("spawnModel records how the model was picked", async () => {
  type Spy = {
    publish: () => void
    routeModel: () => Promise<{ id: string; confidence: number; routedBy: string } | null>
    spawnModel: (spec: object) => Promise<unknown>
  }
  const f = as<Spy>(new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-m-")), SF_MODEL: "dflt" }))
  f.publish = () => {}
  f.routeModel = async () => ({ id: "gpt-x", confidence: 0.7, routedBy: "jev" })
  expect(await f.spawnModel({ name: "a", role: "worker", task: "t" })).toEqual({
    model: "gpt-x",
    source: { kind: "routed", by: "jev", confidence: 0.7 },
  })
  expect(await f.spawnModel({ name: "a", role: "worker", task: "t", model: "pin" })).toEqual({
    model: "pin",
    source: { kind: "pinned" },
  })
  expect(await f.spawnModel({ name: "a", role: "coordinator", task: "t" })).toEqual({
    model: "dflt",
    source: { kind: "default" },
  })
  f.routeModel = async () => null
  expect(await f.spawnModel({ name: "a", role: "worker", task: "t" })).toEqual({
    model: "dflt",
    source: { kind: "fallback" },
  })
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

test("auto: a Claude model picks the Claude Agent SDK, any other model the Copilot SDK; the step's choice wins", () => {
  const claude = { kind: "claude" as const, profiles: ["default"] }
  const council = { kind: "claude" as const, profiles: ["council"], entry: "/council" }
  const pi = { kind: "pi" as const, profiles: [] }
  expect(workerHarness("auto", "worker", undefined, false, false, "claude-sonnet-5.5")).toEqual(claude)
  expect(workerHarness("auto", "worker", undefined, false, false, "gpt-6-astra")).toBeUndefined()
  expect(workerHarness("auto", "worker", council, false, false, "claude-sonnet-5.5")).toBe(council)
  expect(workerHarness("auto", "worker", pi, false, false, "claude-sonnet-5.5")).toBe(pi)
  expect(workerHarness("copilot", "worker", undefined, false, false, "claude-sonnet-5.5")).toBeUndefined()
  expect(workerHarness("auto", "worker", undefined, true, false, "claude-sonnet-5.5")).toBeUndefined()
  // Desk, General chats and sub-coordinators: Claude model -> Claude SDK, else Copilot SDK.
  expect(workerHarness("auto", "coordinator", undefined, false, false, "claude-opus-5.5")).toEqual(claude)
  expect(workerHarness("auto", "coordinator", undefined, false, true, "claude-opus-5.5")).toEqual(claude)
  expect(workerHarness("auto", "coordinator", undefined, false, false, "gpt-6-astra")).toBeUndefined()
  expect(workerHarness("copilot", "coordinator", undefined, false, true, "claude-opus-5.5")).toEqual(claude)
})

test("stepSkillDir links the step's skills into .claude/skills (no plugin prefix)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-plug-"))
  mkdirSync(path.join(root, "src", "ub-mode"), { recursive: true })
  writeFileSync(path.join(root, "src", "ub-mode", "SKILL.md"), "---\nname: ub-mode\ndescription: x\n---\n")
  const dir = stepSkillDir(path.join(root, "step"), [{ name: "ub-mode", dir: path.join(root, "src", "ub-mode") }])
  expect(existsSync(path.join(dir, ".claude", "skills", "ub-mode", "SKILL.md"))).toBe(true)
})

test("a runtime that exits without a stop ends its workers' turns with an error and unregisters them", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-w-")) })
  const client = as<Client>({})
  const a = new Worker("sub-a", "sub", "coordinator", "native", "/tmp/h", null, client, "m")
  const other = new Worker("w-b", "impl", "worker", "native", "/tmp/h", null, as<Client>({}), "m")
  await f.register(a)
  await f.register(other)
  a.status = "running"
  const idle = a.waitIdle(5_000)
  const exited: string[][] = []
  f.onRuntimeExit = (ids) => exited.push(ids)
  f.runtimeExited(client, "runtime exited (SIGTERM)")
  expect(await idle).toBe(true)
  expect([a.status, a.lastError, f.workers.has("sub-a"), f.workers.has("w-b"), exited]).toEqual([
    "error",
    "runtime exited (SIGTERM)",
    false,
    true,
    [["sub-a"]],
  ])
})

test("a step's subagent model is Jev's pick for the step's route text; none without one or when routing fails", async () => {
  type Spy = {
    publish: () => void
    routeModel: (task: string) => Promise<{ id: string; confidence: number; routedBy: string } | null>
    subagentModel: (spec: object, step: object | null) => Promise<string | null>
    acceptsThinking: (model: string) => Promise<boolean>
  }
  const f = as<Spy>(new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-sub-")) }))
  f.publish = () => {}
  f.acceptsThinking = async () => true
  const asked: string[] = []
  f.routeModel = async (task) => (
    asked.push(task),
    { id: "claude-haiku-5.5", confidence: 0.5, routedBy: "jev", ranked: ["claude-haiku-5.5", "gpt-6-luna"] }
  )
  const spec = { name: "fw", role: "worker", task: "a long task that would hide the hint" }
  expect(await f.subagentModel(spec, { subagentRoute: "Low-cost checks" })).toBe("claude-haiku-5.5")
  expect(asked).toEqual(["Low-cost checks"])
  // Claude Code sends `thinking` to subagents; a model that rejects it is skipped for the next in Jev's ranking.
  f.acceptsThinking = async (m) => m !== "claude-haiku-5.5"
  expect(await f.subagentModel(spec, { subagentRoute: "Low-cost checks" })).toBe("gpt-6-luna")
  f.acceptsThinking = async () => false
  expect(await f.subagentModel(spec, { subagentRoute: "Low-cost checks" })).toBeNull()
  expect(await f.subagentModel(spec, {})).toBeNull()
  expect(await f.subagentModel(spec, null)).toBeNull()
  f.routeModel = async () => null
  expect(await f.subagentModel(spec, { subagentRoute: "Low-cost checks" })).toBeNull()
})

test("routeModel keeps Jev's pick from the copilot-proxy-rs list, even a model native Copilot does not serve", async () => {
  const sent: unknown[] = []
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body))
    return Response.json({
      routed_by: "jev",
      recommended: { id: "gemini-4-argon" },
      confidence: 0.4,
      ranking: [{ id: "gemini-4-argon", probability: 0.4 }],
    })
  }) as unknown as typeof fetch)
  try {
    const f = new Factory({
      SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-r-")),
      SF_PROXY_URL: "http://proxy.test",
    })
    expect(await f.routeModel("t")).toEqual({
      id: "gemini-4-argon",
      confidence: 0.4,
      routedBy: "jev",
      ranked: ["gemini-4-argon"],
    })
    // Agents need a chat model: the router is asked for chat models only.
    expect(sent).toEqual([{ input: "t", type: "chat" }])
  } finally {
    fetchMock.mockRestore()
  }
})

test("a coordinator model of the other SDK stops the coordinator after its turn; the same SDK switches in place", async () => {
  type Spy = {
    workers: Map<string, unknown>
    stop: (id: string) => Promise<void>
    onConfigChanged: () => Promise<void>
  }
  const f = as<Spy>(new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-sdk-")) }))
  const stopped: string[] = []
  const switched: string[] = []
  f.stop = async (id) => void (stopped.push(id), f.workers.delete(id))
  const fake = (id: string, harness: string, model: string) => ({
    id,
    role: "coordinator",
    harness,
    model,
    status: "idle",
    lastMessage: "old answer",
    log: [] as unknown[],
    waitIdle: async () => true,
    // sub-1 answers the handoff question with its summary.
    send: async function (this: { lastMessage: string }) {
      this.lastMessage = `summary of ${id}`
    },
    setModel: async (m: string) => void switched.push(`${id}:${m}`),
  })
  const subModel = (f as unknown as Factory).settings.subAgent.model
  // The sub-coordinator runs in Copilot with an old GPT model; the config says a Claude model.
  f.workers.set("sub-1", fake("sub-1", "copilot", "gpt-old"))
  // A sub-coordinator already in Claude with an old Claude model switches in place.
  f.workers.set("sub-2", fake("sub-2", "claude", "claude-old"))
  await f.onConfigChanged()
  await new Promise((r) => setTimeout(r, 20))
  expect(subModel).toMatch(/^claude/)
  expect(stopped).toEqual(["sub-1"])
  expect(switched).toEqual([`sub-2:${subModel}`])
  // The handoff is saved in its home and given once to the next session with that id.
  const root = (f as unknown as Factory).root
  expect(readFileSync(path.join(root, "sub-1", "handoff.md"), "utf8")).toContain("summary of sub-1")
})

test("handoffTranscript keeps the last turns: messages and tool names, not subagent events", async () => {
  const { handoffTranscript } = await import("../src/factory.ts")
  const event = (type: string, data: unknown, agentId: string | null = null) =>
    ({ seq: 0, workerId: "sub-1", type, agentId, timestamp: "", data }) as never
  const log = [
    event("user.message", { content: "first ask" }),
    event("tool.execution_start", { toolName: "spawn_worker" }),
    event("assistant.message", { content: "inner" }, "sub-agent"),
    event("assistant.message", { content: "done" }),
  ]
  expect(handoffTranscript(log)).toBe("USER: first ask\n(tool spawn_worker)\nYOU: done")
  expect(handoffTranscript(log, 12)).toBe("YOU: done")
})
