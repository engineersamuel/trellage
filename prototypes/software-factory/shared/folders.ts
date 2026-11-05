import "./folders.css"
import { onFeed, RESYNC } from "./feed"
import { subscribeApprovals, type Approvals } from "./approvals"
import { Effect } from "effect"
import { fire, json, runOr, send } from "./http"
import { Folder, Threads, type Thread } from "./schemas"
// Conversation sidebar shared by both UIs. Plain DOM, mounted once per page, like the decision center.
// Conversations are grouped under folders: "General" (the global coordinator) and one per git repo.
// A repo conversation gets its own worktree and sub-coordinator on the server.
//   - "+" on a folder starts a new conversation there (window event "sf:new-thread").
//   - Clicking a conversation opens it (window event "sf:open-thread", handled by the host UI).
//   - The folder for new conversations is kept in the sf_folder cookie, which the server reads.


const COOKIE = /(?:^|;\s*)sf_folder=([\w-]+)/
const folderNow = () => document.cookie.match(COOKIE)?.[1] ?? "general"
const setFolder = (id: string) => (document.cookie = `sf_folder=${id}; path=/; max-age=31536000; samesite=lax`)

let root: HTMLElement
let folders: ReadonlyArray<Folder> = []
let threads: ReadonlyArray<Thread> = []
let pending = new Map<string, number>()
let current: string | null = null

export const syncThreadUrl = (threadId: string | null): void => {
  const url = new URL(window.location.href)
  if (threadId) url.searchParams.set("thread", threadId)
  else url.searchParams.delete("thread")
  if (url.href !== window.location.href) window.history.pushState(null, "", url)
  current = threadId
  const thread = threads.find((t) => t.id === threadId)
  if (thread) setFolder(thread.folderId)
  if (root) render()
}

const threadHref = (threadId: string): string => {
  const url = new URL(window.location.href)
  url.searchParams.set("thread", threadId)
  return url.href
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

const newIn = (folderId: string) => {
  setFolder(folderId)
  current = null
  window.dispatchEvent(new CustomEvent("sf:new-thread", { detail: folderId }))
  render()
}

const renderThread = (t: Thread): HTMLAnchorElement => {
  const r = el("a", `sff-thread${t.id === current ? " sff-current" : ""}`)
  r.href = threadHref(t.id)
  r.append(el("span", "sff-title", t.title))
  const n = pending.get(t.id)
  if (n) r.append(el("span", "sff-badge", String(n)))
  if (t.cleanedAt) r.append(el("span", "sff-merged", "merged"))
  if (t.archivedAt) {
    const a = el("span", "sff-merged", "archived")
    a.title = "Archived: hidden from the org canvas. Click to restore."
    a.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      fire(send(`/api/threads/update/${t.id}`, "PATCH", { archivedAt: null }))
    }
    r.append(a)
  }
  if (t.branch) r.title = t.cleanedAt ? `${t.branch} · merged, worktree removed` : t.branch
  r.onclick = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    current = t.id
    setFolder(t.folderId)
    window.dispatchEvent(new CustomEvent("sf:open-thread", { detail: t.id }))
    render()
  }
  return r
}

const render = () => {
  const list = root.querySelector<HTMLElement>(".sff-list")!
  list.innerHTML = ""
  const target = folders.find((f) => f.id === folderNow()) ?? folders[0]
  root.querySelector(".sff-target")!.textContent = target ? `New conversations go to: ${target.name}` : ""
  for (const f of folders) {
    const group = el("section", `sff-folder${f.id === target?.id ? " sff-target-folder" : ""}`)
    const head = el("div", "sff-head")
    const name = el("span", "sff-name", `${f.path ? "⎇" : "◎"} ${f.name}`)
    name.title = f.path || "Global coordinator, no worktree"
    const add = el("button", "sff-add", "+")
    add.title = `New conversation in ${f.name}${f.path ? " (own worktree)" : ""}`
    add.onclick = () => newIn(f.id)
    head.append(name, add)
    group.append(head)
    for (const t of threads.filter((t) => t.folderId === f.id)) {
      group.append(renderThread(t))
    }
    list.append(group)
  }
}

const load = async () => {
  // A failed or malformed response keeps the last good list.
  const t = await runOr(json("/api/threads/get", Threads), null)
  if (!t) return
  folders = t.folders
  threads = t.threads
  render()
}

/** Waiting-decision count per conversation, from the shared Effect store. */
const onApprovals = (a: Approvals) => {
  pending = new Map()
  for (const d of a.pending) if (d.threadId) pending.set(d.threadId, (pending.get(d.threadId) ?? 0) + 1)
  render()
}

const addRepo = async (form: HTMLFormElement) => {
  const input = form.querySelector("input")!
  const err = form.querySelector<HTMLElement>(".sff-error")!
  const added = await Effect.runPromise(
    json("/api/folders", Folder, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: input.value.trim() }) }).pipe(
      Effect.map((f) => ({ ok: true as const, f })),
      Effect.catch((e) => Effect.succeed({ ok: false as const, reason: e.reason })),
    ),
  )
  if (!added.ok) return void (err.textContent = added.reason)
  err.textContent = ""
  input.value = ""
  await load()
  newIn(added.f.id)
}

/** Mount once per page. */
export const startFolderSidebar = (): void => {
  if (document.querySelector(".sff-root")) return
  root = el("div", "sff-root")
  root.innerHTML = `<button class="sff-toggle" title="Conversations (Alt+B)">☰ Conversations</button>
    <aside class="sff-panel" hidden>
      <div class="sff-top"><b>Conversations</b><button class="sff-close" title="Close">✕</button></div>
      <div class="sff-target"></div>
      <div class="sff-list"></div>
      <form class="sff-addrepo"><input placeholder="Add repo folder: /path/to/repo" /><button>Add</button><div class="sff-error"></div></form>
    </aside>`
  document.body.append(root)
  const panel = root.querySelector<HTMLElement>(".sff-panel")!
  const toggle = () => ((panel.hidden = !panel.hidden), panel.hidden || void load())
  root.querySelector<HTMLButtonElement>(".sff-toggle")!.onclick = toggle
  root.querySelector<HTMLButtonElement>(".sff-close")!.onclick = toggle
  root.querySelector("form")!.onsubmit = (e) => (e.preventDefault(), void addRepo(e.target as HTMLFormElement))
  window.addEventListener("keydown", (e) => e.altKey && e.code === "KeyB" && (e.preventDefault(), toggle()))
  window.addEventListener("sf:open-thread", (e) => ((current = (e as CustomEvent<string>).detail), render()))
  onFeed(({ type }) => (type === "factory.thread_updated" || type === RESYNC) && void load())
  subscribeApprovals(onApprovals)
  const openLocation = () => {
    const threadId = new URL(window.location.href).searchParams.get("thread")
    syncThreadUrl(threadId)
    window.dispatchEvent(threadId
      ? new CustomEvent("sf:open-thread", { detail: threadId })
      : new CustomEvent("sf:new-thread"))
  }
  window.addEventListener("popstate", openLocation)
  void load().then(() => {
    if (new URL(window.location.href).searchParams.get("thread")) openLocation()
  })
}
