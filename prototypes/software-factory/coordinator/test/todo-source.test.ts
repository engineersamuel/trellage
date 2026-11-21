import { expect, test } from "bun:test"
import { draftPrompt, type TodoComment, type TodoList, type TodoTask } from "../src/todo/source.ts"

const list: TodoList = { id: "project-1", name: "Work" }
const task = (patch: Partial<TodoTask> = {}): TodoTask => ({
  id: "task-1",
  projectId: list.id,
  title: "Ship the change",
  ...patch,
})

test("draftPrompt keeps a title-only task concise", () => {
  expect(draftPrompt(task(), list, [])).toBe(
    "Ship the change\n\nSource: TickTick · list Work · tags none · priority none · due none",
  )
})

test("draftPrompt includes content, description, checklist, and ordinary comments", () => {
  const todo = task({
    content: "Content details",
    desc: "Description details",
    items: [
      { title: "Open item", status: 0 },
      { title: "Done item", status: 2 },
    ],
    tags: ["one", "two"],
    priority: 5,
    dueDate: "2026-12-01T00:00:00.000Z",
  })
  const comments: TodoComment[] = [{ content: "An owner comment" }, { content: "🏭 Factory draft: ignored" }]
  expect(draftPrompt(todo, list, comments)).toBe(
    [
      "Ship the change",
      "",
      "Content details\n\nDescription details",
      "",
      "Checklist:\n- [ ] Open item\n- [x] Done item",
      "",
      "Comments:\n- An owner comment",
      "",
      "Source: TickTick · list Work · tags one, two · priority high · due 2026-12-01",
    ].join("\n"),
  )
})

test("draftPrompt exactly maps each TickTick priority and defaults unknown priority", () => {
  for (const [priority, label] of [
    [1, "low"],
    [3, "medium"],
    [5, "high"],
    [7, "none"],
  ] as const) {
    expect(draftPrompt(task({ priority }), list, [])).toBe(
      `Ship the change\n\nSource: TickTick · list Work · tags none · priority ${label} · due none`,
    )
  }
})

test("draftPrompt treats null or empty tags as none and ignores blank factory comments", () => {
  for (const tags of [null, []]) {
    expect(draftPrompt(task({ tags }), list, [{ content: "   " }, { content: "🏭 Factory stopped: ignored" }])).toBe(
      "Ship the change\n\nSource: TickTick · list Work · tags none · priority none · due none",
    )
  }
})
