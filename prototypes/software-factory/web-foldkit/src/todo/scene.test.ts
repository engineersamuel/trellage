import { Command, Mount, Subscription, change, click, expect, given, label, role, scene } from "foldkit/scene"
import { Dialog } from "@foldkit/ui"
import { test } from "vitest"
import { LoadDetail, LoadFolders, LoadLists, LoadStatus, LoadTasks } from "./command"
import { Message } from "./message"
import { init, update } from "./update"
import { view } from "./view"
test("todo view shows connection, linked task badges, prompt and repo picker", () => {
  const task = {
    id: "t",
    title: "Ship it",
    dueDate: "2026-12-01",
    priority: 3,
    tags: ["next", "work"],
    threadId: "thread-1",
  }
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
    expect(role("button", { name: "Inbox" })).toHaveAttr("aria-current", "true"),
    Command.resolve(LoadTasks, Message.LoadedTasks({ value: [task], listId: "l", requestId: 1 })),
    expect(role("button", { name: /Ship it.*2026-12-01.*priority 3.*next, work/ })).toExist(),
    click(role("button", { name: /Ship it/ })),
    expect(role("button", { name: /Ship it/ })).toHaveAttr("aria-current", "true"),
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
    expect(role("region", { name: "Draft prompt preview" })).toHaveText("Server preview"),
    change(label("Repo"), "r"),
    expect(label("Repo")).toHaveValue("r"),
    expect(role("button", { name: "Draft" })).not.toBeDisabled(),
  )
})

test("todo view shows Connect for a disconnected account", () =>
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.ClickedOpen()),
    Command.resolveAll(
      [LoadStatus, Message.LoadedStatus({ value: { state: "disconnected" } })],
      [LoadLists, Message.LoadedLists({ value: [] })],
      [LoadFolders, Message.LoadedFolders({ value: [] })],
    ),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(role("link", { name: "Connect" })).toHaveAttr("href", "/api/todo/ticktick/connect"),
  ))

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
    expect(role("link", { name: "Reconnect" })).toExist(),
    expect(role("dialog")).toContainText(`expires ${new Date(Date.UTC(2026, 11, 1)).toLocaleDateString()}`),
    expect(role("dialog")).toContainText("store file"),
    expect(role("dialog")).toContainText("(soon)"),
  ))

test("todo view exposes loading and request errors", () =>
  scene(
    { update, view },
    given(init().model),
    Subscription.emit(Message.ClickedOpen()),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    expect(role("dialog")).toContainText("Loading Todo…"),
    Command.resolve(LoadStatus, Message.Failed({ error: "TickTick is unavailable" })),
    Command.resolve(LoadLists, Message.Failed({ error: "TickTick is unavailable" })),
    Command.resolve(LoadFolders, Message.Failed({ error: "TickTick is unavailable" })),
    expect(role("dialog")).not.toContainText("Loading Todo…"),
    expect(role("alert")).toHaveText("TickTick is unavailable"),
  ))
