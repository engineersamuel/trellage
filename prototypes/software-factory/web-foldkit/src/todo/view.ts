import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Button, Dialog, Select } from "@foldkit/ui"
import { Message } from "./message"
import { canDraft } from "./model"
import type { Model } from "./model"
import type { Detail, Status, Task, TodoList } from "./domain"
import type { Folder } from "../../../shared/schemas"
const CONNECT = "/api/todo/ticktick/connect"
const expiry = (value: number | undefined) => (value ? new Date(value).toLocaleDateString() : "")
const text = (x: unknown) => String(x ?? "")
const button = (label: string, onClick: Message, h: HtmlBuilder<Message>, disabled = false, selected = false) =>
  Button.view(
    {
      onClick,
      toView: (a) =>
        h.button(
          [...a.button, h.Disabled(disabled), ...(selected ? [h.AriaCurrent("true"), h.Class("is-selected")] : [])],
          [label],
        ),
    },
    h,
  )
const picker = (m: Model, folders: ReadonlyArray<Folder>, h: HtmlBuilder<Message>) =>
  Select.view(
    {
      id: "todo-repo",
      value: m.folderId,
      onChange: (value) => Message.PickedFolder({ value }),
      toView: (a) =>
        h.span(
          [h.Class("fk-field")],
          [
            h.label([...a.label], ["Repo"]),
            h.select(
              [...a.select],
              [h.option([h.Value("")], ["choose a repo"]), ...folders.map((f) => h.option([h.Value(f.id)], [f.name]))],
            ),
          ],
        ),
    },
    h,
  )
const content = (m: Model, r: Dialog.RenderInfo, h: HtmlBuilder<Message>): Html[] => {
  const state: Status | undefined = Option.getOrUndefined(AsyncData.getData(m.status))
  const tasks: ReadonlyArray<Task> = Option.getOrElse(AsyncData.getData(m.tasks), () => [])
  const lists: ReadonlyArray<TodoList> = Option.getOrElse(AsyncData.getData(m.lists), () => [])
  const folders: ReadonlyArray<Folder> = Option.getOrElse(AsyncData.getData(m.folders), () => []).filter(
    (f) => f.path !== "",
  )
  const detail: Detail | undefined = Option.getOrUndefined(AsyncData.getData(m.detail))
  const connected = (state?.state ?? state?.status) === "connected"
  const loading =
    !m.error &&
    (AsyncData.isPending(m.status) ||
      AsyncData.isPending(m.lists) ||
      AsyncData.isPending(m.tasks) ||
      AsyncData.isPending(m.detail) ||
      AsyncData.isPending(m.folders))
  return [
    h.header(
      [],
      [
        h.h2([...r.title], ["Todo"]),
        h.a([h.Href(CONNECT)], [connected || (state?.state ?? state?.status) === "expired" ? "Reconnect" : "Connect"]),
        h.span(
          [h.Class("fk-muted")],
          [
            state?.expiresAt ? ` · expires ${expiry(state.expiresAt)}${state.warn ? " (soon)" : ""}` : "",
            state?.store ? ` · store ${state.store}` : "",
          ],
        ),
        h.button([...r.closeButton, h.AriaLabel("Close todo")], ["✕"]),
      ],
    ),
    loading ? h.p([h.Class("fk-muted")], ["Loading Todo…"]) : h.empty,
    m.error ? h.p([h.Role("alert"), h.Class("fk-error")], [m.error]) : h.empty,
    h.div(
      [h.Class("fk-row")],
      [
        h.section(
          [],
          [
            h.h3([], ["Lists"]),
            h.ul(
              [h.Class("fk-list")],
              lists.map((l) =>
                h.keyed("li")(
                  l.id,
                  [],
                  [button(l.name, Message.PickedList({ value: l.id }), h, false, m.listId === l.id)],
                ),
              ),
            ),
          ],
        ),
        h.section(
          [],
          [
            h.h3([], ["Tasks"]),
            h.ul(
              [h.Class("fk-list")],
              tasks.map((t) =>
                h.keyed("li")(
                  t.id,
                  [],
                  [
                    button(
                      [
                        t.title,
                        t.dueDate ? ` · ${t.dueDate}` : "",
                        ` · priority ${t.priority ?? "-"}`,
                        ` · ${text(t.tags?.join(", "))}`,
                      ].join(""),
                      Message.PickedTask({ value: t.id }),
                      h,
                      false,
                      m.taskId === t.id,
                    ),
                    t.threadId
                      ? h.a(
                          [h.Href(`?thread=${encodeURIComponent(t.threadId)}`), h.AriaLabel("Open factory thread")],
                          [" factory"],
                        )
                      : h.empty,
                  ],
                ),
              ),
            ),
          ],
        ),
        h.section(
          [],
          [
            h.h3([], ["Task"]),
            detail
              ? h.pre(
                  [h.Role("region"), h.AriaLabel("Draft prompt preview")],
                  [text(detail.prompt ?? detail.task.prompt ?? detail.task.content ?? detail.task.desc)],
                )
              : h.p([h.Class("fk-muted")], ["Pick a task"]),
            picker(m, folders, h),
            button(m.drafting ? "Drafting…" : "Draft", Message.ClickedDraft(), h, !canDraft(m)),
          ],
        ),
      ],
    ),
  ]
}
export const view = Submodel.defineView<Model, Message>((m, h) =>
  h.submodel({
    slotId: m.dialog.id,
    model: m.dialog,
    view: Dialog.view,
    viewInputs: {
      hasDescription: false,
      toView: (r) =>
        h.dialog(
          [...r.dialog, h.Class("fk-dialog")],
          r.isVisible
            ? [
                h.div([...r.backdrop, h.Class("fk-backdrop")]),
                h.div([...r.panel, h.Class("fk-drawer fk-goals")], content(m, r, h)),
              ]
            : [],
        ),
    },
    toParentMessage: (message) => Message.GotDialogMessage({ message }),
  }),
)
export const navButton = Submodel.defineView<Model, Message>((_m, h) => button("Todo", Message.ClickedOpen(), h))
