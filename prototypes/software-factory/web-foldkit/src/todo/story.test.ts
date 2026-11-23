import { Effect } from "effect"
import { AsyncData } from "foldkit"
import { Command, given, message, model, story } from "foldkit/story"
import { Dialog } from "@foldkit/ui"
import { afterEach, expect, test, vi } from "vitest"
import {
  Draft,
  FocusSearch,
  LoadDetail,
  LoadFolders,
  LoadLastFolder,
  LoadLists,
  LoadStatus,
  LoadTasks,
  ReadTime,
  SaveLastFolder,
  ScrollToTask,
} from "./command"
import { Message } from "./message"
import { init, update } from "./update"
afterEach(() => vi.unstubAllGlobals())
const hex = (ms: number) =>
  Math.floor(ms / 1000)
    .toString(16)
    .padStart(8, "0") + "0000000000000000"
const NOW = Date.UTC(2026, 10, 22, 12)
const newer = { id: hex(NOW - 3600e3), title: "Newer", projectId: "ms" }
const older = { id: hex(NOW - 5 * 864e5), title: "Older", projectId: "ai" }
const loaded = {
  ...init().model,
  now: NOW,
  lists: AsyncData.succeed([
    { id: "ai", name: "AI" },
    { id: "ms", name: "Microsoft" },
  ]),
  tasks: { ai: [older], ms: [newer] },
  folders: AsyncData.succeed([{ id: "r", name: "repo", path: "/r" }]),
}

test("opening loads status, lists, repos, the last repo and the time, and focuses search", () =>
  story(
    update,
    given(init().model),
    message(Message.ClickedOpen()),
    Command.expectHas(ReadTime(), LoadStatus(), LoadLists(), LoadFolders(), LoadLastFolder(), FocusSearch()),
    Command.resolveAll(
      [ReadTime, Message.CompletedReadTime({ now: NOW })],
      [LoadStatus, Message.LoadedStatus({ value: { state: "connected" } })],
      [LoadFolders, Message.LoadedFolders({ value: [] })],
      [LoadLastFolder, Message.LoadedLastFolder({ value: "r" })],
      [FocusSearch, Message.Completed()],
      [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
      [
        LoadLists,
        Message.LoadedLists({
          value: [
            { id: "ai", name: "AI" },
            { id: "ms", name: "Microsoft" },
          ],
        }),
      ],
    ),
    Command.expectHas(LoadTasks({ id: "ai" }), LoadTasks({ id: "ms" })),
    Command.resolveAll(
      [LoadTasks, Message.LoadedTasks({ value: [older], listId: "ai" })],
      [LoadTasks, Message.FailedTasks({ error: "down", listId: "ms" })],
    ),
    model((m) =>
      expect([m.now, m.folderId, Object.keys(m.tasks), m.failedLists, m.error]).toEqual([
        NOW,
        "r",
        ["ai"],
        ["ms"],
        "down",
      ]),
    ),
  ))

test("arrow keys walk the timeline newest first, across lists in All lists", () =>
  story(
    update,
    given(loaded),
    message(Message.PressedNext()),
    Command.expectHas(LoadDetail({ id: newer.id, requestId: 1 }), ScrollToTask({ id: newer.id })),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: newer, prompt: "P1" },
          taskId: newer.id,
          requestId: 1,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    model((m) => expect([m.taskId, m.prompt]).toEqual([newer.id, "P1"])),
    message(Message.PressedNext()),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: older, prompt: "P2" },
          taskId: older.id,
          requestId: 2,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    model((m) => expect(m.taskId).toBe(older.id)),
    message(Message.PressedNext()),
    model((m) => expect(m.taskId).toBe(older.id)),
  ))

test("search and @list narrow the timeline the keys walk", () =>
  story(
    update,
    given(loaded),
    message(Message.ChangedQuery({ value: "@ai" })),
    message(Message.PressedNext()),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: older, prompt: "P" },
          taskId: older.id,
          requestId: 1,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    model((m) => expect(m.taskId).toBe(older.id)),
    message(Message.PressedClear()),
    model((m) => expect(m.query).toBe("")),
    message(Message.PickedList({ value: "ms" })),
    model((m) => expect(m.listId).toBe("ms")),
  ))

test("a stale detail response is ignored", () =>
  story(
    update,
    given(loaded),
    message(Message.PickedTask({ value: older.id })),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: older, prompt: "old" },
          taskId: older.id,
          requestId: 1,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    message(Message.PickedTask({ value: newer.id })),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: newer, prompt: "new" },
          taskId: newer.id,
          requestId: 2,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    message(
      Message.LoadedDetail({
        value: { task: older, prompt: "old" },
        taskId: older.id,
        requestId: 1,
      }),
    ),
    model((m) => expect([m.taskId, m.prompt]).toEqual([newer.id, "new"])),
  ))

test("Draft sends the edited prompt with the task's list, saves the repo, and closes on success", () =>
  story(
    update,
    given(loaded),
    message(Message.PickedTask({ value: older.id })),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: older, prompt: "Server" },
          taskId: older.id,
          requestId: 1,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    message(Message.ClickedDraft()),
    model((m) => expect(m.drafting).toBe(false)),
    message(Message.PickedFolder({ value: "r" })),
    message(Message.ChangedPrompt({ value: "Server, plus my notes" })),
    message(Message.ClickedDraft()),
    Command.expectHas(
      Draft({ folderId: "r", listId: "ai", taskId: older.id, prompt: "Server, plus my notes" }),
      SaveLastFolder({ id: "r" }),
    ),
    Command.resolveAll([Draft, Message.FailedDraft({ error: "offline" })], [SaveLastFolder, Message.Completed()]),
    model((m) => expect([m.drafting, m.error, m.prompt]).toEqual([false, "offline", "Server, plus my notes"])),
  ))

test("an unedited prompt is not sent, so the server builds it", () =>
  story(
    update,
    given({ ...loaded, folderId: "r" }),
    message(Message.PickedTask({ value: newer.id })),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: newer, prompt: "Server" },
          taskId: newer.id,
          requestId: 1,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    message(Message.ClickedDraft()),
    Command.expectHas(Draft({ folderId: "r", listId: "ms", taskId: newer.id }), SaveLastFolder({ id: "r" })),
    Command.resolveAll([Draft, Message.Drafted({ id: "12345678-x" })], [SaveLastFolder, Message.Completed()]),
    model((m) => expect(m.drafting).toBe(false)),
  ))

test("the production Draft command posts todo identity and selects the returned worker", async () => {
  let requestBody: unknown
  let requestUrl = ""
  let requestMethod = ""
  vi.stubGlobal("fetch", async (url: string, requestInit: RequestInit) => {
    requestUrl = String(url)
    requestMethod = requestInit.method ?? ""
    requestBody = JSON.parse(String(requestInit.body))
    return new Response(JSON.stringify({ id: "12345678-abcd" }), {
      headers: { "content-type": "application/json" },
    })
  })
  let selected: string | undefined
  window.addEventListener(
    "sf:select-worker",
    (event) => {
      if (event instanceof CustomEvent) selected = String(event.detail)
    },
    { once: true },
  )

  vi.resetModules()
  const { Draft: ProductionDraft } = await import("./command")
  const result = await Effect.runPromise(
    ProductionDraft({
      folderId: "repo",
      prompt: "Saved draft prompt",
      listId: "list",
      taskId: "task",
    }).effect,
  )

  expect(requestUrl).toContain("/api/drafts")
  expect(requestMethod).toBe("POST")
  expect(requestBody).toEqual({
    folderId: "repo",
    prompt: "Saved draft prompt",
    todo: { source: "ticktick", listId: "list", taskId: "task" },
  })
  expect(result).toEqual(Message.Drafted({ id: "12345678-abcd" }))
  expect(selected).toBe("draft-12345678")
})

test("ArrowUp with nothing selected picks the oldest; moving into a collapsed group opens it", () =>
  story(
    update,
    given(loaded),
    message(Message.PressedPrevious()),
    Command.resolveAll(
      [LoadDetail, Message.LoadedDetail({ value: { task: older, prompt: "P" }, taskId: older.id, requestId: 1 })],
      [ScrollToTask, Message.Completed()],
    ),
    model((m) => expect([m.taskId, m.expanded]).toEqual([older.id, ["This week"]])),
  ))

test("a failed detail can be retried by picking the task again", () =>
  story(
    update,
    given(loaded),
    message(Message.PickedTask({ value: older.id })),
    Command.resolveAll(
      [LoadDetail, Message.FailedDetail({ error: "down", taskId: older.id, requestId: 1 })],
      [ScrollToTask, Message.Completed()],
    ),
    model((m) => expect([AsyncData.isFailure(m.detail), m.error]).toEqual([true, "down"])),
    message(Message.PickedTask({ value: older.id })),
    Command.expectHas(LoadDetail({ id: older.id, requestId: 2 })),
    Command.resolveAll(
      [LoadDetail, Message.LoadedDetail({ value: { task: older, prompt: "P" }, taskId: older.id, requestId: 2 })],
      [ScrollToTask, Message.Completed()],
    ),
    model((m) => expect(m.prompt).toBe("P")),
  ))

test("reopening starts with no task selected, so nothing drafts twice", () =>
  story(
    update,
    given({ ...loaded, taskId: older.id, prompt: "old", query: "x", expanded: ["June 2026"] }),
    message(Message.ClickedOpen()),
    model((m) =>
      expect([m.taskId, m.prompt, m.query, m.expanded, AsyncData.isIdle(m.detail)]).toEqual(["", "", "", [], true]),
    ),
    Command.resolveAll(
      [ReadTime, Message.CompletedReadTime({ now: NOW })],
      [LoadStatus, Message.Failed({ error: "x" })],
      [LoadLists, Message.Failed({ error: "x" })],
      [LoadFolders, Message.Failed({ error: "x" })],
      [LoadLastFolder, Message.LoadedLastFolder({ value: "" })],
      [FocusSearch, Message.Completed()],
      [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
    ),
  ))
