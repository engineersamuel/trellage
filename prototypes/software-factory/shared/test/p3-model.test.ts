import { describe, expect, test } from "bun:test"
import { ancestors, bossOf, build, count, items, rootOf } from "../protos/p3-model.ts"

const agent = (id: string, role: string, status: string, owner?: string) =>
  ({ id, name: id, role, status, model: "m", auth: "native", pid: null, rssKb: null, home: "", task: null, lastMessage: null, owner, eventCount: 0, contextTokens: null, contextLimit: null }) as any
const thread = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `t ${id}`, createdAt: 1, folderId: "general", ...extra }) as any
const decision = (threadId: string | null) => ({ id: `d-${threadId}`, kind: "question", threadId, title: "Pick", summary: "", options: [], optionDetails: [], allowText: false, context: "x", status: "pending", answer: null, note: null, createdAt: 1 }) as any

// desk · chat aaaaaaaa → repo conversation bbbbbbbb (sub) → worker w1 ; chat cccccccc alone ; draft dddddddd
const threads = [
  thread("desk0000", { desk: true }),
  thread("aaaaaaaa", { createdAt: 5 }),
  thread("bbbbbbbb", { folderId: "trellage", worktree: "/w", parentThreadId: "aaaaaaaa", createdAt: 6 }),
  thread("cccccccc", { createdAt: 3 }),
  thread("dddddddd", { folderId: "trellage", draft: { versions: [{ id: "v", prompt: "draft prompt", source: "human", at: 1 }], current: "v", reports: [] } }),
  thread("eeeeeeee", { archivedAt: 9 }),
]
const agents = [agent("coordinator", "coordinator", "idle"), agent("gen-aaaaaaaa", "coordinator", "idle"), agent("sub-bbbbbbbb", "coordinator", "running", "gen-aaaaaaaa"), agent("w1", "worker", "error", "sub-bbbbbbbb"), agent("w2", "worker", "idle", "gone")]

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
    expect(items(build(agents, threads, []), "running").map((r) => `${r.root.id}>${r.focus.id}`)).toEqual(["gen-aaaaaaaa>sub-bbbbbbbb"])
    expect(items(m, "needs")[0]!.reason).toBe("▲ t bbbbbbbb asks: Pick")
    expect(ids("chats")).toEqual(["gen-aaaaaaaa>sub-bbbbbbbb", "gen-cccccccc>gen-cccccccc", "draft-dddddddd>draft-dddddddd"])
    expect(count(m, "repo:trellage")).toBe(2)
    expect(items(build(agents, threads, [], true), "archived").map((r) => r.root.id)).toEqual(["gen-eeeeeeee"])
  })

  test("a failure without a question focuses the failed worker", () => {
    const r = items(build(agents, threads, []), "failed")[0]!
    expect([r.root.id, r.focus.id, r.reason]).toEqual(["gen-aaaaaaaa", "w1", "✗ w1 failed"])
  })
})
