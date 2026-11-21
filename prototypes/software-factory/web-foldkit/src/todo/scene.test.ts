import { Command, Mount, Subscription, change, click, expect, given, label, role, scene } from "foldkit/scene"
import { Dialog } from "@foldkit/ui"
import { test } from "vitest"
import { LoadDetail, LoadFolders, LoadLists, LoadStatus, LoadTasks } from "./command"
import { Message } from "./message"
import { init, update } from "./update"
import { view } from "./view"
test("todo view shows connection, linked task badges, prompt and repo picker", () => {
  const task = { id: "t", title: "Ship it", threadId: "thread-1" }
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.ClickedOpen()),
    Command.resolveAll(
      [LoadStatus, Message.LoadedStatus({ value: { state: "expired" } })],
      [LoadLists, Message.LoadedLists({ value: [{ id: "l", name: "Inbox" }] })],
      [LoadFolders, Message.LoadedFolders({ value: [{ id: "r", name: "repo", path: "/r" }] })],
    ),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(role("link", { name: "Reconnect" })).toExist(),
    expect(role("button", { name: "Draft" })).toBeDisabled(),
    click(role("button", { name: "Inbox" })),
    Command.resolve(LoadTasks, Message.LoadedTasks({ value: [task], listId: "l", requestId: 1 })),
    click(role("button", { name: /Ship it/ })),
    Command.resolve(
      LoadDetail,
      Message.LoadedDetail({
        value: { task, prompt: "Server preview" },
        listId: "l",
        taskId: "t",
        requestId: 1,
      }),
    ),
    expect(role("link", { name: "Open factory thread" })).toHaveAttr("href", "?thread=thread-1"),
    expect(label("Repo")).toExist(),
    expect(role("dialog")).toContainText("Server preview"),
    change(label("Repo"), "r"),
    expect(role("button", { name: "Draft" })).not.toBeDisabled(),
  )
})

test("todo view shows connected expiry and active store", () =>
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.ClickedOpen()),
    Command.resolveAll(
      [
        LoadStatus,
        Message.LoadedStatus({
          value: {
            state: "connected",
            expiresAt: Date.UTC(2026, 11, 1),
            store: "file",
            warn: true,
          },
        }),
      ],
      [LoadLists, Message.LoadedLists({ value: [] })],
      [LoadFolders, Message.LoadedFolders({ value: [] })],
    ),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(role("dialog")).toContainText("store file"),
    expect(role("dialog")).toContainText("(soon)"),
  ))
