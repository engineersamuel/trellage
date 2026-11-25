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

type AskResult = Awaited<ReturnType<NonNullable<GradeDeps["ask"]>>>

const fakeGradeDeps = (f: Factory, db: AccountabilityDb, requested: () => void, pending: Promise<AskResult>) =>
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
  const engine = deferred<AskResult>()
  let requested = false
  const grades = new AccountabilityGrades(fakeGradeDeps(f, db, () => (requested = true), engine.promise))
  f.onWorkerEnd = accountabilityWorkerEnd(grades, () => true)
  await f.register(worker("w-stop"))
  const outcome = await Promise.race([f.stop("w-stop").then(() => "stopped"), Bun.sleep(100).then(() => "blocked")])
  expect(outcome).toBe("stopped")
  await Bun.sleep(0)
  expect(requested).toBe(true)
  expect(db.get("w-stop")).toBeNull()
  engine.resolve({
    answers: Object.fromEntries(
      ["purpose", "content", "intent", "report"].map((key) => [
        key,
        { noul: 0.9, choice: "", confidence: 1, probabilities: {} },
      ]),
    ),
    engine: "fake",
  })
  for (let i = 0; i < 100 && db.get("w-stop") === null; i++) await Bun.sleep(1)
  expect(db.get("w-stop")).toMatchObject({
    worker: "w-stop",
    score: 1,
    controls: {
      "3.1": { result: "pass", p: 0.9 },
      "4.6": { result: "pass", p: 0.9 },
      "4.7": { result: "pass", p: 0.9 },
      "5.2/6.3": { result: "pass", p: 0.9 },
    },
  })
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

test("AC-4 record-only: production grades are consumed only by accountability, main wiring and R31", () => {
  const src = path.join(import.meta.dir, "..", "src")
  const imports = readdirSync(src)
    .filter((name) => name.endsWith(".ts") && !["accountability.ts", "main.ts", "cos.ts"].includes(name))
    .map((name) => name.slice(0, -3))
  const consumers = imports.filter((name) => {
    const source = readFileSync(path.join(src, `${name}.ts`), "utf8")
    return /from ["']\.\/accountability\.ts["']|db\.get\(["']w/.test(source)
  })
  expect(consumers).toEqual([])
})

test("AC-4 record-only: passing, failing and unavailable grades preserve run and ship state", async () => {
  const run = {
    ...newSdlc("scope", "thread"),
    startedAt: 1,
    criteria: ["tests added"],
    checks: ["bun test"],
    implementDoneAt: 2,
    verifyDoneAt: 3,
    gates: [
      {
        id: "design" as const,
        chosen: true,
        probability: 0.9,
        threshold: 0.5,
        reason: "test",
        status: "done" as const,
      },
    ],
  }
  const snapshots: unknown[] = []

  for (const [name, answer] of [
    ["pass", 1],
    ["fail", 0],
    ["unknown", new Error("engine unavailable")],
  ] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), `sf-record-only-${name}-`))
    const f = new Factory({ SF_STATE_DIR: dir })
    const db = new AccountabilityDb(path.join(dir, "accountability.db"))
    const grades = new AccountabilityGrades({
      ...fakeGradeDeps(f, db, () => {}, new Promise<never>(() => {})),
      ask: async (request) => {
        if (answer instanceof Error) throw answer
        return {
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              { noul: answer, choice: "", confidence: 1, probabilities: {} },
            ]),
          ),
          engine: "fake",
        }
      },
    })
    const recorded = worker(`w-${name}`)
    f.sdlc.set("scope", { ...run, gates: run.gates.map((gate) => ({ ...gate })) })
    const blockersBefore = shipBlockers(f.sdlc.get("scope"), dir, undefined, true, true)
    await f.register(recorded)
    await f.stop(recorded.id)
    const result = await grades.queue(recorded, "stopped")
    const blockersAfter = shipBlockers(f.sdlc.get("scope"), dir, undefined, true, true)
    expect(result.controls["3.1"].result).toBe(name === "unknown" ? "unknown" : name)
    expect(blockersAfter).toEqual(blockersBefore)
    snapshots.push({
      run: f.sdlc.get("scope"),
      gates: f.sdlc.get("scope")?.gates,
      blockers: blockersAfter,
      ship: blockersAfter.length === 0,
    })
  }

  expect(snapshots[1]).toEqual(snapshots[0])
  expect(snapshots[2]).toEqual(snapshots[0])
})
