import { describe, expect, test } from "bun:test"
import type { Agent, Decision, Thread } from "../protos/core.ts"
import { ancestors, bossOf, build, count, items, rootOf } from "../protos/p3-model.ts"

const agent = (id: string, role: string, status: string, owner?: string) =>
  ({
    id,
    name: id,
    role,
    status,
    model: "m",
    auth: "native",
    pid: null,
    rssKb: null,
    home: "",
    task: null,
    lastMessage: null,
    owner,
    eventCount: 0,
    contextTokens: null,
    contextLimit: null,
  }) as unknown as Agent
const thread = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `t ${id}`, createdAt: 1, folderId: "general", ...extra }) as unknown as Thread
const decision = (threadId: string | null) =>
  ({
    id: `d-${threadId}`,
    kind: "question",
    threadId,
    title: "Pick",
    summary: "",
    options: [],
    optionDetails: [],
    allowText: false,
    context: "x",
    status: "pending",
    answer: null,
    note: null,
    createdAt: 1,
  }) as unknown as Decision

// desk · chat aaaaaaaa → repo conversation bbbbbbbb (sub) → worker w1 ; chat cccccccc alone ; draft dddddddd
const threads = [
  thread("desk0000", { desk: true }),
  thread("aaaaaaaa", { createdAt: 5 }),
  thread("bbbbbbbb", { folderId: "trellage", worktree: "/w", parentThreadId: "aaaaaaaa", createdAt: 6 }),
  thread("cccccccc", { createdAt: 3 }),
  thread("dddddddd", {
    folderId: "trellage",
    draft: { versions: [{ id: "v", prompt: "draft prompt", source: "human", at: 1 }], current: "v", reports: [] },
  }),
  thread("eeeeeeee", { archivedAt: 9 }),
]
const agents = [
  agent("coordinator", "coordinator", "idle"),
  agent("gen-aaaaaaaa", "coordinator", "idle"),
  agent("sub-bbbbbbbb", "coordinator", "running", "gen-aaaaaaaa"),
  agent("w1", "worker", "error", "sub-bbbbbbbb"),
  agent("w2", "worker", "idle", "gone"),
]

describe("p3 inbox model", () => {
  const m = build(agents, threads, [decision("bbbbbbbb")])

  test("tree: chat → sub-coordinator → worker; drafts and orphans are roots or under the desk", () => {
    expect(m.nodes.get("gen-aaaaaaaa")!.children).toEqual(["sub-bbbbbbbb"])
    expect(m.nodes.get("sub-bbbbbbbb")!.children).toEqual(["w1"])
    expect(m.nodes.get("w2")!.parent).toBe("coordinator")
    expect(m.nodes.get("draft-dddddddd")!.kind).toBe("draft")
    expect(m.nodes.get("gen-cccccccc")!.status).toBe("dormant")
    expect(m.nodes.has("gen-eeeeeeee")).toBe(false)
  })

  test("roll-up and decisions", () => {
    expect(m.nodes.get("sub-bbbbbbbb")!.status).toBe("needs")
    expect(m.nodes.get("gen-aaaaaaaa")!.agg).toEqual({ running: 0, error: 1, needs: 1, desc: 2 })
  })

  test("navigation helpers", () => {
    expect(rootOf(m, "w1")).toBe("gen-aaaaaaaa")
    expect(ancestors(m, "w1").map((n) => n.id)).toEqual(["gen-aaaaaaaa", "sub-bbbbbbbb"])
    expect(bossOf(m, "w1")!.id).toBe("sub-bbbbbbbb")
  })

  test("views: one row per conversation, focused on the node it is about", () => {
    const ids = (v: Parameters<typeof items>[1]) => items(m, v).map((r) => `${r.root.id}>${r.focus.id}`)
    expect(ids("needs")).toEqual(["gen-aaaaaaaa>sub-bbbbbbbb"])
    expect(ids("failed")).toEqual(["gen-aaaaaaaa>w1"])
    // sub-bbbbbbbb runs but waits on a question: it counts as "needs", not "running"
    expect(ids("running")).toEqual([])
    expect(items(build(agents, threads, []), "running").map((r) => `${r.root.id}>${r.focus.id}`)).toEqual([
      "gen-aaaaaaaa>sub-bbbbbbbb",
    ])
    expect(items(m, "needs")[0]!.reason).toBe("▲ t bbbbbbbb asks: Pick")
    expect(ids("chats")).toEqual([
      "gen-aaaaaaaa>sub-bbbbbbbb",
      "gen-cccccccc>gen-cccccccc",
      "draft-dddddddd>draft-dddddddd",
    ])
    expect(count(m, "repo:trellage")).toBe(2)
    expect(items(build(agents, threads, [], true), "archived").map((r) => r.root.id)).toEqual(["gen-eeeeeeee"])
  })

  test("a failure without a question focuses the failed worker", () => {
    const r = items(build(agents, threads, []), "failed")[0]!
    expect([r.root.id, r.focus.id, r.reason]).toEqual(["gen-aaaaaaaa", "w1", "✗ w1 failed"])
  })
})

test("workers under one coordinator are listed in spawn order, not by name", () => {
  const w = (id: string, startedAt: number) => ({ ...agent(id, "worker", "idle", "sub-bbbbbbbb"), startedAt })
  const m = build([...agents.slice(0, 3), w("pc-verify", 30), w("pc-finish", 40), w("pc-impl", 10)], threads, [])
  expect(m.nodes.get("sub-bbbbbbbb")!.children).toEqual(["pc-impl", "pc-verify", "pc-finish"])
})

test("stopped workers stay under their conversation; orphaned ones are dropped, not put under the desk", () => {
  const past = (id: string, owner: string) => ({ ...agent(id, "worker", "stopped", owner), startedAt: 1 })
  const m = build([...agents, past("old", "sub-bbbbbbbb"), past("lost", "sub-gone")], threads, [])
  expect(m.nodes.get("old")!.status).toBe("stopped")
  expect(m.nodes.get("sub-bbbbbbbb")!.children).toContain("old")
  expect(m.nodes.has("lost")).toBe(false)
  expect(m.roots).not.toContain("lost")
})

describe("modelReason", () => {
  const { modelReason } = require("../protos/p3-model.ts")
  const a = (modelSource?: unknown) => ({ ...agent("w", "worker", "idle"), ...(modelSource ? { modelSource } : {}) })
  test("routed shows who routed it and the confidence", () => {
    expect(modelReason(a({ kind: "routed", by: "jev", confidence: 0.834 })).text).toBe("jev 83%")
    expect(modelReason(a({ kind: "routed", by: "ui-rule", confidence: 0.6 })).title).toContain("UI rule")
  })
  test("fallback says Jev was unavailable", () => {
    expect(modelReason(a({ kind: "fallback" })).text).toBe("default · Jev unavailable")
  })
  test("no source from an older server shows nothing", () => {
    expect(modelReason(a())).toBeNull()
  })
})

describe("depth below workers: gates and subagents", () => {
  const w = (id: string, startedAt: number, extra: Record<string, unknown> = {}) => ({
    ...agent(id, "worker", "idle", "sub-bbbbbbbb"),
    startedAt,
    ...extra,
  })
  const cr = { id: "cr-1", title: "Code review", after: "impl" }
  const sr = { id: "sr-1", title: "Security review", after: null }
  const m = build(
    [
      ...agents.slice(0, 3),
      w("impl", 10, { subagents: [{ id: "c1", name: "explore", description: "Map", status: "done" }] }),
      w("lens", 20, { group: cr, status: "running" }),
      w("fix", 30, { group: cr }),
      w("audit", 40, { group: sr, subagents: [{ id: "c2", name: "research", description: "", status: "running" }] }),
    ],
    threads,
    [],
  )

  test("a gate hangs under the worker that started it, else under its coordinator; its workers hang under it", () => {
    expect(m.nodes.get("sub-bbbbbbbb")!.children).toEqual(["impl", "sr-1"])
    expect(m.nodes.get("impl")!.children).toEqual(["cr-1", "impl/c1"])
    expect(m.nodes.get("cr-1")!.children).toEqual(["lens", "fix"])
    expect(m.nodes.get("sr-1")!.children).toEqual(["audit"])
    expect(m.nodes.get("audit")!.children).toEqual(["audit/c2"])
    expect(m.nodes.get("cr-1")!.status).toBe("running")
    expect(m.nodes.get("impl/c1")!.kind).toBe("subagent")
  })

  test("gates and subagents are not counted as agents; a gate worker reports to the sub-coordinator", () => {
    // impl, lens, fix, audit under the sub-coordinator; lens runs (the sub-coordinator runs too).
    expect(m.nodes.get("sub-bbbbbbbb")!.agg).toMatchObject({ desc: 4, running: 2 })
    expect(bossOf(m, "lens")!.id).toBe("sub-bbbbbbbb")
    expect(bossOf(m, "audit")!.id).toBe("sub-bbbbbbbb")
    expect(rootOf(m, "impl/c1")).toBe("gen-aaaaaaaa")
  })

  test("a stopped gate with no conversation is dropped with its workers", () => {
    const lost = { id: "cr-x", title: "Code review", after: null }
    const s = (id: string) => ({ ...agent(id, "worker", "stopped", "sub-gone"), startedAt: 1, group: lost })
    const m2 = build([...agents, s("x1"), s("x2")], threads, [])
    expect(["cr-x", "x1", "x2"].some((id) => m2.nodes.has(id))).toBe(false)
  })
})
