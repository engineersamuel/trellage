import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AccountabilityDb, accountabilityDbPath, backfillAccountability } from "../src/accountability.ts"
import { EventStore } from "../src/events.ts"
import type { FeedEvent } from "../src/factory.ts"
import { accountabilityCommand } from "../accountability-cli.ts"
import { factoryConfig, resetConfigStore } from "../src/config.ts"

const cli = async (state: string, args: string[]) => {
  const child = Bun.spawn([process.execPath, "cli.ts", "accountability", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: {
      ...process.env,
      SF_STATE_DIR: state,
      SF_CONFIG: path.join(state, "missing-config.toml"),
      XDG_CONFIG_HOME: path.join(state, "config"),
      TYPESAFE_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

const local = async (state: string, args: string[]) => {
  process.env.SF_STATE_DIR = state
  process.env.SF_CONFIG = path.join(state, "missing-config.toml")
  resetConfigStore()
  return accountabilityCommand(args)
}

test("accountability CLI backfills five recorded workers once and persists validated labels", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "sf-accountability-cli-"))
  const store = new EventStore(path.join(state, "events.db"))
  for (let i = 1; i <= 5; i++) {
    const event = (seq: number, type: string, data: unknown): FeedEvent => ({
      seq: i * 10 + seq,
      workerId: `worker-${i}`,
      type,
      agentId: null,
      timestamp: `2026-11-${String(10 + i).padStart(2, "0")}T12:00:0${seq}.000Z`,
      data,
    })
    if (i === 1)
      store.append(
        event(0, "assistant.usage", {
          model: "model-a",
          inputTokens: 1,
          outputTokens: 1,
          copilotUsage: { totalNanoAiu: 100_000_000_000 },
        }),
      )
    store.append(
      event(1, "factory.worker_started", {
        id: `worker-${i}`,
        role: "worker",
        step: "implement",
        owner: `sub-${i}`,
        model: "model-a",
        modelSource: { kind: "pinned" },
        harness: "copilot",
        task: `Task ${i}`,
        roleCard: null,
      }),
    )
    store.append(event(2, "factory.worker_stopped", { id: `worker-${i}` }))
  }
  store.close()

  const first = await cli(state, ["backfill", "--limit", "5"])
  expect(first.code).toBe(0)
  expect(JSON.parse(first.stdout)).toEqual({ graded: 5, skipped: 0 })
  const second = await cli(state, ["backfill", "--limit", "5"])
  expect(second.code).toBe(0)
  expect(JSON.parse(second.stdout)).toEqual({ graded: 0, skipped: 5 })
  let engineCalls = 0
  const idempotentStore = new EventStore(path.join(state, "events.db"))
  const idempotentDb = new AccountabilityDb(accountabilityDbPath(state))
  expect(
    await backfillAccountability({
      store: idempotentStore,
      db: idempotentDb,
      config: factoryConfig(),
      available: () => true,
      ask: async (request) => {
        engineCalls++
        return {
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              { noul: 1, choice: "", confidence: 1, probabilities: {} },
            ]),
          ),
          engine: "fake",
        }
      },
      publish: () => {},
      dimensions: (owner) => ({ owner, thread: null, goal: null, folderId: null, repo: null }),
      limit: 5,
    }),
  ).toEqual({ graded: 0, skipped: 5 })
  expect(engineCalls).toBe(0)
  expect(idempotentDb.rows()).toHaveLength(5)
  idempotentDb.close()
  idempotentStore.close()
  expect(await local(state, ["budgets"])).toEqual({ default: 1, implement: 1 })
  await expect(local(state, [])).rejects.toThrow("usage")
  await expect(local(state, ["backfill", "--limit", "0"])).rejects.toThrow("positive integer")
  await expect(local(state, ["backfill", "--since", "not-a-date"])).rejects.toThrow("timestamp")
  await expect(local(state, ["backfill", "--unknown"])).rejects.toThrow("unknown option")
  await expect(local(state, ["label"])).rejects.toThrow("usage")

  const invalid = await cli(state, ["label", "worker-1", "9.9", "pass"])
  expect(invalid.code).toBe(1)
  expect(invalid.stderr).toContain("unknown control")
  const labeled = await cli(state, ["label", "worker-1", "3.1", "fail"])
  expect(labeled.code).toBe(0)
  const db = new AccountabilityDb(accountabilityDbPath(state))
  expect(db.rows()).toHaveLength(5)
  expect(db.labels()).toContainEqual({
    worker: "worker-1",
    control: "3.1",
    label: "fail",
    at: expect.any(Number),
  })
  db.close()

  const later = new EventStore(path.join(state, "events.db"))
  const timestamp = "2026-11-20T12:00:00.000Z"
  later.append({
    seq: later.maxSeq() + 1,
    workerId: "worker-6",
    type: "factory.worker_started",
    agentId: null,
    timestamp,
    data: { id: "worker-6", role: "worker", task: "Task 6" },
  })
  later.append({
    seq: later.maxSeq() + 1,
    workerId: "worker-6",
    type: "factory.worker_stopped",
    agentId: null,
    timestamp,
    data: { id: "worker-6" },
  })
  later.close()
  expect(await local(state, ["backfill", "--limit", "1"])).toEqual({ graded: 1, skipped: 5 })
  const published = new EventStore(path.join(state, "events.db"))
  expect(
    (published.latest("factory.accountability_graded", 100) as { worker?: unknown }[]).some(
      (event) => event.worker === "worker-6",
    ),
  ).toBe(true)
  published.close()
})

test("accountability CLI backfill stops at the requested limit", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "sf-accountability-cli-limit-"))
  const store = new EventStore(path.join(state, "events.db"))
  for (let i = 1; i <= 6; i++) {
    const event = (seq: number, type: string, data: unknown): FeedEvent => ({
      seq: i * 10 + seq,
      workerId: `limit-${i}`,
      type,
      agentId: null,
      timestamp: `2026-11-${String(10 + i).padStart(2, "0")}T12:00:0${seq}.000Z`,
      data,
    })
    store.append(event(1, "factory.worker_started", { id: `limit-${i}`, role: "worker", task: `Task ${i}` }))
    store.append(event(2, "factory.worker_stopped", { id: `limit-${i}` }))
  }
  store.close()

  const limited = await cli(state, ["backfill", "--limit", "5"])
  expect(limited.code).toBe(0)
  expect(JSON.parse(limited.stdout)).toEqual({ graded: 5, skipped: 0 })
  const db = new AccountabilityDb(accountabilityDbPath(state))
  expect(db.rows()).toHaveLength(5)
  db.close()
})

test("AC-9 accountability CLI budgets own completed worker cost with n<10 fallback and unpriced calls at zero", async () => {
  const state = mkdtempSync(path.join(tmpdir(), "sf-accountability-budgets-"))
  const store = new EventStore(path.join(state, "events.db"))
  let seq = 0
  const append = (worker: string, type: string, timestamp: string, data: unknown) =>
    store.append({ seq: ++seq, workerId: worker, type, agentId: null, timestamp, data })
  const complete = (worker: string, step: string, startedAt = "2026-11-10T00:00:00.000Z") => {
    append(worker, "factory.worker_started", startedAt, { id: worker, role: "worker", step })
    append(worker, "factory.worker_stopped", "2026-11-20T00:00:00.000Z", { id: worker })
  }

  for (let i = 1; i <= 10; i++) {
    const worker = `implement-${i}`
    complete(worker, "implement")
    append(worker, "assistant.usage", "2026-11-10T01:00:00.000Z", {
      model: "priced",
      inputTokens: 1,
      outputTokens: 1,
      copilotUsage: { totalNanoAiu: i * 10_000_000_000 },
    })
  }
  for (let i = 1; i <= 9; i++) complete(`verify-${i}`, "verify")
  for (let i = 1; i <= 10; i++) {
    const worker = `unpriced-${i}`
    complete(worker, "unpriced")
    append(worker, "assistant.usage", "2026-11-10T01:00:00.000Z", {
      model: "unknown",
      inputTokens: 100,
      outputTokens: 100,
    })
  }

  append("descendant", "assistant.usage", "2026-11-10T01:00:00.000Z", {
    model: "priced",
    inputTokens: 1,
    outputTokens: 1,
    copilotUsage: { totalNanoAiu: 999_000_000_000_000 },
  })
  append("coordinator", "factory.worker_started", "2026-11-10T00:00:00.000Z", {
    id: "coordinator",
    role: "coordinator",
    step: "implement",
  })
  append("coordinator", "factory.worker_stopped", "2026-11-20T00:00:00.000Z", {
    id: "coordinator",
  })
  complete("before", "implement", "2026-11-03T23:59:59.999Z")
  append("after", "factory.worker_started", "2026-11-25T00:00:00.000Z", {
    id: "after",
    role: "worker",
    step: "implement",
  })
  append("after", "factory.worker_stopped", "2026-11-25T00:00:00.000Z", { id: "after" })
  append("incomplete", "factory.worker_started", "2026-11-10T00:00:00.000Z", {
    id: "incomplete",
    role: "worker",
    step: "implement",
  })
  for (const excluded of ["coordinator", "before", "after", "incomplete"])
    append(excluded, "assistant.usage", "2026-11-10T01:00:00.000Z", {
      model: "priced",
      inputTokens: 1,
      outputTokens: 1,
      copilotUsage: { totalNanoAiu: 999_000_000_000_000 },
    })
  store.close()

  expect(await local(state, ["budgets"])).toEqual({
    default: 1,
    implement: 1,
    verify: 1,
    unpriced: 0.5,
  })
})
