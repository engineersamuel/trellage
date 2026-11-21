import { AsyncData } from "foldkit"
import { Command, given, message, model, story } from "foldkit/story"
import { Dialog } from "@foldkit/ui"
import { expect, test } from "vitest"
import { Draft, LoadDetail, LoadFolders, LoadLists, LoadStatus, LoadTasks } from "./command"
import { Message } from "./message"
import { init, update } from "./update"
const task = { id: "t", title: "Ship it" }
test("todo selects a task and drafts it into the picked repo", () =>
  story(
    update,
    given(init().model),
    message(Message.LoadedFolders({ value: [{ id: "r", name: "repo", path: "/r" }] })),
    message(Message.PickedFolder({ value: "r" })),
    message(Message.PickedList({ value: "l" })),
    Command.resolve(LoadTasks, Message.LoadedTasks({ value: [task] })),
    message(Message.PickedTask({ value: "t" })),
    Command.resolve(LoadDetail, Message.LoadedDetail({ value: { task, prompt: "Server preview" } })),
    message(Message.ClickedDraft()),
    Command.expectHas(Draft({ folderId: "r", listId: "l", taskId: "t" })),
    Command.resolve(Draft, Message.Failed({ error: "offline" })),
    model((m) =>
      expect([m.folderId, m.listId, m.taskId, AsyncData.isSuccess(m.detail), m.error]).toEqual([
        "r",
        "l",
        "t",
        true,
        "offline",
      ]),
    ),
  ))
test("todo closes after a draft succeeds", () =>
  story(
    update,
    given(init().model),
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
    model((m) => expect(m.dialog.isOpen).toBe(false)),
  ))
