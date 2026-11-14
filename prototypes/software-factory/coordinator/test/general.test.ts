import { expect, test } from "bun:test"
import { conversationStatus, deletedNotice, factorySnapshot, genId } from "../src/general.ts"

const repo = (id: string, extra: object = {}) => ({
  id,
  title: `t-${id}`,
  createdAt: 0,
  folderId: "trellage",
  worktree: `/wt/${id}`,
  branch: `factory/${id}`,
  ...extra,
})
const sub = (id: string) => `sub-${id.slice(0, 8)}`

test("snapshot notes an unstarted draft, not a started one", () => {
  const draft = { versions: [], current: "v", reports: [] }
  const s = factorySnapshot(
    [repo("aaaaaaaa1", { draft }), repo("bbbbbbbb2", { draft: { ...draft, startedAt: 1 } })],
    [],
    [],
    () => null,
    sub,
  )
  expect(s.conversations[0]!.note).toBe("draft: do not message; the human runs it from the Inbox")
  expect(s.conversations[1]!.note).toBeUndefined()
})

test("a run with a task but no live sub-coordinator is stopped, not pending", () => {
  expect(conversationStatus(undefined, undefined, 0)).toBe("deleted")
  expect(conversationStatus(repo("a", { cleanedAt: 1 }), undefined, 3)).toBe("merged")
  expect(conversationStatus(repo("a"), { status: "running" }, 3)).toBe("running")
  expect(conversationStatus(repo("a"), undefined, 3)).toBe("stopped")
  expect(conversationStatus(repo("a"), undefined, 0)).toBe("not started")
})

test("the snapshot is compact live state and flags runs that need attention", () => {
  const threads = [
    repo("aaaaaaaa1", { parentThreadId: "g1" }),
    repo("bbbbbbbb2", { archivedAt: 5 }),
    { id: "g1", title: "chat", createdAt: 0, folderId: "general" },
  ]
  const agents = [
    { id: sub("aaaaaaaa1"), name: "s", status: "running", owner: "gen-g1" },
    { id: "w1", name: "lens", status: "running", owner: sub("aaaaaaaa1") },
    { id: "w2", name: "lens2", status: "idle", owner: sub("aaaaaaaa1") },
    { id: "gen-g1", name: "General · chat", status: "idle", owner: "coordinator" },
  ]
  const s = factorySnapshot(
    threads,
    agents,
    [{ id: "d1", title: "Approve plan", threadId: "aaaaaaaa1" }],
    (id) => (id === "bbbbbbbb2" ? "x".repeat(500) : "go"),
    sub,
  )
  expect(s.conversations.map((c) => [c.id, c.status, c.workers.running, c.workers.total, c.pendingDecisions])).toEqual([
    ["aaaaaaaa1", "running", 1, 2, 1],
    ["bbbbbbbb2", "stopped", 0, 0, 0],
  ])
  expect(s.conversations[0]!.startedFrom).toBe("g1")
  expect(s.conversations[1]!.archived).toBe(true)
  expect(s.conversations[1]!.note).toContain("not progressing")
  expect(s.conversations[1]!.last!.length).toBe(240)
  expect(s.generalChats).toEqual([{ id: "gen-g1", name: "General · chat", status: "idle" }])
  expect(s.needsAttention).toEqual(["aaaaaaaa1", "bbbbbbbb2"])
})

test("ids and the delete notice", () => {
  expect(genId("0123456789")).toBe("gen-01234567")
  expect(deletedNotice(repo("a"))).toContain("Ignore it")
})
