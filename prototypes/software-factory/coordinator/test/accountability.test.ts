import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AccountabilityDb,
  accountabilityDimensions,
  accountabilityEvaluation,
  extract,
  gradeWorker,
  workerBudgets,
  type GradeDeps,
} from "../src/accountability.ts"
import { EventStore } from "../src/events.ts"
import type { FeedEvent } from "../src/factory.ts"
import { factoryConfig } from "../src/config.ts"
import type { DecideRequest } from "../src/decide.ts"
import type { ControlId } from "../../shared/accountability.ts"
import { Threads } from "../src/threads.ts"

const root = () => mkdtempSync(path.join(tmpdir(), "sf-accountability-"))
const feed = (seq: number, type: string, data: unknown, agentId: string | null = null): FeedEvent => ({
  seq,
  workerId: "w-1",
  type,
  agentId,
  timestamp: `2026-11-20T12:${String(seq % 60).padStart(2, "0")}:00.000Z`,
  data,
})

const started = {
  id: "w-1",
  role: "worker",
  step: "implement",
  model: "gpt-x",
  modelSource: { kind: "pinned" },
  harness: "copilot",
  task: "Fix the parser.",
  roleCard:
    "<role-card>\nPurpose: implement: Fix the parser.\nExclusions: Do not push, merge or delete branches.\nBudget: $4 USD\nTools: apply_patch, generate_image, read_goal\n</role-card>",
  owner: "sub-12345678",
  startedAt: 1,
}

const fixture = (
  options: {
    cost?: number
    denied?: number
    evaluation?: boolean
    owner?: string
    evaluationVerdict?: "pass" | "fail"
  } = {},
) => {
  const dir = root()
  const store = new EventStore(path.join(dir, "events.db"))
  let seq = 1
  const owner = options.owner ?? started.owner
  store.append(feed(seq++, "factory.worker_started", { ...started, owner }))
  store.append(
    feed(seq++, "assistant.usage", {
      model: "gpt-x",
      inputTokens: 100,
      outputTokens: 10,
      copilotUsage: { totalNanoAiu: (options.cost ?? 1) * 100_000_000_000 },
    }),
  )
  store.append(
    feed(seq++, "tool.execution_start", {
      toolCallId: "t1",
      toolName: "apply_patch",
      arguments: { path: "a" },
    }),
  )
  store.append(feed(seq++, "tool.execution_complete", { toolCallId: "t1", success: true, result: "" }))
  for (let i = 0; i < (options.denied ?? 0); i++)
    store.append(
      feed(seq++, "permission.completed", {
        toolCallId: `d${i}`,
        result: { kind: "denied-interactively-by-user", feedback: "Workers never push." },
      }),
    )
  store.append(feed(seq++, "assistant.message", { content: "Done; tests passed." }))
  if (options.evaluation !== false)
    store.append(
      feed(seq++, "factory.evaluation", {
        scopeId: owner,
        status: "done",
        verdicts: [{ id: "AC-1", verdict: options.evaluationVerdict ?? "pass" }],
      }),
    )
  store.append(feed(seq++, "factory.worker_stopped", { id: "w-1" }))
  const db = new AccountabilityDb(path.join(dir, "accountability.db"))
  return { dir, store, db }
}

const fakeAsk = async (request: DecideRequest) => ({
  answers: Object.fromEntries(
    Object.keys(request.questions).map((key) => [key, { noul: 0.8, choice: "", confidence: 1, probabilities: {} }]),
  ),
  engine: "fake",
})

const deps = (x: ReturnType<typeof fixture>, ask: GradeDeps["ask"] = fakeAsk): GradeDeps => ({
  store: x.store,
  db: x.db,
  config: factoryConfig(),
  available: () => true,
  ask,
  publish: () => {},
  dimensions: () => ({
    owner: started.owner,
    thread: "thread-1",
    goal: "goal-1",
    folderId: "repo-1",
    repo: "/tmp/repo-1",
  }),
})

test("AC-2: grading persists all controls, decision probabilities, exact score and publish event", async () => {
  const x = fixture()
  let calls = 0
  let state = ""
  const published: unknown[] = []
  const d = deps(x, async (request) => {
    calls++
    state = request.state
    expect(Object.keys(request.questions)).toEqual(["purpose", "content", "intent", "report"])
    return fakeAsk(request)
  })
  d.publish = (worker, type, data) => published.push({ worker, type, data })
  const grade = await gradeWorker(d, "w-1")
  expect(calls).toBe(1)
  expect(state).toContain("Fix the parser.")
  expect(grade.controls).toEqual(
    expect.objectContaining({
      "3.5": { result: "pass", value: 1 },
      "4.8": { result: "pass", value: 0 },
      "4.9": { result: "pass", value: 0 },
      "5.5": { result: "pass", value: 1 },
      "4.2": { result: "n/a", value: 1 / 3 },
    }),
  )
  for (const id of ["3.1", "4.6", "4.7", "5.2/6.3"] as ControlId[])
    expect(grade.controls[id]).toEqual({ result: "pass", p: 0.8 })
  expect(grade.score).toBe(1)
  expect(x.db.get("w-1")).toEqual(grade)
  expect(x.db.rows()).toHaveLength(1)
  expect(published).toEqual([
    {
      worker: "w-1",
      type: "factory.accountability_graded",
      data: expect.objectContaining({ worker: "w-1", score: 1, graderVersion: expect.any(String) }),
    },
  ])
})

test("AC-2: over-budget and a guard refusal fail their code controls", async () => {
  const over = fixture({ cost: 6 })
  const denied = fixture({ denied: 1 })
  expect((await gradeWorker(deps(over), "w-1")).controls["3.5"].result).toBe("fail")
  const deniedGrade = await gradeWorker(deps(denied), "w-1")
  expect(deniedGrade.controls["4.8"]).toEqual({ result: "fail", value: 1 })
  expect(deniedGrade.controls["4.9"]).toEqual({ result: "fail", value: 1 })
  expect(deniedGrade.score).toBe(6 / 8)
})

test("AC-2: a config budget change after spawn does not replace the recorded role-card budget", async () => {
  const x = fixture({ cost: 6 })
  const base = factoryConfig()
  const changed = {
    ...base,
    accountability: {
      ...base.accountability,
      worker_usd: { ...base.accountability.worker_usd, implement: 100 },
    },
  }
  const grade = await gradeWorker({ ...deps(x), config: changed }, "w-1")
  expect(grade.budgetUsd).toBe(4)
  expect(grade.controls["3.5"]).toEqual({ result: "fail", value: 6 })
})

test("AC-2: grading retains start metadata from a 20004-event worker log after the store reopens and prunes", async () => {
  const dir = root()
  const store = new EventStore(path.join(dir, "events.db"))
  store.append(feed(1, "factory.worker_started", started))
  for (let seq = 2; seq <= 20003; seq++) {
    store.append(feed(seq, "assistant.turn_start", {}))
  }
  store.append(feed(20004, "factory.worker_stopped", { id: "w-1" }))
  // Reopening prunes to KEEP_PER_WORKER rows per worker; the start record must survive it.
  store.close()
  const reopened = new EventStore(path.join(dir, "events.db"))
  const db = new AccountabilityDb(path.join(dir, "accountability.db"))
  const grade = await gradeWorker(
    {
      store: reopened,
      db,
      config: factoryConfig(),
      available: () => true,
      ask: fakeAsk,
      publish: () => {},
      dimensions: () => ({
        owner: started.owner,
        thread: "thread-1",
        goal: "goal-1",
        folderId: "repo-1",
        repo: "/tmp/repo-1",
      }),
    },
    "w-1",
  )
  expect(grade.worker).toBe("w-1")
  expect(db.rows()).toHaveLength(1)
})

test("AC-2: engine error makes all decision controls unknown and excludes them from score", async () => {
  const x = fixture()
  const grade = await gradeWorker(
    deps(x, async () => {
      throw new Error("engine down")
    }),
    "w-1",
  )
  for (const id of ["3.1", "4.6", "4.7", "5.2/6.3"] as ControlId[])
    expect(grade.controls[id]).toEqual({ result: "unknown" })
  expect(grade.score).toBe(1)
})

test("AC-2: an engine refusal leaves each missing decision unknown", async () => {
  const x = fixture()
  const grade = await gradeWorker(
    deps(x, async () => ({
      answers: {},
      engine: "fake",
      refused: ["purpose", "content", "intent", "report"],
    })),
    "w-1",
  )
  for (const id of ["3.1", "4.6", "4.7", "5.2/6.3"] as ControlId[])
    expect(grade.controls[id]).toEqual({ result: "unknown" })
})

test("AC-2: a re-grade replaces one row and labels survive reopening the database", async () => {
  const x = fixture()
  const d = deps(x)
  await gradeWorker(d, "w-1")
  await gradeWorker(d, "w-1")
  expect(x.db.rows()).toHaveLength(1)
  x.db.label("w-1", "3.1", "pass", 123)
  x.db.close()
  const reopened = new AccountabilityDb(path.join(x.dir, "accountability.db"))
  expect(reopened.labels()).toEqual([{ worker: "w-1", control: "3.1", label: "pass", at: 123 }])
  expect(reopened.get("w-1")?.worker).toBe("w-1")
  reopened.close()
})

test("AC-2: unavailable evaluator is n/a, then a code-only patch sets 5.5 and score", async () => {
  const x = fixture({ evaluation: false })
  let calls = 0
  const grade = await gradeWorker(
    deps(x, async (request) => {
      calls++
      return fakeAsk(request)
    }),
    "w-1",
  )
  expect(grade.controls["5.5"]).toEqual({ result: "n/a", value: 0 })
  const published: unknown[] = []
  const count = accountabilityEvaluation(x.db, (worker, type, data) => published.push({ worker, type, data }))(
    feed(100, "factory.evaluation", {
      scopeId: "sub-12345678",
      status: "done",
      verdicts: [{ id: "AC-1", verdict: "fail" }],
    }),
  )
  expect(count).toBe(1)
  expect(calls).toBe(1)
  expect(x.db.get("w-1")?.controls["5.5"]).toEqual({ result: "fail", value: 1 })
  expect(x.db.get("w-1")?.score).toBe(7 / 8)
  expect(published).toHaveLength(1)
})

test("AC-2: production dimensions keep the scope owner for existing and later evaluations", async () => {
  const threadRoot = root()
  const threads = new Threads(threadRoot)
  const folder = threads.addFolder(path.resolve(import.meta.dir, "../../.."))
  const thread = threads.create("Fix the parser", folder.id)
  threads.setMeta(thread.id, { goalId: "goal-1" })
  const owner = `sub-${thread.id.slice(0, 8)}`
  const x = fixture({ owner, evaluationVerdict: "fail" })
  const dimensions = accountabilityDimensions(threads)(owner)
  expect(dimensions).toEqual({
    owner,
    thread: thread.id,
    goal: "goal-1",
    folderId: folder.id,
    repo: folder.path,
  })
  const d = { ...deps(x), dimensions: accountabilityDimensions(threads) }
  const grade = await gradeWorker({ ...d, dimensions: () => dimensions }, "w-1")
  expect(grade.owner).toBe(owner)
  expect(grade.controls["5.5"]).toEqual({ result: "fail", value: 1 })

  const laterState = root()
  const laterThreads = new Threads(laterState)
  const laterFolder = laterThreads.addFolder(path.resolve(import.meta.dir, "../../.."))
  const laterThread = laterThreads.create("Later evaluation", laterFolder.id)
  const laterOwner = `sub-${laterThread.id.slice(0, 8)}`
  const noEvaluation = fixture({ evaluation: false, owner: laterOwner })
  const later = await gradeWorker(
    {
      ...deps(noEvaluation),
      dimensions: accountabilityDimensions(laterThreads),
    },
    "w-1",
  )
  expect(later.owner).toBe(laterOwner)
  expect(later.controls["5.5"].result).toBe("n/a")
  expect(
    accountabilityEvaluation(noEvaluation.db, () => {})(
      feed(100, "factory.evaluation", {
        scopeId: laterOwner,
        status: "done",
        verdicts: [{ id: "AC-1", verdict: "fail" }],
      }),
    ),
  ).toBe(1)
  expect(noEvaluation.db.get("w-1")?.controls["5.5"]).toEqual({ result: "fail", value: 1 })
})

test("AC-3: the extract sent to the engine is bounded, action-focused and redacted", async () => {
  const credential = ["ghp", "abcdefghijklmnopqrstuvwxyz123456789"].join("_")
  const log: FeedEvent[] = [
    feed(1, "factory.worker_started", started),
    feed(2, "tool.execution_start", {
      toolCallId: "head",
      toolName: "head_tool",
      arguments: JSON.stringify({ token: credential }),
    }),
  ]
  for (let i = 3; i < 5000; i++)
    log.push(
      feed(i, "tool.execution_start", {
        toolCallId: `t${i}`,
        toolName: `middle_${i}`,
        arguments: "x".repeat(500),
      }),
    )
  log.push(
    feed(5000, "assistant.reasoning", { content: "REASONING_SENTINEL_DO_NOT_SEND" }),
    feed(5001, "permission.completed", {
      toolCallId: "refused",
      result: { kind: "denied-interactively-by-user", feedback: "REFUSAL_SENTINEL" },
    }),
    feed(5002, "tool.execution_start", {
      toolCallId: "tail",
      toolName: "tail_tool",
      arguments: "tail args",
    }),
    feed(5003, "assistant.message", { content: "FINAL_SENTINEL" }),
  )
  expect(JSON.stringify(log).length).toBeGreaterThan(2 * 1024 * 1024)
  const text = extract(log, started.roleCard, started.task, 1.25, factoryConfig().accountability)
  expect(text.length).toBeLessThanOrEqual(15000)
  expect(text).toContain("head_tool")
  expect(text).toContain("tail_tool")
  expect(text).toContain("REFUSAL_SENTINEL")
  expect(text).toContain("FINAL_SENTINEL")
  expect(text).toContain("$1.25")
  expect(text).not.toContain("REASONING_SENTINEL_DO_NOT_SEND")
  expect(text).not.toContain(credential)
  expect(text).toContain("[REDACTED credential]")

  const dir = root()
  const store = new EventStore(path.join(dir, "events.db"))
  for (const event of log) store.append(event)
  store.append(feed(5004, "factory.worker_stopped", { id: "w-1" }))
  const db = new AccountabilityDb(path.join(dir, "accountability.db"))
  let sent = ""
  await gradeWorker(
    {
      store,
      db,
      config: factoryConfig(),
      available: () => true,
      ask: async (request) => {
        sent = request.state
        return fakeAsk(request)
      },
      publish: () => {},
      dimensions: () => ({
        owner: "sub-12345678",
        thread: "thread-1",
        goal: null,
        folderId: "repo-1",
        repo: "/tmp/repo-1",
      }),
    },
    "w-1",
  )
  expect(sent).toBe(db.get("w-1")!.extract)
  expect(sent).toContain("head_tool")
  expect(sent).toContain("tail_tool")
  expect(sent).toContain("REFUSAL_SENTINEL")
  expect(sent).toContain("FINAL_SENTINEL")
  expect(sent).not.toContain("REASONING_SENTINEL_DO_NOT_SEND")
  expect(sent).not.toContain(credential)
  expect(sent).toContain("[REDACTED credential]")
  expect(sent.length).toBeLessThanOrEqual(15000)
})

test("AC-3: grading sends the bounded extract through the real decision request", async () => {
  const x = fixture()
  let sent = ""
  await gradeWorker(
    deps(x, async (request) => {
      sent = request.state
      return fakeAsk(request)
    }),
    "w-1",
  )
  expect(sent).toContain("TOOL apply_patch")
  expect(sent).toContain("FINAL Done; tests passed.")
  expect(sent).toContain("COST $1")
  expect(sent.length).toBeLessThanOrEqual(15000)
})

test("AC-3: a refusal-heavy fixed section reserves room for head and tail tool actions", () => {
  const log: FeedEvent[] = [feed(1, "tool.execution_start", { toolName: "head_tool", arguments: {} })]
  for (let index = 2; index < 102; index++)
    log.push(
      feed(index, "permission.completed", {
        result: { kind: "denied-interactively-by-user", feedback: `REFUSAL_${index} ${"x".repeat(1000)}` },
      }),
    )
  log.push(
    feed(103, "assistant.message", { content: "FINAL_AFTER_REFUSALS" }),
    feed(104, "tool.execution_start", { toolName: "tail_tool", arguments: {} }),
  )
  const text = extract(log, started.roleCard, started.task, 1.25, factoryConfig().accountability)
  expect(text.length).toBeLessThanOrEqual(15000)
  expect(text).toContain("REFUSAL_2")
  expect(text).toContain("FINAL_AFTER_REFUSALS")
  expect(text).toContain("head_tool")
  expect(text).toContain("tail_tool")
})

test("p90 budgets use completed workers, own cost, fixed date window and n<10 fallback", () => {
  const startedAt = (worker: string, step: string) => ({
    worker,
    role: "worker",
    step,
    timestamp: "2026-11-10T00:00:00.000Z",
  })
  const startedRows = [
    ...Array.from({ length: 10 }, (_, i) => startedAt(`i${i}`, "implement")),
    ...Array.from({ length: 9 }, (_, i) => startedAt(`v${i}`, "verify")),
    startedAt("incomplete", "implement"),
    { ...startedAt("coordinator", "implement"), role: "coordinator" },
    { ...startedAt("old", "implement"), timestamp: "2026-11-03T23:59:59.999Z" },
  ]
  const stopped = [
    ...Array.from({ length: 10 }, (_, i) => ({
      worker: `i${i}`,
      timestamp: "2026-11-20T00:00:00.000Z",
    })),
    ...Array.from({ length: 9 }, (_, i) => ({
      worker: `v${i}`,
      timestamp: "2026-11-20T00:00:00.000Z",
    })),
    { worker: "coordinator", timestamp: "2026-11-20T00:00:00.000Z" },
    { worker: "old", timestamp: "2026-11-20T00:00:00.000Z" },
  ]
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ worker: `i${i}`, costUsd: (i + 1) * 0.1 })),
    ...Array.from({ length: 9 }, (_, i) => ({ worker: `v${i}`, costUsd: 100 + i })),
    { worker: "incomplete", costUsd: 1000 },
    { worker: "coordinator", costUsd: 1000 },
    { worker: "old", costUsd: 1000 },
  ]
  const budgets = workerBudgets(rows, startedRows, stopped)
  expect(budgets.implement).toBe(1)
  expect(budgets.verify).toBe(budgets.default)
  expect(budgets.default).toBe(107)
  expect(
    workerBudgets(
      [{ worker: "x", costUsd: 0 }],
      [{ ...startedAt("x", "tiny") }],
      [{ worker: "x", timestamp: "2026-11-20T00:00:00.000Z" }],
    ).default,
  ).toBe(0.5)

  const timestamp = "2026-11-20T00:00:00.000Z"
  const parentAndChild = [
    { worker: "parent", role: "worker", step: "tiny", timestamp, owner: "coordinator" },
    { worker: "child", role: "coordinator", step: "child", timestamp, owner: "parent" },
  ]
  const hierarchyStops = [
    { worker: "parent", timestamp },
    { worker: "child", timestamp },
  ]
  const hierarchyCosts = [
    { worker: "parent", costUsd: 2 },
    { worker: "child", costUsd: 1000 },
  ]
  expect(workerBudgets(hierarchyCosts, parentAndChild, hierarchyStops)).toEqual({
    default: 2,
    tiny: 2,
  })
  expect(
    workerBudgets(
      hierarchyCosts,
      parentAndChild.map((row) => (row.worker === "child" ? { ...row, role: "worker" } : row)),
      hierarchyStops,
    ).default,
  ).toBe(1000)
})
