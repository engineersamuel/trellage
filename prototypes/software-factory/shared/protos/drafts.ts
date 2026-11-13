// Drafts in the Inbox: the "+ Draft" form, and the detail of one draft (actions, rewrites, versions, reports).
// A draft is a repo-folder thread that starts no work until Run (coordinator/src/drafts.ts).
import { Effect, Schema } from "effect"
import { markdown } from "../decisions"
import { json, send } from "../http"
import { Draft } from "../schemas"
import { el, type Agent, type Folder, type Thread } from "./core"

const ACTIONS = [
  ["enhance", "✨", "Enhance"],
  ["council", "🏛", "Council"],
  ["debate", "⚖", "Debate"],
  ["research", "🔎", "Research"],
  ["hyperresearch", "📚", "Hyperresearch"],
  ["deep-research", "🌐", "Deep research"],
  ["run", "▶", "Run"],
] as const
type Action = (typeof ACTIONS)[number][0]
const LABEL: Record<string, string> = Object.fromEntries(ACTIONS.map(([a, , l]) => [a, l]))

/** An API error body is `{ error }`; its text, else the raw reason. */
const errorText = (reason: string) => {
  try {
    return String(JSON.parse(reason).error ?? reason)
  } catch {
    return reason
  }
}

/** Line diff of two prompts (LCS): unchanged lines " ", removed "-", added "+". */
const lineDiff = (a: string[], b: string[]): [" " | "-" | "+", string][] => {
  const L = a.map(() => b.map(() => 0).concat(0)).concat([b.map(() => 0).concat(0)])
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      L[i]![j] = a[i] === b[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
  const out: [" " | "-" | "+", string][] = []
  let i = 0,
    j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push([" ", a[i++]!])
      j++
    } else if (j < b.length && (i === a.length || L[i]![j + 1]! >= L[i + 1]![j]!)) out.push(["+", b[j++]!])
    else out.push(["-", a[i++]!])
  }
  return out
}

const button = (text: string, onClick: () => void, cls = "") => {
  const b = el("button", cls, text)
  b.type = "button"
  b.onclick = (e) => (e.stopPropagation(), onClick())
  return b
}

/** "+ Draft": a button that opens an inline form; Create posts the draft and passes its thread id on. */
export const draftForm = (repos: () => readonly Folder[], created: (threadId: string) => void): HTMLElement => {
  const box = el("div", "p3-newdraft")
  const form = el("form", "p3-draft-form")
  const folder = el("select")
  folder.setAttribute("aria-label", "Repo folder")
  const text = el("textarea")
  text.placeholder = "What should the factory do?"
  text.rows = 4
  text.setAttribute("aria-label", "Draft prompt")
  const err = el("div", "p3-err p3-sub")
  const create = el("button", "primary", "Create")
  create.type = "submit"
  form.append(folder, text, err, create)
  form.hidden = true
  const open = button(
    "＋ Draft",
    () => {
      form.hidden = !form.hidden
      if (form.hidden) return
      const list = repos()
      folder.replaceChildren(...list.map((f) => Object.assign(el("option", "", f.name), { value: f.id })))
      err.textContent = list.length ? "" : "No repo folder yet: add one first."
      text.focus()
    },
    "p3-new",
  )
  open.dataset.testid = "new-draft"
  open.title = "Write a prompt as a draft first: refine, enhance or research it before a run starts"
  form.onsubmit = (e) => {
    e.preventDefault()
    const prompt = text.value.trim()
    if (!prompt || !folder.value) return
    create.disabled = true
    err.textContent = ""
    void Effect.runPromise(
      json("/api/drafts", Schema.Struct({ id: Schema.String }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ folderId: folder.value, prompt }),
      }).pipe(
        Effect.match({
          onFailure: (failure) => ({ error: errorText(failure.reason) }),
          onSuccess: (t) => ({ id: t.id }),
        }),
      ),
    ).then((r) => {
      create.disabled = false
      if ("error" in r) return void (err.textContent = `Create failed: ${r.error}`)
      text.value = ""
      form.hidden = true
      created(r.id)
    })
  }
  box.append(open, form)
  return box
}

/** Draft actions waiting for the server, and the last error per draft. Kept across renders. */
const busy = new Map<string, Action>()
const errs = new Map<string, string>()

/** POST a draft endpoint; the reply is the new Draft. Resolves to the error text, or null. */
const post = (id: string, path: string, body?: unknown) =>
  Effect.runPromise(
    json(`/api/drafts/${id}/${path}`, Draft, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }).pipe(Effect.match({ onFailure: (e) => errorText(e.reason), onSuccess: () => null })),
  )

/** Read-only report from the draft's worktree, in a dialog. Esc, ✕ or a click outside closes it. */
const openReport = (threadId: string, path: string) => {
  const back = el("div", "sfs-backdrop")
  const box = el("div", "sfs-modal p2-history")
  box.setAttribute("role", "dialog")
  box.setAttribute("aria-label", `Report ${path}`)
  const head = el("div", "sfs-head")
  const close = el("button", "sfs-x", "✕")
  close.setAttribute("aria-label", "Close")
  head.append(el("b", "", path), close)
  const body = el("div", "sfs-body p3-report", "Loading…")
  box.append(head, body)
  back.append(box)
  const done = () => (back.remove(), window.removeEventListener("keydown", onKey, true))
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), done())
  close.onclick = done
  back.onclick = (e) => e.target === back && done()
  window.addEventListener("keydown", onKey, true)
  document.body.append(back)
  close.focus()
  const q = new URLSearchParams({ path, thread: threadId })
  void Effect.runPromise(
    json(`/api/reports?${q}`, Schema.Struct({ content: Schema.String })).pipe(
      Effect.match({
        onFailure: (e) => void (body.textContent = `Report not available: ${e.reason}`),
        onSuccess: (r) => void (body.innerHTML = markdown(r.content)),
      }),
    ),
  )
}

/** The draft detail: action buttons for the header, and the body (rewrites to pick, versions, reports). */
export const draftDetail = (
  t: Thread,
  agents: readonly Agent[],
  redraw: () => void,
  ran: () => void,
): { acts: HTMLElement[]; body: HTMLElement[] } => {
  const d = t.draft!
  const running = (id: string) => agents.some((a) => a.id === id && a.status === "running")
  /** Why an action cannot start now, or null. */
  const blocked = (a: Action): string | null => {
    const b = busy.get(t.id)
    if (b) return b === "enhance" ? "Enhancing…" : `${LABEL[b]} is starting…`
    if (a === "enhance") return null
    if (d.pending) return "Pick a rewrite first"
    if (a === "run") {
      const r = d.reports.find((x) => running(x.workerId))
      const owner = `draft-${t.id.slice(0, 8)}`
      return r
        ? `${LABEL[r.action]} is running`
        : agents.some((x) => x.owner === owner && x.status === "running")
          ? "A draft worker is running"
          : null
    }
    return d.reports.some((r) => r.action === a && running(r.workerId)) ? `${LABEL[a]} is running` : null
  }
  const act = (a: Action) => {
    busy.set(t.id, a)
    errs.delete(t.id)
    redraw()
    void post(t.id, a).then((err) => {
      busy.delete(t.id)
      if (err) errs.set(t.id, err)
      else if (a === "run") ran()
      redraw()
    })
  }
  const change = (path: string, body: unknown) => {
    errs.delete(t.id)
    void post(t.id, path, body).then((err) => {
      if (err) errs.set(t.id, err)
      redraw()
    })
  }
  const remove = () => {
    if (
      !confirm(
        `Delete draft "${t.title}"?\n\nThis removes the draft, its worktree ${t.worktree ?? ""} (reports too), and the local branch ${t.branch ?? ""}. It cannot be undone.`,
      )
    )
      return
    errs.delete(t.id)
    void Effect.runPromise(
      send(`/api/drafts/${t.id}`, "DELETE").pipe(
        Effect.match({ onFailure: (e) => errorText(e.reason), onSuccess: () => null }),
      ),
    ).then((err) => {
      if (err) errs.set(t.id, `Delete failed: ${err}`)
      redraw()
    })
  }

  const acts = ACTIONS.map(([a, icon, label]) => {
    const why = blocked(a)
    const b = button(`${icon} ${label}`, () => act(a), a === "run" ? "primary" : "")
    b.disabled = !!why
    b.title = why ?? label
    return b
  })
  const del = button("✕ Delete", remove)
  del.title = "Delete draft, its worktree, and branch"
  acts.push(del)

  const body: HTMLElement[] = []
  const err = errs.get(t.id)
  if (err) body.push(el("div", "p3-err p3-draft-err", err))
  const b = busy.get(t.id)
  if (b) body.push(el("div", "p3-sub", b === "enhance" ? "Enhancing…" : `${LABEL[b]} is starting…`))
  if (d.pending) {
    body.push(el("h4", "", "Pick a rewrite"))
    const row = el("div", "p3-cands")
    d.pending.candidates.forEach((c, i) => {
      const card = el("div", "p3-cand")
      card.append(
        el("b", "", c.title),
        el("div", "p3-cand-prompt", c.prompt),
        el("div", "p3-sub", c.notes),
        button("Pick", () => change("pick", { index: i })),
      )
      row.append(card)
    })
    const keep = button("Keep current", () => change("dismiss", undefined))
    keep.title = "Dismiss the rewrites and keep the current prompt"
    body.push(row, keep)
  }
  body.push(el("h4", "", "Versions"))
  for (let i = d.versions.length - 1; i >= 0; i--) {
    const v = d.versions[i]!
    const row = el("div", "p3-ver")
    const head = el("div", "p3-row")
    head.append(el("b", "", `v${i + 1}`), el("span", "p3-sub", v.source), el("span", "p3-ell", v.title ?? ""))
    if (v.id === d.current) head.append(el("span", "p3-pill s-idle", "current"))
    else {
      const use = button("Use", () => change("current", { versionId: v.id }))
      use.title = `Make v${i + 1} the current prompt`
      head.append(use)
    }
    row.append(head)
    if (v.notes) row.append(el("div", "p3-sub", v.notes))
    if (!i) row.append(el("pre", "p3-draft", v.prompt))
    else {
      const diff = el("div", "p3-diff")
      diff.setAttribute("aria-label", `Changes from v${i} to v${i + 1}`)
      for (const [op, line] of lineDiff(d.versions[i - 1]!.prompt.split("\n"), v.prompt.split("\n")))
        diff.append(el("div", op === "-" ? "del" : op === "+" ? "add" : "same", `${op} ${line}`))
      row.append(diff)
    }
    body.push(row)
  }
  if (d.reports.length) {
    body.push(el("h4", "", "Reports"))
    const chips = el("div", "p3-acts")
    for (const r of d.reports) {
      const v = `v${d.versions.findIndex((x) => x.id === r.versionId) + 1}`
      if (running(r.workerId)) chips.append(el("span", "p3-sub", `${LABEL[r.action]} · ${v} · running…`))
      else {
        const open = button(`📄 ${LABEL[r.action]} · ${v}`, () => openReport(t.id, r.path))
        open.title = `Open ${r.path}`
        chips.append(open)
      }
    }
    body.push(chips)
  }
  return { acts, body }
}
