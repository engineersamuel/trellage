import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
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
    { id: expect.any(String), role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "next_step", arguments: '{"request":"x"}' } }] },
    { id: "r1", role: "tool", content: "plan", toolCallId: "c1" },
    { id: expect.any(String), role: "assistant", content: "Plan ready." },
  ])
})

test("a draft survives a restart", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-threads-"))
  const t = new Threads(root)
  const th = t.create("idea")
  const draft = { versions: [{ id: "v1", prompt: "idea", source: "human" as const, at: 1 }], current: "v1", reports: [] }
  t.setDraft(th.id, draft)
  expect(new Threads(root).get(th.id)?.draft).toEqual(draft)
})

test("archivedAt is set and cleared by update, and survives a reload", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-threads-"))
  const t = new Threads(root)
  const th = t.create("test run")
  t.update(th.id, { archivedAt: 5 })
  expect(new Threads(root).get(th.id)?.archivedAt).toBe(5)
  t.update(th.id, { archivedAt: null } as any)
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
