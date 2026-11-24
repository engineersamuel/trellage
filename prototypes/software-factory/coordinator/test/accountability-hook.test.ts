import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AccountabilityDb,
  AccountabilityGrades,
  accountabilityWorkerEnd,
  type GradeDeps,
} from "../src/accountability.ts"
import { claudeGate } from "../src/claude.ts"
import { Factory, withToolGuard, Worker } from "../src/factory.ts"
import { factoryConfig } from "../src/config.ts"
import { piToolCallDecision } from "../src/pi.ts"
import { shipBlockers, newSdlc } from "../src/sdlc.ts"

const as = <T>(value: unknown): T => value as T

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const fakeGradeDeps = (f: Factory, db: AccountabilityDb, requested: () => void, pending: Promise<never>) =>
  ({
    store: f.store,
    db,
    config: factoryConfig(),
    available: () => true,
    ask: async () => (requested(), pending),
    publish: () => {},
    dimensions: (owner: string) => ({
      owner,
      thread: null,
      goal: null,
      folderId: null,
      repo: null,
    }),
  }) satisfies GradeDeps

const worker = (id: string) => {
  const w = new Worker(
    id,
    "implementer",
    "worker",
    "native",
    "/tmp/home",
    "Fix it.",
    as<ConstructorParameters<typeof Worker>[6]>({ stop: async () => {} }),
    "gpt-x",
  )
  w.roleCard = "<role-card>\nPurpose: implement: Fix it.\nBudget: $4 USD\nTools: generate_image\n</role-card>"
  w.spec = {
    step: "implement",
    workdir: "/tmp/work",
    skills: [],
    skillDirectories: [],
    extraPath: [],
    tools: [],
    systemPrompt: null,
    sessionId: null,
  }
  w.session = {
    send: async () => {},
    abort: async () => {},
    disconnect: async () => {},
    setModel: async () => {},
  }
  return w
}

test("AC-4 async: stop returns while the grading engine is still unresolved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-hook-stop-"))
  const f = new Factory({ SF_STATE_DIR: dir })
  const db = new AccountabilityDb(path.join(dir, "accountability.db"))
  const engine = deferred<never>()
  let requested = false
  const grades = new AccountabilityGrades(fakeGradeDeps(f, db, () => (requested = true), engine.promise))
  f.onWorkerEnd = accountabilityWorkerEnd(grades, () => true)
  await f.register(worker("w-stop"))
  const outcome = await Promise.race([f.stop("w-stop").then(() => "stopped"), Bun.sleep(100).then(() => "blocked")])
  expect(outcome).toBe("stopped")
  await Bun.sleep(0)
  expect(requested).toBe(true)
  expect(db.get("w-stop")).toBeNull()
  engine.resolve(undefined as never)
})

test("AC-4 async: the idle task-end hook queues once and remains off the event path", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-hook-idle-"))
  const f = new Factory({ SF_STATE_DIR: dir })
  const db = new AccountabilityDb(path.join(dir, "accountability.db"))
  const engine = deferred<never>()
  let requests = 0
  const grades = new AccountabilityGrades(fakeGradeDeps(f, db, () => requests++, engine.promise))
  f.onWorkerEnd = accountabilityWorkerEnd(grades, () => true)
  const w = worker("w-idle")
  await f.register(w)
  w.observe(f, as({ type: "assistant.turn_start", timestamp: "0", data: {} }))
  w.observe(f, as({ type: "session.idle", timestamp: "1", data: {} }))
  expect(w.graded).toBe(true)
  w.observe(f, as({ type: "session.idle", timestamp: "2", data: {} }))
  await Bun.sleep(0)
  expect(requests).toBe(1)
  engine.resolve(undefined as never)
})

test("AC-4 disabled accountability never queues a grade", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-hook-disabled-"))
  const f = new Factory({ SF_STATE_DIR: dir })
  const db = new AccountabilityDb(path.join(dir, "accountability.db"))
  let requests = 0
  const grades = new AccountabilityGrades(fakeGradeDeps(f, db, () => requests++, new Promise<never>(() => {})))
  f.onWorkerEnd = accountabilityWorkerEnd(grades, () => false)
  await f.register(worker("w-disabled"))
  await f.stop("w-disabled")
  expect(requests).toBe(0)
  expect(db.get("w-disabled")).toBeNull()
})

test("AC-2: Claude denial wrapper emits permission.completed with factory feedback", async () => {
  const emitted: unknown[] = []
  const gate = withToolGuard(undefined, claudeGate, (event) => emitted.push(event))
  const result = await gate(
    "Bash",
    { command: "git push origin main" },
    as({ signal: new AbortController().signal, toolUseID: "tool-1" }),
  )
  expect(result?.behavior).toBe("deny")
  expect(emitted).toEqual([
    {
      type: "permission.completed",
      timestamp: expect.any(String),
      data: {
        toolCallId: "tool-1",
        result: {
          kind: "denied-interactively-by-user",
          feedback: expect.stringContaining("Workers never merge"),
        },
      },
    },
  ])
})

test("AC-2: Pi denial path emits the same permission.completed event shape", () => {
  const emitted: unknown[] = []
  const result = piToolCallDecision(
    { toolName: "bash", toolCallId: "tool-pi", input: { command: "git push origin main" } },
    undefined,
    (event) => emitted.push(event),
  )
  expect(result?.block).toBe(true)
  expect(emitted).toEqual([
    {
      type: "permission.completed",
      timestamp: expect.any(String),
      data: {
        toolCallId: "tool-pi",
        result: {
          kind: "denied-interactively-by-user",
          feedback: expect.stringContaining("Workers never merge"),
        },
      },
    },
  ])
})

test("AC-4 record-only: production grades are consumed only by accountability and main wiring", () => {
  const src = path.join(import.meta.dir, "..", "src")
  const imports = readdirSync(src)
    .filter((name) => name.endsWith(".ts") && !["accountability.ts", "main.ts"].includes(name))
    .map((name) => name.slice(0, -3))
  const consumers = imports.filter((name) => {
    const source = readFileSync(path.join(src, `${name}.ts`), "utf8")
    return /from ["']\.\/accountability\.ts["']|db\.get\(["']w/.test(source)
  })
  expect(consumers).toEqual([])
})

test("AC-4 record-only: an all-failed grade cannot change a ship decision", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-record-only-"))
  const f = new Factory({ SF_STATE_DIR: dir })
  const db = new AccountabilityDb(path.join(dir, "accountability.db"))
  const gradeDeps = fakeGradeDeps(f, db, () => {}, new Promise<never>(() => {}))
  const grades = new AccountabilityGrades({
    ...gradeDeps,
    ask: async (request) => ({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [key, { noul: 0, choice: "", confidence: 1, probabilities: {} }]),
      ),
      engine: "fake",
    }),
  })
  const recorded = worker("w-record")
  await f.register(recorded)
  recorded.observe(
    f,
    as({
      type: "assistant.usage",
      timestamp: "1",
      data: {
        model: "gpt-x",
        inputTokens: 1,
        outputTokens: 1,
        copilotUsage: { totalNanoAiu: 6_000_000_000_000 },
      },
    }),
  )
  recorded.observe(
    f,
    as({
      type: "permission.completed",
      timestamp: "2",
      data: { result: { kind: "denied-interactively-by-user", feedback: "No." } },
    }),
  )
  f.publish("coordinator", "factory.evaluation", null, "3", {
    scopeId: "coordinator",
    status: "done",
    verdicts: [{ verdict: "fail" }],
  })
  const before = shipBlockers(newSdlc("scope", "thread"), dir, undefined, true, true)
  await f.stop("w-record")
  const failed = await grades.queue(recorded, "stopped")
  expect(failed.score).toBe(0)
  for (const [control, result] of Object.entries(failed.controls))
    expect(result.result).toBe(control === "4.2" ? "n/a" : "fail")
  expect(shipBlockers(newSdlc("scope", "thread"), dir, undefined, true, true)).toEqual(before)
})
