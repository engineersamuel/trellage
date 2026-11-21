import { Option } from "effect"
import { Effect } from "effect"
import { AsyncData } from "foldkit"
import { Command, given, message, model, story } from "foldkit/story"
import { Dialog } from "@foldkit/ui"
import { afterEach, expect, test, vi } from "vitest"
import { Draft, LoadDetail, LoadFolders, LoadLists, LoadStatus, LoadTasks } from "./command"
import { Message } from "./message"
import { init, update } from "./update"
const task = { id: "t", title: "Ship it" }
afterEach(() => vi.unstubAllGlobals())
test("todo selects a task and drafts it into the picked repo", () =>
  story(
    update,
    given(init().model),
    message(Message.LoadedFolders({ value: [{ id: "r", name: "repo", path: "/r" }] })),
    message(Message.PickedFolder({ value: "r" })),
    message(Message.PickedList({ value: "l" })),
    Command.resolve(LoadTasks, Message.LoadedTasks({ value: [task], listId: "l", requestId: 1 })),
    message(Message.PickedTask({ value: "t" })),
    Command.resolve(
      LoadDetail,
      Message.LoadedDetail({
        value: { task, prompt: "Server preview" },
        listId: "l",
        taskId: "t",
        requestId: 1,
      }),
    ),
    message(Message.ClickedDraft()),
    Command.expectHas(Draft({ folderId: "r", prompt: "Server preview", listId: "l", taskId: "t" })),
    model((m) => expect([m.listId, m.taskId, m.folderId]).toEqual(["l", "t", "r"])),
    model((m) => expect(m.drafting).toBe(true)),
    Command.resolve(Draft, Message.FailedDraft({ error: "offline" })),
    model((m) =>
      expect([m.folderId, m.listId, m.taskId, AsyncData.isSuccess(m.detail), m.drafting, m.error]).toEqual([
        "r",
        "l",
        "t",
        true,
        false,
        "offline",
      ]),
    ),
  ))
test("todo closes after a draft succeeds", () =>
  story(
    update,
    given({ ...init().model, drafting: true }),
    message(Message.ClickedOpen()),
    model((m) => expect(m.dialog.isOpen).toBe(true)),
    Command.resolveAll(
      [LoadStatus, Message.Failed({ error: "offline" })],
      [LoadLists, Message.Failed({ error: "offline" })],
      [LoadFolders, Message.Failed({ error: "offline" })],
      [Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()],
    ),
    message(Message.Drafted({ id: "12345678-abcd" })),
    Command.resolve(Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()),
    model((m) => expect([m.dialog.isOpen, m.drafting]).toEqual([false, false])),
  ))

test("todo ignores task-list responses from a previously selected list", () =>
  story(
    update,
    given({
      ...init().model,
      listId: "list-b",
      listRequestId: 2,
      tasks: AsyncData.Loading(),
    }),
    message(
      Message.LoadedTasks({
        value: [{ id: "task-a", title: "From A" }],
        listId: "list-a",
        requestId: 2,
      }),
    ),
    model((m) => expect(Option.isNone(AsyncData.getData(m.tasks))).toBe(true)),
    message(
      Message.LoadedTasks({
        value: [{ id: "task-a", title: "From A" }],
        listId: "list-b",
        requestId: 1,
      }),
    ),
    model((m) => expect(Option.isNone(AsyncData.getData(m.tasks))).toBe(true)),
    message(
      Message.LoadedTasks({
        value: [{ id: "task-b", title: "From B" }],
        listId: "list-b",
        requestId: 2,
      }),
    ),
    model((m) => expect(AsyncData.getOrElse(m.tasks, () => []).map((item) => item.id)).toEqual(["task-b"])),
    message(Message.FailedTasks({ error: "stale failure", listId: "list-a", requestId: 1 })),
    model((m) => expect(m.error).toBe("")),
  ))

test("todo ignores task detail responses from a previously selected task", () =>
  story(
    update,
    given({
      ...init().model,
      folderId: "repo",
      listId: "list",
      taskId: "task-b",
      detailRequestId: 2,
      detail: AsyncData.Loading(),
    }),
    message(
      Message.LoadedDetail({
        value: { task: { id: "task-a", title: "A" }, prompt: "Prompt A" },
        listId: "other-list",
        taskId: "task-b",
        requestId: 2,
      }),
    ),
    model((m) => expect(Option.isNone(AsyncData.getData(m.detail))).toBe(true)),
    message(
      Message.LoadedDetail({
        value: { task: { id: "task-a", title: "A" }, prompt: "Prompt A" },
        listId: "list",
        taskId: "task-b",
        requestId: 1,
      }),
    ),
    model((m) => expect(Option.isNone(AsyncData.getData(m.detail))).toBe(true)),
    message(
      Message.LoadedDetail({
        value: { task: { id: "task-a", title: "A" }, prompt: "Prompt A" },
        listId: "list",
        taskId: "task-a",
        requestId: 2,
      }),
    ),
    model((m) => expect(Option.isNone(AsyncData.getData(m.detail))).toBe(true)),
    message(
      Message.LoadedDetail({
        value: { task: { id: "task-b", title: "B" }, prompt: "Prompt B" },
        listId: "list",
        taskId: "task-b",
        requestId: 2,
      }),
    ),
    message(Message.ClickedDraft()),
    Command.expectHas(Draft({ folderId: "repo", prompt: "Prompt B", listId: "list", taskId: "task-b" })),
    Command.resolve(Draft, Message.FailedDraft({ error: "offline" })),
    message(
      Message.FailedDetail({
        error: "stale failure",
        listId: "list",
        taskId: "task-a",
        requestId: 1,
      }),
    ),
    model((m) => expect(m.error).toBe("offline")),
  ))

test("todo drafts only from a fully matching loaded selection", () => {
  const detail = { task: { id: "task", title: "Task" }, prompt: "Prompt" }
  const ready = {
    ...init().model,
    folderId: "repo",
    listId: "list",
    taskId: "task",
    detailListId: "list",
    detail: AsyncData.succeed(detail),
  }
  const invalid = [
    { ...ready, folderId: "" },
    { ...ready, listId: "", detailListId: "" },
    { ...ready, taskId: "", detail: AsyncData.succeed({ ...detail, task: { ...detail.task, id: "" } }) },
    { ...ready, detailListId: "other-list" },
    { ...ready, detail: AsyncData.succeed({ ...detail, task: { ...detail.task, id: "other-task" } }) },
    { ...ready, detail: AsyncData.Loading() },
  ]

  expect(invalid).toHaveLength(6)
  for (const candidate of invalid) story(update, given(candidate), message(Message.ClickedDraft()))
})

test("todo keeps a draft pending when an unrelated request fails", () => {
  const detail = { task: { id: "task", title: "Task" }, prompt: "Prompt" }
  const started = update(
    {
      ...init().model,
      folderId: "repo",
      listId: "list",
      taskId: "task",
      detailListId: "list",
      detail: AsyncData.succeed(detail),
    },
    Message.ClickedDraft(),
  )
  expect(started.commands).toHaveLength(1)

  const afterFailure = update(started.model, Message.Failed({ error: "status unavailable" }))
  expect([afterFailure.model.drafting, afterFailure.model.error]).toEqual([true, "status unavailable"])

  const clickedAgain = update(afterFailure.model, Message.ClickedDraft())
  expect(clickedAgain.commands ?? []).toHaveLength(0)
})

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
