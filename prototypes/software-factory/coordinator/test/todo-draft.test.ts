import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createTodoDraft } from "../src/todo/draft.ts"
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
    state: "claimed",
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
  expect(threads.get(thread.id)?.todo?.state).toBe("claimed")
})
