import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Dialog, Select } from "@foldkit/ui"
import { SEARCH_ID } from "./command"
import { Message } from "./message"
import { canDraft, detailOf } from "./model"
import type { Model } from "./model"
import type { Status, TodoList } from "./domain"
import type { Folder } from "../../../shared/schemas"
import {
  GROUP_LIMIT,
  OPEN_GROUPS,
  PRIORITY,
  type Row,
  ago,
  atList,
  createdAt,
  dateLabel,
  groups,
  rows,
  splitEmoji,
} from "./timeline"
const CONNECT = "/api/todo/ticktick/connect"
const expiry = (value: number | undefined) => (value ? new Date(value).toLocaleDateString() : "")

/** Title text with the matched characters in <mark>. */
const highlight = (title: string, hits: readonly number[], h: HtmlBuilder<Message>): (Html | string)[] => {
  if (!hits.length) return [title]
  const set = new Set(hits)
  const out: (Html | string)[] = []
  let run = "",
    on = false
  const flush = () => {
    if (run) out.push(on ? h.mark([], [run]) : run)
    run = ""
  }
  ;[...title].forEach((c, i) => {
    if (set.has(i) !== on) {
      flush()
      on = !on
    }
    run += c
  })
  flush()
  return out
}

const keyToMessage = (key: string): Option.Option<Message> =>
  key === "ArrowDown"
    ? Option.some(Message.PressedNext())
    : key === "ArrowUp"
      ? Option.some(Message.PressedPrevious())
      : Option.none()

const listsPane = (m: Model, lists: readonly TodoList[], scope: string, h: HtmlBuilder<Message>): Html => {
  const count = (id: string) => (m.tasks[id] ? String(m.tasks[id]!.length) : m.failedLists.includes(id) ? "!" : "…")
  const total = lists.reduce((n, l) => n + (m.tasks[l.id]?.length ?? 0), 0)
  const item = (id: string, icon: string, name: string, n: string) =>
    h.keyed("li")(
      id || "all",
      [],
      [
        h.button(
          [
            h.Type("button"),
            h.Class("fk-todo-list"),
            h.OnClick(Message.PickedList({ value: id })),
            ...(scope === id ? [h.AriaCurrent("true")] : []),
          ],
          [h.span([h.Class("fk-todo-ico")], [icon || "•"]), h.span([], [name]), h.span([h.Class("fk-todo-n")], [n])],
        ),
      ],
    )
  return h.nav(
    [h.Class("fk-todo-lists"), h.AriaLabel("Lists")],
    [
      h.h3([], ["Lists"]),
      h.ul(
        [],
        [
          item("", "✱", "All lists", String(total)),
          ...lists.map((l) => {
            const [e, n] = splitEmoji(l.name)
            return item(l.id, e, n, count(l.id))
          }),
        ],
      ),
    ],
  )
}

const card = (m: Model, r: Row, h: HtmlBuilder<Message>): Html => {
  const t = r.task
  const at = createdAt(t.id)
  const meta = [
    t.priority ? h.span([h.Class(`fk-todo-tag p${t.priority}`)], [PRIORITY[t.priority] ?? String(t.priority)]) : null,
    ...(t.tags ?? []).map((g) => h.span([h.Class(g === "factory" ? "fk-todo-tag factory" : "fk-todo-tag")], [g])),
    t.threadId
      ? h.a([h.Class("fk-todo-tag factory"), h.Href(`?thread=${encodeURIComponent(t.threadId)}`)], ["in factory"])
      : null,
  ].filter((x): x is Html => x !== null)
  return h.keyed("li")(
    t.id,
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.Class("fk-todo-card"),
          h.DataAttribute("task", t.id),
          h.OnClick(Message.PickedTask({ value: t.id })),
          ...(m.taskId === t.id ? [h.AriaCurrent("true")] : []),
        ],
        [
          h.span([h.Class("fk-todo-ico"), h.Title(r.list.name)], [splitEmoji(r.list.name)[0] || "•"]),
          h.span([h.Class("fk-todo-title")], highlight(r.title, r.hits, h)),
          h.span([h.Class("fk-todo-age"), h.Title(dateLabel(at))], [ago(at, m.now)]),
          meta.length ? h.span([h.Class("fk-todo-meta")], meta) : h.empty,
        ],
      ),
    ],
  )
}

const timeline = (m: Model, shown: readonly Row[], loading: boolean, h: HtmlBuilder<Message>): Html => {
  const searching = m.query.trim() !== ""
  if (!shown.length)
    return h.main(
      [h.Class("fk-todo-timeline")],
      [
        h.p(
          [h.Class("fk-todo-empty")],
          [loading ? "Loading tasks…" : searching ? `No task matches “${m.query.trim()}”.` : "No open tasks."],
        ),
      ],
    )
  return h.main(
    [h.Class("fk-todo-timeline")],
    [
      h.h3([], [`${shown.length} tasks · newest first${loading ? " · loading more…" : ""}`]),
      ...groups(shown, m.now).map(([name, rs]) => {
        const all = searching || OPEN_GROUPS.includes(name) || m.expanded.includes(name)
        const visible = all ? rs : rs.slice(0, GROUP_LIMIT)
        return h.keyed("section")(
          name,
          [h.Class("fk-todo-group")],
          [
            h.h4([], [name, h.small([], [String(rs.length)])]),
            h.ul(
              [],
              visible.map((r) => card(m, r, h)),
            ),
            visible.length < rs.length
              ? h.button(
                  [h.Type("button"), h.Class("fk-todo-more"), h.OnClick(Message.ClickedMore({ group: name }))],
                  [`Show ${rs.length - visible.length} more`],
                )
              : h.empty,
          ],
        )
      }),
    ],
  )
}

const picker = (m: Model, folders: readonly Folder[], h: HtmlBuilder<Message>) =>
  Select.view(
    {
      id: "todo-repo",
      value: m.folderId,
      onChange: (value) => Message.PickedFolder({ value }),
      toView: (a) =>
        h.span(
          [h.Class("fk-field fk-todo-repo")],
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

const detailPane = (m: Model, every: readonly Row[], folders: readonly Folder[], h: HtmlBuilder<Message>): Html => {
  const row = every.find((r) => r.task.id === m.taskId)
  const detail = detailOf(m)
  if (!m.taskId)
    return h.aside(
      [h.Class("fk-todo-detail")],
      [h.p([h.Class("fk-todo-empty")], ["Pick a task. ↑ ↓ move, / searches."])],
    )
  const at = createdAt(m.taskId)
  return h.aside(
    [h.Class("fk-todo-detail")],
    [
      h.p([h.Class("fk-todo-head")], [row?.title ?? detail?.task.title ?? ""]),
      h.p([h.Class("fk-muted")], [`${row?.list.name ?? ""} · ${dateLabel(at)} · ${ago(at, m.now)} ago`]),
      h.label([h.For("todo-prompt")], ["Draft prompt · edit before you draft"]),
      AsyncData.isLoading(m.detail)
        ? h.p([h.Class("fk-muted")], ["Loading prompt…"])
        : h.textarea([h.Id("todo-prompt"), h.Value(m.prompt), h.OnInput((value) => Message.ChangedPrompt({ value }))]),
      h.div(
        [h.Class("fk-todo-go")],
        [
          picker(m, folders, h),
          h.button(
            [h.Type("button"), h.Class("fk-todo-draft"), h.Disabled(!canDraft(m)), h.OnClick(Message.ClickedDraft())],
            [m.drafting ? "Drafting…" : "Draft"],
          ),
        ],
      ),
    ],
  )
}

const content = (m: Model, r: Dialog.RenderInfo, h: HtmlBuilder<Message>): Html[] => {
  const state: Status | undefined = Option.getOrUndefined(AsyncData.getData(m.status))
  const lists: readonly TodoList[] = Option.getOrElse(AsyncData.getData(m.lists), () => [])
  const folders: readonly Folder[] = Option.getOrElse(AsyncData.getData(m.folders), () => []).filter(
    (f) => f.path !== "",
  )
  const connected = (state?.state ?? state?.status) === "connected"
  const picked = atList(lists, m.query)
  const scope = picked?.id ?? m.listId
  const shown = rows(lists, m.tasks, scope, m.query)
  const loading = AsyncData.isLoading(m.lists) || lists.some((l) => !m.tasks[l.id] && !m.failedLists.includes(l.id))
  const scopeName = scope ? (lists.find((l) => l.id === scope)?.name ?? "") : "all lists"
  return [
    h.header(
      [h.Class("fk-todo-top")],
      [
        h.h2([...r.title], ["Todo"]),
        h.label(
          [h.Class("fk-todo-search")],
          [
            h.span([h.AriaHidden(true)], ["🔎"]),
            h.input([
              h.Id(SEARCH_ID),
              h.Type("search"),
              h.Placeholder("Search tasks…  try @ai or @micro to pick a list"),
              h.AriaLabel("Search tasks"),
              h.Value(m.query),
              h.OnInput((value) => Message.ChangedQuery({ value })),
            ]),
            h.span([h.Class("fk-todo-scope")], [`in ${scopeName}`]),
          ],
        ),
        h.span(
          [h.Class("fk-muted fk-todo-conn")],
          [
            h.a(
              [h.Href(CONNECT)],
              [connected || (state?.state ?? state?.status) === "expired" ? "Reconnect" : "Connect"],
            ),
            state?.expiresAt ? ` · expires ${expiry(state.expiresAt)}${state.warn ? " (soon)" : ""}` : "",
          ],
        ),
        h.button([...r.closeButton, h.AriaLabel("Close todo")], ["✕"]),
      ],
    ),
    m.error ? h.p([h.Role("alert"), h.Class("fk-error")], [m.error]) : h.empty,
    h.div(
      [h.Class("fk-todo-body")],
      [
        listsPane(m, lists, scope, h),
        timeline(m, shown, loading, h),
        detailPane(m, rows(lists, m.tasks, "", ""), folders, h),
      ],
    ),
  ]
}

/**
 * Keys on the Todo panel. In the search box ↑ ↓ move, Enter drafts the selected task when it is shown, Escape
 * clears; other typing stays in it. Elsewhere `/` focuses search and ↑ ↓ move; Enter keeps its normal action on
 * buttons and links. The prompt and the repo picker keep every key.
 */
const panelKey = (m: Model, key: string, isModified: boolean): Option.Option<Message> => {
  const focused = globalThis.document?.activeElement
  const tag = focused?.tagName ?? ""
  const inSearch = focused?.id === SEARCH_ID
  if (isModified) return Option.none()
  if (inSearch) {
    if (key === "Escape") return m.query ? Option.some(Message.PressedClear()) : Option.none()
    if (key === "Enter") return isVisible(m) && canDraft(m) ? Option.some(Message.ClickedDraft()) : Option.none()
    return keyToMessage(key)
  }
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return Option.none()
  if (key === "/") return Option.some(Message.PressedSearch())
  if (key === "Escape") return m.query ? Option.some(Message.PressedClear()) : Option.none()
  return keyToMessage(key)
}

/** The selected task is in the timeline the search and list show. */
const isVisible = (m: Model): boolean => {
  const lists = Option.getOrElse(AsyncData.getData(m.lists), () => [])
  return rows(lists, m.tasks, atList(lists, m.query)?.id ?? m.listId, m.query).some((r) => r.task.id === m.taskId)
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
                h.div(
                  [
                    ...r.panel,
                    h.Class("fk-todo"),
                    h.OnKeyDownPreventDefault((key, mods) => panelKey(m, key, mods.metaKey || mods.ctrlKey)),
                  ],
                  content(m, r, h),
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (message) => Message.GotDialogMessage({ message }),
  }),
)
export const navButton = Submodel.defineView<Model, Message>((_m, h) =>
  h.button([h.Type("button"), h.OnClick(Message.ClickedOpen())], ["Todo"]),
)
