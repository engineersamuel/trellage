import {
  Command,
  Mount,
  Subscription,
  change,
  click,
  expect,
  given,
  label,
  role,
  scene,
  text,
  type,
} from "foldkit/scene"
import { Dialog } from "@foldkit/ui"
import { test } from "vitest"
import {
  FocusSearch,
  LoadDetail,
  LoadFolders,
  LoadLastFolder,
  LoadLists,
  LoadStatus,
  LoadTasks,
  ReadTime,
  ScrollToTask,
} from "./command"
import { Message } from "./message"
import { init, update } from "./update"
import { view } from "./view"
const hex = (ms: number) =>
  Math.floor(ms / 1000)
    .toString(16)
    .padStart(8, "0") + "0000000000000000"
const NOW = new Date(2026, 10, 22, 15).getTime()
const today = {
  id: hex(NOW - 3600e3),
  title: "Factory loop idea",
  projectId: "ai",
  priority: 5,
  threadId: "th-1",
}
const old = {
  id: hex(new Date(2026, 5, 10).getTime()),
  title: "Loop library",
  projectId: "ai",
  tags: ["loops"],
}
const ms = { id: hex(NOW - 864e5), title: "Pfizer meeting", projectId: "ms" }

const opened = (status: Record<string, unknown>) =>
  [
    Subscription.emit(Message.ClickedOpen()),
    Command.resolveAll(
      [ReadTime, Message.CompletedReadTime({ now: NOW })],
      [LoadStatus, Message.LoadedStatus({ value: status })],
      [LoadFolders, Message.LoadedFolders({ value: [{ id: "r", name: "repo", path: "/r" }] })],
      [LoadLastFolder, Message.LoadedLastFolder({ value: "" })],
      [FocusSearch, Message.Completed()],
      [
        LoadLists,
        Message.LoadedLists({
          value: [
            { id: "ai", name: "🧠AI" },
            { id: "ms", name: "🇺🇸Microsoft" },
          ],
        }),
      ],
    ),
    Command.resolve(Dialog.ShowDialog, Dialog.Message.SucceededShowDialog()),
    Mount.resolve(Dialog.AcquireResources, Dialog.Message.SucceededAcquireResources()),
    Command.resolveAll(
      [LoadTasks, Message.LoadedTasks({ value: [old, today], listId: "ai" })],
      [LoadTasks, Message.LoadedTasks({ value: [ms], listId: "ms" })],
    ),
  ] as const

test("the Todo view shows lists, a newest-first timeline and the connection", () =>
  scene(
    { update, view },
    given(init().model),
    ...opened({ state: "connected", expiresAt: Date.UTC(2027, 4, 21), store: "keychain" }),
    expect(role("link", { name: "Reconnect" })).toExist(),
    expect(role("button", { name: /All lists\s*3/ })).toHaveAttr("aria-current", "true"),
    expect(text("3 tasks · newest first")).toExist(),
    expect(text("Today")).toExist(),
    expect(text("Yesterday")).toExist(),
    expect(text("June 2026")).toExist(),
    expect(role("link", { name: "in factory" })).toHaveAttr("href", "?thread=th-1"),
    expect(text("high")).toExist(),
    expect(text("Pick a task. ↑ ↓ move, / searches.")).toExist(),
  ))

test("search filters with highlights, a list narrows it, and a task shows its editable prompt", () =>
  scene(
    { update, view },
    given(init().model),
    ...opened({ state: "disconnected" }),
    expect(role("link", { name: "Connect" })).toExist(),
    type(label("Search tasks"), "loop"),
    expect(text("2 tasks · newest first")).toExist(),
    expect(text("Pfizer meeting")).not.toExist(),
    type(label("Search tasks"), "loop @micro"),
    expect(text("No task matches “loop @micro”.")).toExist(),
    type(label("Search tasks"), ""),
    click(role("button", { name: /Microsoft\s*1/ })),
    expect(text("1 tasks · newest first")).toExist(),
    click(role("button", { name: /Pfizer meeting/ })),
    expect(role("button", { name: /Pfizer meeting/ })).toHaveAttr("aria-current", "true"),
    Command.resolveAll(
      [
        LoadDetail,
        Message.LoadedDetail({
          value: { task: ms, prompt: "Pfizer meeting\n\nSource: TickTick" },
          taskId: ms.id,
          requestId: 1,
        }),
      ],
      [ScrollToTask, Message.Completed()],
    ),
    expect(label("Draft prompt · edit before you draft")).toHaveValue("Pfizer meeting\n\nSource: TickTick"),
    expect(role("button", { name: "Draft" })).toBeDisabled(),
    change(label("Repo"), "r"),
    expect(role("button", { name: "Draft" })).toBeEnabled(),
  ))
