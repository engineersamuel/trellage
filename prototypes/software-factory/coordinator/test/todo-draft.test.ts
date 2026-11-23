import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { adoptDraftTodo, createTodoDraft, draftGoalSeed } from "../src/todo/draft.ts"
import { Threads } from "../src/threads.ts"

const createDraft = (threads: Threads, folderId: string, prompt: string) => {
  const thread = threads.create(prompt, folderId, () => ({ worktree: "/repo", branch: "b", base: "main" }))
  threads.setDraft(thread.id, {
    versions: [{ id: "v1", prompt, source: "human", at: 1 }],
    current: "v1",
    reports: [],
  })
  return threads.get(thread.id)!
}

test("a Todo draft stores the source prompt and claims after creation", async () => {
  const threads = new Threads(mkdtempSync(path.join(tmpdir(), "sf-todo-draft-")))
  const claims: string[] = []
  const thread = await createTodoDraft(
    {
      threads,
      source: {
        lists: async () => [{ id: "list", name: "Work" }],
        task: async () => ({
          task: {
            id: "task",
            projectId: "list",
            title: "Ship it",
            content: "Details",
            tags: ["owner"],
          },
          comments: [{ content: "Useful context" }],
        }),
      },
      drafts: {
        create: (folderId, prompt) => createDraft(threads, folderId, prompt),
      },
      claim: async (id) => void claims.push(id),
    },
    "general",
    { source: "ticktick", listId: "list", taskId: "task" },
  )
  await Promise.resolve()
  const stored = threads.get(thread.id)!
  expect(stored.draft?.versions[0]?.prompt).toContain("Useful context")
  expect(thread.title).toContain("Ship it")
  expect(stored.todo).toEqual({
    source: "ticktick",
    listId: "list",
    taskId: "task",
    title: "Ship it",
    state: "drafted",
    done: [],
  })
  expect(claims).toEqual([thread.id])
})

test("a claim failure never rejects a created Todo draft", async () => {
  const threads = new Threads(mkdtempSync(path.join(tmpdir(), "sf-todo-draft-")))
  const thread = await createTodoDraft(
    {
      threads,
      source: {
        lists: async () => [{ id: "list", name: "Work" }],
        task: async () => ({
          task: { id: "task", projectId: "list", title: "Ship it" },
          comments: [],
        }),
      },
      drafts: { create: (folderId, prompt) => createDraft(threads, folderId, prompt) },
      claim: async () => Promise.reject(new Error("synthetic token")),
    },
    "general",
    { source: "ticktick", listId: "list", taskId: "task" },
  )
  expect(threads.get(thread.id)?.todo?.state).toBe("drafted")
})
test("draftGoalSeed gives the current version, the folder and the newest finished research report", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-goal-seed-"))
  const threads = new Threads(dir)
  const thread = threads.create("x", "general", () => ({ worktree: dir, branch: "b", base: "main" }))
  mkdirSync(path.join(dir, "reports"), { recursive: true })
  writeFileSync(path.join(dir, "reports", "deep.md"), "# report")
  threads.setDraft(thread.id, {
    versions: [
      { id: "v1", prompt: "old", source: "human", at: 1 },
      { id: "v2", prompt: "current prompt", source: "human", at: 2 },
    ],
    current: "v2",
    reports: [
      { action: "deep-research", workerId: "w1", path: "reports/deep.md", versionId: "v1" },
      { action: "research", workerId: "w2", path: "reports/missing.md", versionId: "v2" },
    ],
  })
  expect(draftGoalSeed(threads.get(thread.id)!, () => false)).toEqual({
    seed: "current prompt",
    folderId: "general",
    research: path.join(dir, "reports", "deep.md"),
  })
  expect(draftGoalSeed(threads.get(thread.id)!, (id) => id === "w1")?.research).toBeNull()
  expect(draftGoalSeed(threads.create("chat", "general"), () => false)).toBeUndefined()
})

test("adoptDraftTodo moves the TickTick link to the goal thread and archives the draft", () => {
  const threads = new Threads(mkdtempSync(path.join(tmpdir(), "sf-adopt-")))
  const draft = createDraft(threads, "general", "p")
  const goal = threads.create("goal", "general", () => ({ worktree: "/g", branch: "g", base: "main" }))
  const todo = {
    source: "ticktick" as const,
    listId: "l",
    taskId: "t",
    title: "T",
    state: "claimed" as const,
    done: ["claim"],
  }
  threads.setTodo(draft.id, todo)
  adoptDraftTodo(threads, draft.id, goal.id, 5)
  expect(threads.get(goal.id)!.todo).toEqual(todo)
  expect(threads.get(draft.id)!.todo).toBeUndefined()
  expect(threads.get(draft.id)!.archivedAt).toBe(5)
  const plain = createDraft(threads, "general", "no link")
  adoptDraftTodo(threads, plain.id, goal.id, 6)
  expect([threads.get(plain.id)!.archivedAt, threads.get(goal.id)!.todo?.taskId]).toEqual([6, "t"])
})

test("a Todo draft uses the human's edited prompt when one is sent", async () => {
  const threads = new Threads(mkdtempSync(path.join(tmpdir(), "sf-todo-draft-")))
  const deps = {
    threads,
    source: {
      lists: async () => [{ id: "list", name: "Work" }],
      task: async () => ({ task: { id: "task", projectId: "list", title: "Ship it" }, comments: [] }),
    },
    drafts: { create: (folderId: string, prompt: string) => createDraft(threads, folderId, prompt) },
    claim: async () => {},
  }
  const link = { source: "ticktick" as const, listId: "list", taskId: "task" }
  const edited = await createTodoDraft(deps, "general", link, "Ship it, and add a changelog entry")
  expect(threads.get(edited.id)!.draft?.versions[0]?.prompt).toBe("Ship it, and add a changelog entry")
  const blank = await createTodoDraft(deps, "general", link, "   ")
  expect(threads.get(blank.id)!.draft?.versions[0]?.prompt).toContain("Source: TickTick")
})
