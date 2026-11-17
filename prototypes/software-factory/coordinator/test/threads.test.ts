import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { messageThread, RunRecorder, subId, Threads, type Thread } from "../src/threads.ts"

test("a run's AG-UI events become saved chat messages that a new process can read", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-threads-"))
  const t = new Threads(root)
  const th = t.create("build it")
  t.append(th.id, { id: "u1", role: "user", content: "build it" })
  const rec = new RunRecorder()
  for (const e of [
    { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "next_step" },
    { type: "TOOL_CALL_ARGS", toolCallId: "c1", delta: '{"request":"x"}' },
    { type: "TOOL_CALL_RESULT", messageId: "r1", toolCallId: "c1", content: "plan" },
    { type: "TEXT_MESSAGE_CONTENT", delta: "Plan " },
    { type: "TEXT_MESSAGE_CONTENT", delta: "ready." },
  ])
    rec.add(e)
  t.append(th.id, ...rec.messages())
  const again = new Threads(root)
  expect(again.list().map((x) => x.title)).toEqual(["build it"])
  expect(again.messages(th.id)).toEqual([
    { id: "u1", role: "user", content: "build it" },
    {
      id: expect.any(String),
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", type: "function", function: { name: "next_step", arguments: '{"request":"x"}' } }],
    },
    { id: "r1", role: "tool", content: "plan", toolCallId: "c1" },
    { id: expect.any(String), role: "assistant", content: "Plan ready." },
  ])
})

test("a draft survives a restart", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-threads-"))
  const t = new Threads(root)
  const th = t.create("idea")
  const draft = {
    versions: [{ id: "v1", prompt: "idea", source: "human" as const, at: 1 }],
    current: "v1",
    reports: [],
  }
  t.setDraft(th.id, draft)
  expect(new Threads(root).get(th.id)?.draft).toEqual(draft)
})

test("archivedAt is set and cleared by update, and survives a reload", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-threads-"))
  const t = new Threads(root)
  const th = t.create("test run")
  t.update(th.id, { archivedAt: 5 })
  expect(new Threads(root).get(th.id)?.archivedAt).toBe(5)
  t.update(th.id, { archivedAt: null } as unknown as Partial<Thread>)
  expect(new Threads(root).get(th.id)?.archivedAt).toBeUndefined()
  expect(t.get(th.id)?.title).toBe("test run")
})

describe("messageThread", () => {
  const general = { id: "g1111111-a", title: "g", createdAt: 1, folderId: "general" }
  const general2 = { id: "g2222222-b", title: "g2", createdAt: 2, folderId: "general" }
  const repo = { id: "r3333333-c", title: "r", createdAt: 3, folderId: "repo", worktree: "/w", branch: "b" } as Thread
  const list = [general2, general, repo]

  test("a named General conversation wins over the last-used one for the global coordinator", () => {
    expect(messageThread(list, "coordinator", general.id, general2.id)).toBe(general.id)
  })
  test("a named repo conversation is ignored for the global coordinator (mismatch): last-used is used", () => {
    expect(messageThread(list, "coordinator", repo.id, general.id)).toBe(general.id)
  })
  test("a named General conversation is ignored for a sub-coordinator (mismatch): its own conversation is used", () => {
    expect(messageThread(list, subId(repo.id), general.id, general2.id)).toBe(repo.id)
  })
  test("an unknown named conversation falls back", () => {
    expect(messageThread(list, "coordinator", "nope", null)).toBe(general2.id)
  })
  test("a worker gets no conversation", () => {
    expect(messageThread(list, "w-12345678", general.id, general.id)).toBeUndefined()
  })
})

test("threads live in SQLite: an old threads.json is imported once, and an append writes rows, not a file", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-threads-"))
  const old = {
    threads: [
      { id: "b", title: "newer", createdAt: 2, folderId: "general" },
      { id: "a", title: "older", createdAt: 1, folderId: "general" },
    ],
    messages: { b: [{ id: "u1", role: "user", content: "hi" }] },
    folders: [{ id: "r", name: "r", path: "/r" }],
  }
  writeFileSync(path.join(root, "threads.json"), JSON.stringify(old))
  const t = new Threads(root)
  expect(t.list().map((x) => x.id)).toEqual(["b", "a"])
  expect(t.messages("b")).toEqual([{ id: "u1", role: "user", content: "hi" }])
  expect(t.folder("r")?.path).toBe("/r")
  expect(existsSync(path.join(root, "threads.json"))).toBe(false)
  expect(existsSync(path.join(root, "threads.json.imported"))).toBe(true)
  t.create("third")
  t.append("b", { id: "a1", role: "assistant", content: "hello" })
  t.append("b", { id: "c1", role: "activity", activityType: "worker", content: { s: 1 } })
  t.append("b", { id: "c1", role: "activity", activityType: "worker", content: { s: 2 } })
  const again = new Threads(root)
  expect(again.list().map((x) => x.title)).toEqual(["third", "newer", "older"])
  expect(again.messages("b").map((m) => m.id)).toEqual(["u1", "a1", "c1"])
  expect(again.messages("b").at(-1)).toMatchObject({ content: { s: 2 } })
  expect(again.count("b")).toBe(3)
  expect(again.messages("b", { limit: 2 }).map((m) => m.id)).toEqual(["a1", "c1"])
  expect(again.firstUser("b")).toBe("hi")
})

test("the human's view keeps only turns the human started, plus the event kinds asked for", () => {
  const t = new Threads(mkdtempSync(path.join(tmpdir(), "sf-threads-")))
  const id = t.create("cos").id
  const u = (mid: string, content: string) => ({ id: mid, role: "user" as const, content })
  const a = (mid: string, content: string) => ({ id: mid, role: "assistant" as const, content })
  t.append(id, u("1", "[report from webskiff · x] (conversation c) **done**"), a("2", "relayed"))
  t.append(
    id,
    u("3", "Add a yank key"),
    { id: "4", role: "tool", content: "{}", toolCallId: "x" },
    a("5", "Started it."),
  )
  t.append(id, a("6", "[report from webskiff · x] (conversation c) **done**: handled by a rule"))
  t.append(id, u("7", "[Chief of Staff · rule R8] Worker w drifted"), a("8", "checked"))
  t.append(id, u("9", '[approval a1 answered] "Merge?": yes'))
  t.append(id, u("10", "[supervisor] Periodic worker check found 1 issue(s)"), u("11", "[cron: digest] sum up"))
  t.append(id, u("12", '[from the archived chat "old" (x)]\nhi'), a("13", "hello"))
  // A run's answer saved after another prompt keeps the kind of its own prompt.
  t.append(id, { kind: "reports" }, a("14", "late answer to a report"))
  const ids = (show: string[]) => t.messages(id, { show: new Set(show as never[]) }).map((m) => m.id)
  expect(ids([])).toEqual(["3", "4", "5", "12", "13"])
  expect(ids(["reports"])).toEqual(["1", "2", "3", "4", "5", "6", "12", "13", "14"])
  expect(ids(["rules", "checks", "answers"])).toEqual(["3", "4", "5", "7", "8", "9", "10", "11", "12", "13"])
  expect(t.messages(id, { show: new Set(), limit: 2 }).map((m) => m.id)).toEqual(["12", "13"])
})
