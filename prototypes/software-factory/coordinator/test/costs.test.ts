import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { chatUsage, costReport, estimateNano, GOAL_PAGE_AGENT, rollUp, runCost, type UsageRow } from "../src/costs.ts"
import { EventStore } from "../src/events.ts"
import { UsageMeter } from "../src/claude.ts"
import { piEvents } from "../src/pi.ts"

// Copilot's claude-opus-5.5 rates (nano-AIU per token), as its copilotUsage.tokenDetails report them.
const OPUS = { input: 400_000, cache_read: 20_000, cache_write: 500_000, output: 2_000_000 }
const row = (worker: string, over: Partial<UsageRow> = {}): UsageRow => ({
  worker,
  model: "claude-opus-5.5",
  reported: true,
  calls: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  nanoAiu: 0,
  ...over,
})

test("an estimate prices each token type at Copilot's rate; cached tokens leave the input share", () => {
  // Real call: input 69390 (68413 cache read + 975 cache write + 2 fresh), output 70 → Copilot charged 1996560000.
  const nano = estimateNano(
    { inputTokens: 69_390, cacheReadTokens: 68_413, cacheWriteTokens: 975, outputTokens: 70 },
    OPUS,
  )
  expect(nano).toBe(1_996_560_000)
  expect(
    estimateNano({ inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, undefined),
  ).toBeNull()
  expect(
    estimateNano({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }, { input: 1 }),
  ).toBeNull()
})

test("cost rolls up worker → sub-coordinator → global; reported and estimated AIC stay apart", () => {
  const agents = [
    { id: "sub-a", name: "run a", role: "coordinator", owner: "coordinator" },
    { id: "w-1", name: "impl", role: "worker", owner: "sub-a" },
    { id: "w-2", name: "review", role: "worker", owner: "w-1" },
    { id: "w-3", name: "desk worker", role: "worker", owner: "coordinator" },
  ]
  const rows = [
    row("coordinator", { nanoAiu: 1e9, inputTokens: 10, outputTokens: 1 }),
    row("sub-a", { nanoAiu: 2e9, inputTokens: 20, outputTokens: 2 }),
    row("w-1", { nanoAiu: 3e9, inputTokens: 30 }),
    // A Claude-harness call: no AIC reported, 1000 output tokens at 2_000_000 nano-AIU = 2 AIC.
    row("w-2", { reported: false, outputTokens: 1000 }),
    row("w-3", { model: "mystery", reported: false, calls: 2, inputTokens: 5 }),
    // An agent with no start event hangs under the root.
    row("w-orphan", { nanoAiu: 5e8 }),
  ]
  const c = rollUp(rows, agents, { "claude-opus-5.5": OPUS }, 0.01)
  const sub = c.get("sub-a")!
  expect(sub.own.aic).toBe(2)
  expect(sub.total).toMatchObject({
    calls: 3,
    aicReported: 5,
    aicEstimated: 2,
    aic: 7,
    inputTokens: 50,
    outputTokens: 1002,
  })
  expect(sub.total.usd).toBeCloseTo(0.07)
  expect(c.get("w-1")!.total.aic).toBe(5)
  const g = c.get("coordinator")!.total
  expect(g).toMatchObject({ calls: 7, aic: 8.5, unpricedCalls: 2 })
  expect(c.get("coordinator")!.children.sort()).toEqual(["sub-a", "w-3", "w-orphan"])
})

test("an owner cycle does not loop", () => {
  const agents = [
    { id: "a", name: "a", role: "worker", owner: "b" },
    { id: "b", name: "b", role: "worker", owner: "a" },
  ]
  const c = rollUp([row("a", { nanoAiu: 1e9 })], agents, {}, 0.01)
  expect(c.get("a")!.total.aic).toBeGreaterThanOrEqual(1)
})

test("the report lists repo conversations newest first; one run lists its agents", () => {
  const agents = [
    { id: "sub-aaaaaaaa", name: "old", role: "coordinator", owner: "coordinator" },
    { id: "sub-bbbbbbbb", name: "new", role: "coordinator", owner: "coordinator" },
    { id: "w-1", name: "impl", role: "worker", owner: "sub-bbbbbbbb" },
  ]
  const c = rollUp([row("w-1", { nanoAiu: 4e9 }), row("sub-aaaaaaaa", { nanoAiu: 1e9 })], agents, {}, 0.01)
  const threads = [
    { id: "aaaaaaaa-1", title: "old", createdAt: 1, worktree: "/w/a" },
    { id: "bbbbbbbb-2", title: "new", createdAt: 2, worktree: "/w/b" },
    { id: "cccccccc-3", title: "chat", createdAt: 3 },
  ]
  const agentOf = (id: string) => `sub-${id.slice(0, 8)}`
  const r = costReport(c, threads, agentOf, 0.01)
  expect(r.runs.map((x) => [x.title, x.total.aic])).toEqual([
    ["new", 4],
    ["old", 1],
  ])
  expect(r.global.aic).toBe(5)
  const one = runCost(c, threads[1]!, agentOf, true)!
  expect(one.agents!.map((a) => [a.id, a.own.aic])).toEqual([
    ["sub-bbbbbbbb", 0],
    ["w-1", 4],
  ])
  expect(runCost(c, threads[2]!, agentOf, true)).toBeNull()
})

test("the store sums usage per agent and model, reads Copilot's rates, and never prunes usage", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-costs-"))
  try {
    const s = new EventStore(path.join(dir, "e.db"))
    let seq = 0
    const put = (worker: string, type: string, data: unknown) =>
      s.append({ seq: ++seq, workerId: worker, type, agentId: null, timestamp: "t", data })
    const details = Object.entries(OPUS).map(([tokenType, rate]) => ({
      batchSize: 1_000_000,
      costPerBatch: rate * 1_000_000,
      tokenCount: 1,
      tokenType,
      model: "claude-opus-5.5",
    }))
    put("w-1", "assistant.usage", {
      model: "claude-opus-5.5",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 80,
      copilotUsage: { totalNanoAiu: 7e8, tokenDetails: details },
    })
    put("w-1", "assistant.usage", {
      model: "claude-opus-5.5",
      inputTokens: 50,
      outputTokens: 5,
      copilotUsage: { totalNanoAiu: 3e8 },
    })
    put("w-1", "assistant.usage", { model: "claude-opus-5.5", inputTokens: 1, outputTokens: 1 })
    for (let i = 0; i < 5; i++) put("w-1", "assistant.message", { content: "x" })
    s.prune(2)
    const rows = s.usageRows().sort((a, b) => Number(b.reported) - Number(a.reported))
    expect(rows).toEqual([
      {
        worker: "w-1",
        model: "claude-opus-5.5",
        reported: true,
        calls: 2,
        inputTokens: 150,
        outputTokens: 15,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        nanoAiu: 1e9,
      },
      {
        worker: "w-1",
        model: "claude-opus-5.5",
        reported: false,
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        nanoAiu: 0,
      },
    ])
    expect(s.rates()).toEqual({ "claude-opus-5.5": OPUS })
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Claude results become per-turn usage: the delta of the running per-model totals", () => {
  const m = new UsageMeter()
  type Msg = Parameters<UsageMeter["map"]>[0]
  const result = (input: number, output: number, cacheRead: number): Msg =>
    ({
      type: "result",
      subtype: "success",
      modelUsage: {
        "claude-opus-5.5": {
          inputTokens: input,
          outputTokens: output,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: 0,
        },
      },
    }) as unknown as Msg
  expect(m.map(result(10, 5, 100), "t").map((e) => e.data)).toEqual([
    {
      model: "claude-opus-5.5",
      inputTokens: 110,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      aiCreditsStatus: "unavailable",
    },
  ])
  expect(m.map(result(15, 9, 300), "t").map((e) => e.data)).toMatchObject([
    { inputTokens: 205, outputTokens: 4, cacheReadTokens: 200 },
  ])
  expect(m.map(result(15, 9, 300), "t")).toEqual([])
  expect(m.map({ type: "assistant" } as unknown as Msg, "t")).toEqual([])
})

test("a Pi assistant message carries its call's usage", () => {
  const e = {
    type: "message_end",
    message: {
      role: "assistant",
      model: "claude-sonnet-5.5",
      content: [],
      usage: { input: 3, output: 7, cacheRead: 40, cacheWrite: 2, totalTokens: 52 },
    },
  }
  const usage = piEvents(e as unknown as Parameters<typeof piEvents>[0], "t", [], "/").find(
    (x) => x.type === "assistant.usage",
  )
  expect(usage?.data).toEqual({
    model: "claude-sonnet-5.5",
    inputTokens: 45,
    outputTokens: 7,
    cacheReadTokens: 40,
    cacheWriteTokens: 2,
    reasoningTokens: 0,
    aiCreditsStatus: "unavailable",
  })
})

test("a chat completion's usage keeps Copilot's charge when the reply carries it", () => {
  expect(chatUsage("m", {})).toBeNull()
  expect(
    chatUsage("m", { usage: { prompt_tokens: 10, completion_tokens: 2 }, copilot_usage: { total_nano_aiu: 5e8 } }),
  ).toMatchObject({
    inputTokens: 10,
    outputTokens: 2,
    copilotUsage: { totalNanoAiu: 5e8 },
    aiCreditsStatus: "complete",
  })
})

test("Goal page calls count in global and on their own line, in no run", () => {
  const c = rollUp(
    [row(GOAL_PAGE_AGENT, { nanoAiu: 2e9 }), row("sub-aaaaaaaa", { nanoAiu: 1e9 })],
    [{ id: "sub-aaaaaaaa", name: "run", role: "coordinator", owner: "coordinator" }],
    {},
    0.01,
  )
  const r = costReport(
    c,
    [{ id: "aaaaaaaa-1", title: "run", createdAt: 1, worktree: "/w" }],
    (id) => `sub-${id.slice(0, 8)}`,
    0.01,
  )
  expect([r.global.aic, r.goalPage.aic, r.runs[0]!.total.aic]).toEqual([3, 2, 1])
})
