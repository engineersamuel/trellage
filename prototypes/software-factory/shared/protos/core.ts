// Prototype layouts: shared core used by every prototype and by the Foldkit host.
// A host renders:
//   <div class="sfp-stage" data-proto="3"><div class="sfp-chat">NATIVE CHAT</div><div class="sfp-host" data-proto="3"></div></div>
// startPrototypes() mounts the Inbox (3) into .sfp-host. It owns .sfp-host's children and
// places the host's native chat with ctx.placeChat().
import "./core.css"
import { appendCompact, onFeed, RESYNC, type FeedEvent } from "../feed"
import { activity, mount as mountTranscriptRaw, type MountOptions } from "../transcript"
import { agentLabel, workerTree } from "../tree"
import { subscribeApprovals, type Decision } from "../approvals"
import { Effect, Schema } from "effect"
import { json, runOr, send } from "../http"
import { Steps, Threads, Worker, type Folder, type SecurityReview, type Thread } from "../schemas"

export type Agent = Worker
export type { Thread, Folder }
export type { Decision }
export type Review = SecurityReview
export type Activity = { label: string; detail: string } | null
/** One line of the global event stream, for timeline-like prototypes. */
export type Pulse = { seq: number; agentId: string; type: string; text: string; at: number; threadId?: string }

export type State = {
  agents: ReadonlyArray<Agent>
  /** Stopped agents (status "stopped"), kept for the historical record. Not in `agents`. */
  past: ReadonlyArray<Agent>
  /** Agents in tree order with depth: global → sub-coordinators → workers. */
  tree: { a: Agent; depth: number }[]
  threads: ReadonlyArray<Thread>
  folders: ReadonlyArray<Folder>
  decisions: ReadonlyArray<Decision>
  reviews: ReadonlyArray<Review>
  activity: Record<string, Activity>
  /** Latest readable events across all agents (newest last, max 400). */
  pulses: Pulse[]
  /** True once the first thread list arrived (it may be empty). */
  threadsLoaded: boolean
}

export { agentLabel }

// ---------- store ----------

const state: State = {
  agents: [],
  past: [],
  tree: [],
  threads: [],
  folders: [],
  decisions: [],
  reviews: [],
  activity: {},
  pulses: [],
  threadsLoaded: false,
}
const subs = new Set<(s: State) => void>()
const logs = new Map<string, FeedEvent[]>()
let frame = 0
const emit = () => (frame ||= requestAnimationFrame(() => ((frame = 0), subs.forEach((s) => s(state)))))
// Each load decodes its payload; a bad or failed response is logged and keeps the last good state.
const loadAgents = () =>
  runOr(
    json("/api/workers", Schema.Array(Worker)).pipe(
      Effect.map((ws) => {
        state.agents = ws
        state.tree = workerTree(ws).map(({ w, depth }) => ({ a: w, depth }))
        emit()
      }),
    ),
    undefined,
  )
const loadThreads = () =>
  runOr(
    json("/api/threads/get", Threads).pipe(
      Effect.map(
        (v) => ((state.threads = v.threads), (state.folders = v.folders), (state.threadsLoaded = true), emit()),
      ),
    ),
    undefined,
  )
const loadReviews = () =>
  runOr(json("/api/steps", Steps).pipe(Effect.map((v) => ((state.reviews = v.securityReviews), emit()))), undefined)
const loadPast = () =>
  runOr(
    json("/api/workers/past", Schema.Array(Worker)).pipe(Effect.map((ws) => ((state.past = ws), emit()))),
    undefined,
  )
const loadAll = () => Promise.all([loadAgents(), loadPast(), loadThreads(), loadReviews()])

const describe = (ev: FeedEvent): string | null => {
  const d = ev.data ?? {}
  switch (ev.type) {
    case "user.message":
      return `→ ${String(d.content ?? "")
        .replace(/<(ui-format|ui-context|user-instructions|disabled-tools)>[\s\S]*?<\/\1>/g, "")
        .trim()
        .slice(0, 240)}`
    case "assistant.message":
      return d.content ? String(d.content).slice(0, 240) : null
    case "tool.execution_start":
      return d.parentToolCallId ? null : `⚙ ${d.toolName}`
    case "session.error":
      return `✗ ${d.message ?? "error"}`
    default:
      return null
  }
}

let started = false
const start = () => {
  if (started) return
  started = true
  void loadAll()
  subscribeApprovals((a) => ((state.decisions = a.all), emit()))
  onFeed((ev) => {
    if (ev.type === RESYNC) return void loadAll()
    if (
      ev.type === "factory.worker_started" ||
      ev.type === "factory.worker_updated" ||
      ev.type === "factory.worker_stopped"
    )
      return void Promise.all([loadAgents(), loadPast()])
    if (ev.type === "factory.thread_updated") return void loadThreads()
    // Approvals come from the shared Effect store (subscribed in start).
    if (ev.type.startsWith("factory.approval_")) return
    if (ev.type === "factory.security_review") return void loadReviews()
    if (ev.type.startsWith("factory.") || ev.agentId) return
    const log = logs.get(ev.workerId) ?? []
    appendCompact(log, ev, 300)
    logs.set(ev.workerId, log)
    state.activity = { ...state.activity, [ev.workerId]: activity(log) }
    const text = describe(ev)
    if (text)
      state.pulses = [
        ...state.pulses.slice(-399),
        {
          seq: ev.seq,
          agentId: ev.workerId,
          type: ev.type,
          text,
          at: Date.now(),
          threadId: typeof ev.data?.threadId === "string" ? ev.data.threadId : undefined,
        },
      ]
    emit()
  })
}

/** Subscribe to the shared state; called at once and on every change. Returns unsubscribe. */
export const subscribe = (cb: (s: State) => void): (() => void) => {
  start()
  subs.add(cb)
  cb(state)
  return () => void subs.delete(cb)
}

// ---------- actions ----------

/** Thread of a sub-coordinator ("sub-<first 8 of thread id>"). */
export const threadOf = (agentId: string): Thread | undefined =>
  agentId === "coordinator"
    ? state.threads.find((t) => t.desk)
    : state.threads.find((t) => `${t.worktree ? "sub" : "gen"}-${t.id.slice(0, 8)}` === agentId)
/** Sub-coordinator id of a thread, if it is a repo conversation. */
export const agentOfThread = (t: Thread): string | null => (t.worktree ? `sub-${t.id.slice(0, 8)}` : null)
export const pendingFor = (threadId: string | null) =>
  state.decisions.filter((d) => d.status === "pending" && d.threadId === threadId)

/** Show a conversation in the host's native chat. */
export const openThread = (threadId: string) =>
  window.dispatchEvent(new CustomEvent("sf:open-thread", { detail: threadId }))
/** Start a new conversation in a folder in the host's native chat. */
export const newThread = (folderId = "general") => {
  document.cookie = `sf_folder=${folderId}; path=/; max-age=31536000; samesite=lax`
  window.dispatchEvent(new CustomEvent("sf:new-thread", { detail: folderId }))
}
/** Open the conversation behind an agent in the native chat: the newest General thread for the global coordinator, the repo thread for a sub-coordinator. Returns false for workers (no conversation). */
export const openAgentChat = (agentId: string): boolean => {
  if (agentId === "general") {
    const chat = state.threads.find((t) => t.folderId === "general" && !t.desk)
    if (chat) openThread(chat.id)
    else newThread("general")
    return true
  }
  const t = threadOf(agentId)
  if (t) return (openThread(t.id), true)
  return false
}
/** threadId: the conversation the prompt belongs to (a coordinator serves several); the server checks it. */
/** Resolves to null when sent, else the error text. */
export const messageAgent = (agentId: string, prompt: string, threadId?: string): Promise<string | null> =>
  Effect.runPromise(
    send(`/api/workers/${encodeURIComponent(agentId)}/message`, "POST", { prompt, threadId }).pipe(
      Effect.as(null),
      Effect.catch((e) => Effect.succeed(e.reason)),
    ),
  )
export const openDecision = (id: string) => (location.hash = `decision=${id}`)
/** Live readable transcript of any agent in `el`. Returns cleanup. */
export const mountTranscript = (el: HTMLElement, agentId: string, opts?: MountOptions): (() => void) => {
  el.setAttribute("data-transcript-scroll", "")
  // Same layout as a [data-transcript] host (gaps between items), without the attribute: that would mount it twice.
  const inner = document.createElement("div")
  inner.className = "sft-root"
  el.replaceChildren(inner)
  return mountTranscriptRaw(inner, agentId, opts)
}

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}
export const statusColor = (s: string) =>
  s === "running" ? "#f59e0b" : s === "error" ? "#ef4444" : s === "stopped" ? "#525252" : "#22c55e"

// ---------- OpenUI Lang ----------

/** A message the coordinator wrote as an OpenUI Lang program (for the Foldkit chat) instead of markdown. */
export const isOpenUi = (text: string) => /^\s*root\s*=/.test(text)
/** Renders an OpenUI Lang program into el; returns the unmount. The host sets it (shared code has no React). */
/** A button press inside a card (OpenUI ActionEvent: type continue_conversation | open_url, params, humanFriendlyMessage). */
export type OpenUiAction = { type: string; params: Record<string, unknown>; humanFriendlyMessage: string }
type OpenUiRenderer = (el: HTMLElement, program: string, onAction: (a: OpenUiAction) => void) => () => void
let openUiRenderer: OpenUiRenderer | null = null
export const setOpenUiRenderer = (r: OpenUiRenderer) => void (openUiRenderer = r)
/** Render a card that agentId wrote in threadId. Follow-up buttons send their text back to that conversation; links open in a new tab. */
export const renderOpenUi = (
  host: HTMLElement,
  program: string,
  agentId: string,
  threadId?: string,
): (() => void) | null =>
  openUiRenderer?.(host, program, (a) => {
    if (a.type === "open_url" && typeof a.params.url === "string")
      return void window.open(a.params.url, "_blank", "noopener")
    if (a.type === "continue_conversation" && a.humanFriendlyMessage)
      void messageAgent(agentId, a.humanFriendlyMessage, threadId).then(
        (error) => error && alert(`Send failed: ${error}`),
      )
  }) ?? null

// ---------- prototypes ----------

export type Ctx = {
  /** Element the prototype owns (fills the stage). */
  root: HTMLElement
  /** Place the host's native chat (the conversation with a coordinator). CSS box values relative to the stage, or null to hide it. */
  placeChat: (box: Partial<Record<"left" | "top" | "right" | "bottom" | "width" | "height", string>> | null) => void
}
export type Prototype = { id: number; name: string; blurb: string; mount: (ctx: Ctx) => () => void }

const registry = new Map<number, Prototype>()
export const register = (p: Prototype) => registry.set(p.id, p)
export const prototypes = () => [...registry.values()].sort((a, b) => a.id - b.id)

/** Mount once per page: the prototype in any .sfp-host the host renders. */
let hostsStarted = false
export const startPrototypes = (): void => {
  if (hostsStarted) return
  hostsStarted = true
  const live = new Map<HTMLElement, { n: number; stop: () => void }>()
  const sync = () => {
    for (const [host, m] of live)
      if (!host.isConnected || Number(host.dataset.proto) !== m.n) {
        m.stop()
        live.delete(host)
      }
    for (const host of document.querySelectorAll<HTMLElement>(".sfp-host[data-proto]")) {
      const n = Number(host.dataset.proto)
      if (live.has(host) || !registry.has(n)) continue
      const chat = host.parentElement?.querySelector<HTMLElement>(":scope > .sfp-chat") ?? null
      const placeChat: Ctx["placeChat"] = (box) => {
        if (!chat) return
        chat.style.cssText = ""
        if (!box) return void (chat.style.display = "none")
        for (const [k, v] of Object.entries(box)) chat.style.setProperty(k, v!)
      }
      placeChat({ left: "0", top: "0", right: "0", bottom: "0" })
      live.set(host, { n, stop: registry.get(n)!.mount({ root: host, placeChat }) })
    }
  }
  new MutationObserver(sync).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-proto"],
  })
  sync()
}
