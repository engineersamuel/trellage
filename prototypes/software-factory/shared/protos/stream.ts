// Factory stream: one timeline across agents (Slack-style runs, report/decision/review cards) with full-text search.
// Used by the Inbox (📡 Factory stream view).
import "./stream.css"
import { Schema } from "effect"
import { markdown } from "../decisions"
import { json, runOr } from "../http"
import { SearchHit, StoredEvent } from "../schemas"
import {
  agentOfThread,
  el,
  isOpenUi,
  mountTranscript,
  openDecision,
  renderOpenUi,
  statusColor,
  type Decision,
  type Review,
  type State,
} from "./core"

type Kind = "line" | "user" | "report" | "decision" | "review"
type Item = {
  key: string
  at: number
  agentId: string
  kind: Kind
  text: string
  ref?: Decision | Review
  threadId?: string
}
/** Fields of a stored event that the stream reads. */
type EvData = {
  content?: unknown
  threadId?: string
  parentToolCallId?: unknown
  toolName?: unknown
  message?: unknown
}
type Ev = { seq: number; type: string; timestamp: string; data: EvData | null }
export type StreamAgent = { name: string; kind: "desk" | "chat" | "sub" | "worker"; status: string }
export type StreamHost = {
  /** Name, kind and status of an agent id; undefined when the host does not know it. */
  agent: (id: string) => StreamAgent | undefined
  /** A click on an agent's name or avatar. */
  select: (id: string) => void
  /** A click on a search hit. */
  openHit: (hit: typeof SearchHit.Type) => void
  /** Agent ids to show; null = every agent. */
  scope?: () => Set<string> | null
  /** Second line of the header. */
  subtitle?: () => string
  /** Header controls before and after the title. */
  headBefore?: () => HTMLElement[]
  headAfter?: () => HTMLElement[]
  /** False hides the list (collapsed rail). */
  open?: () => boolean
  /** Empty-list text. */
  empty?: () => string
}

const PALETTE = ["#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#f87171", "#2dd4bf", "#fb923c"]
export const colorOf = (id: string) => {
  if (id === "coordinator") return "#818cf8"
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]!
}
/** Long messages and OpenUI programs stand alone as report cards. */
const isReport = (t: string) => t.length > 220 || isOpenUi(t)
const clean = (s: string) =>
  s.replace(/<(ui-format|ui-context|user-instructions|disabled-tools)>[\s\S]*?<\/\1>/g, "").trim()
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
const day = (t: number) => new Date(t).toDateString()
const standaloneItem = (it: Item) => it.kind === "report" || it.kind === "decision" || it.kind === "review"
const startsNewRun = (prev: Item | undefined, it: Item) =>
  prev !== undefined && (prev.agentId !== it.agentId || it.at - prev.at > 600_000)
const TAG: Record<StreamAgent["kind"], string> = {
  desk: "desk",
  chat: "chat",
  sub: "sub-coordinator",
  worker: "worker",
}

const toItem = (agentId: string, e: Ev, at: number): Item | null => {
  const d = e.data ?? {}
  const key = `${agentId}:${e.seq}`
  switch (e.type) {
    case "user.message": {
      const t = clean(String(d.content ?? ""))
      return t ? { key, at, agentId, kind: "user", text: t } : null
    }
    case "assistant.message": {
      const t = String(d.content ?? "").trim()
      return t ? { key, at, agentId, kind: isReport(t) ? "report" : "line", text: t, threadId: d.threadId } : null
    }
    case "tool.execution_start":
      return d.parentToolCallId ? null : { key, at, agentId, kind: "line", text: `⚙ ${String(d.toolName)}` }
    case "session.error":
      return { key, at, agentId, kind: "line", text: `✗ ${String(d.message ?? "error")}` }
  }
  return null
}

/** Transcript of one agent in a dialog, scrolled to event `seq`; live unless the agent has stopped. Esc, ✕ or a click outside closes it. */
export const openHistory = (id: string, seq: number, title: string, stopped = true) => {
  const back = el("div", "sfs-backdrop")
  const box = el("div", "sfs-modal p2-history")
  box.setAttribute("role", "dialog")
  box.setAttribute("aria-label", `History of ${id}`)
  const head = el("div", "sfs-head")
  const close = el("button", "sfs-x", "✕")
  close.setAttribute("aria-label", "Close")
  head.append(el("b", "", title), close)
  const scroll = el("div", "sfs-body p2-transcript")
  box.append(head, scroll)
  back.append(box)
  const stop = mountTranscript(scroll, id, { stopped, focus: seq })
  const done = () => (stop(), back.remove(), window.removeEventListener("keydown", onKey, true))
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), done())
  close.onclick = done
  back.onclick = (e) => {
    if (e.target === back) done()
  }
  window.addEventListener("keydown", onKey, true)
  document.body.append(back)
  close.focus()
}

/** Build the stream in `rail` (header, search, list). Call `render(state)` on every state change; it rebuilds only when its inputs change. */
export const mountStream = (rail: HTMLElement, host: StreamHost) => {
  rail.classList.add("sf-stream")
  const railHead = el("header", "p2-rail-head")
  const railScroll = el("div", "p2-rail-scroll")
  const list = el("div", "p2-list")
  // Full-text search over every agent's history (SQLite FTS5 on the coordinator).
  const searchBar = el("div", "p2-search")
  const searchInput = document.createElement("input")
  searchInput.type = "search"
  searchInput.placeholder = "Search every agent…"
  searchInput.setAttribute("aria-label", "Search every agent's messages and tool calls")
  searchBar.append(searchInput)
  const results = el("div", "p2-results")
  railScroll.append(list, results)
  rail.append(railHead, searchBar, railScroll)

  const nameOf = (id: string) => host.agent(id)?.name ?? id
  const kindOf = (id: string): StreamAgent["kind"] => host.agent(id)?.kind ?? (id.startsWith("sub-") ? "sub" : "worker")

  let s: State | null = null
  const backlog = new Map<string, Item[]>()
  const fetched = new Set<string>()
  const refetched = new Set<string>()
  const expanded = new Set<string>()
  /** Rendered OpenUI cards, by item key + program, reused across rebuilds. */
  const genui = new Map<string, { el: HTMLElement; stop: () => void }>()
  const genuiUsed = new Set<string>()
  const openUiBody = (key: string, program: string, agentId: string, threadId?: string): HTMLElement | null => {
    const k = `${key}:${program}`
    genuiUsed.add(k)
    let g = genui.get(k)
    if (!g) {
      const box = document.createElement("div")
      const stop = renderOpenUi(box, program, agentId, threadId)
      if (!stop) return null
      genui.set(k, (g = { el: box, stop }))
    }
    return g.el
  }
  let alive = true
  let backlogVer = 0
  let streamSig = ""
  let lastScope: string | undefined

  /** Load the history of several agents in one cross-agent query, only the event types the stream shows. */
  const fetchBacklog = (...ids: string[]) => {
    if (!ids.length) return
    for (const id of ids) fetched.add(id)
    const q = new URLSearchParams({
      workers: ids.join(","),
      types: "user.message,assistant.message,tool.execution_start,session.error",
      perWorker: "1000",
    })
    void runOr(json(`/api/events?${q}`, Schema.Array(StoredEvent)), null).then((log) => {
      if (!log || !alive) return
      for (const id of ids) backlog.set(id, [])
      for (const e of log) {
        const it = toItem(e.workerId, e, Date.parse(e.timestamp) || 0)
        if (it) backlog.get(e.workerId)!.push(it)
      }
      backlogVer++
      renderStream()
    })
  }

  // ---- search ----
  const HIT_KIND: Record<string, string> = {
    "user.message": "prompt",
    "assistant.message": "reply",
    "tool.execution_start": "tool call",
    "session.error": "error",
  }
  let searchSeq = 0
  /** Text with «…» match markers as nodes, so search text is never parsed as HTML. */
  const marked = (snippet: string): ChildNode[] =>
    snippet.split(/(«[^»]*»)/).map((part) => {
      if (!part.startsWith("«")) return document.createTextNode(part)
      const m = document.createElement("mark")
      m.textContent = part.slice(1, -1)
      return m
    })
  const clearSearch = () => ((searchInput.value = ""), runSearch())
  const runSearch = () => {
    const q = searchInput.value.trim()
    const mine = ++searchSeq
    rail.classList.toggle("searching", q.length > 0)
    if (!q) return void results.replaceChildren()
    void runOr(json(`/api/search?${new URLSearchParams({ q, limit: "60" })}`, Schema.Array(SearchHit)), null)
      .then((hits) => {
        if (!hits || mine !== searchSeq || !alive) return
        if (!hits.length) return void results.replaceChildren(el("div", "p2-empty", "No match in any agent."))
        results.replaceChildren(
          el("div", "p2-results-head", `${hits.length}${hits.length === 60 ? "+" : ""} matches, best first`),
          ...hits.map((h) => {
            const b = el("button", "p2-hit")
            const at = Date.parse(h.timestamp) || Number(h.timestamp) || 0
            const head = el("div", "p2-hit-head")
            head.append(
              el("b", "", nameOf(h.workerId)),
              el("span", "", `${HIT_KIND[h.type] ?? h.type} · ${at ? new Date(at).toLocaleString() : ""}`),
            )
            const text = el("div", "p2-hit-text")
            text.append(...marked(h.snippet))
            b.append(head, text)
            b.title = host.agent(h.workerId)
              ? "Show this match in the agent's transcript"
              : "This agent has stopped: open its saved history"
            b.onclick = () => host.openHit(h)
            return b
          }),
        )
      })
      .catch(() => {})
  }
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  searchInput.oninput = () => (clearTimeout(searchTimer), (searchTimer = setTimeout(runSearch, 200)))
  // Escape clears the box. A library listener on document (capture) stops Escape before it reaches the
  // input, so this listens on window (capture), which runs first.
  const onSearchKey = (e: KeyboardEvent) =>
    e.key === "Escape" && e.target === searchInput && searchInput.value && clearSearch()
  window.addEventListener("keydown", onSearchKey, true)
  searchInput.addEventListener("search", runSearch)

  // ---- items and blocks ----
  const who = (id: string) => {
    const b = el("button", "p2-who", nameOf(id))
    b.title = "Show and open"
    b.onclick = () => host.select(id)
    return [b, el("span", "p2-stag", TAG[kindOf(id)])]
  }
  const avatar = (id: string) => {
    const k = kindOf(id)
    const v = el(
      "button",
      `p2-av ${k === "desk" ? "global" : k}`,
      k === "desk" ? "◎" : k === "worker" ? nameOf(id).slice(0, 1).toUpperCase() : "⎇",
    )
    v.title = nameOf(id)
    v.onclick = () => host.select(id)
    const st = el("span", "p2-av-st")
    st.style.background = statusColor(host.agent(id)?.status ?? "idle")
    v.append(st)
    return v
  }

  const decisionCard = (it: Item, c: HTMLElement, head: HTMLElement): boolean => {
    const d = it.ref as Decision
    const go = el(
      "button",
      d.status === "pending" ? "p2-open" : "p2-more",
      d.status === "pending" ? "Answer →" : "Open",
    )
    go.onclick = () => openDecision(d.id)
    if (d.status !== "pending") {
      // Answered decisions shrink to one line; only waiting ones stay big.
      c.classList.add("done")
      head.append(
        el("span", "p2-cbadge", "Decided"),
        el("span", "p2-done-q", d.title),
        el("b", "p2-done-a", `→ ${d.answer ?? d.status}`),
        go,
      )
      return true
    }
    head.append(
      el("span", "p2-cbadge", d.kind === "question" ? "Question" : "Decision"),
      el("b", "", d.title),
      el("span", "p2-state pending", "waiting"),
    )
    const opts = el("div", "p2-opts")
    for (const o of (d.options ?? []) as string[]) {
      const x = el("span", `p2-opt${d.shadow?.pick === o ? " jev" : ""}`, o)
      if (d.shadow?.pick === o) x.title = `Jev would pick this (${Math.round(d.shadow.confidence * 100)}% confident)`
      opts.append(x)
    }
    opts.append(go)
    c.append(opts)
    return false
  }

  const reviewCard = (it: Item, c: HTMLElement, head: HTMLElement) => {
    const r = it.ref as Review
    const kept = r.findings.filter((f) => f.verdict === "keep").length
    head.append(
      el("span", "p2-cbadge", "Security review"),
      el(
        "b",
        "",
        r.status === "done"
          ? r.findings.length
            ? `${r.findings.length} findings · ${kept} kept`
            : "no findings"
          : r.status,
      ),
      el("span", `p2-state ${r.status}`, r.status),
    )
    for (const f of r.findings.slice(0, 6)) {
      const row = el("div", `p2-finding ${f.verdict ?? ""}`)
      row.append(
        el("span", `p2-sev ${f.severity ?? ""}`, f.severity ?? "·"),
        el("span", "", f.title ?? f.id ?? "finding"),
        el("span", "p2-verdict", f.verdict ?? ""),
      )
      c.append(row)
    }
    if (r.error) c.append(el("div", "p2-err", r.error))
  }

  const reportCard = (it: Item, c: HTMLElement, head: HTMLElement) => {
    head.append(el("span", "p2-cbadge", "Report"), ...who(it.agentId), el("time", "", hhmm(it.at)))
    const body = el("div", `p2-report${expanded.has(it.key) ? " full" : ""}`)
    const ui = isOpenUi(it.text) ? openUiBody(it.key, it.text, it.agentId, it.threadId) : null
    if (ui) body.append(ui)
    else body.innerHTML = markdown(it.text)
    c.append(body)
    if (it.text.length > 400 || it.text.split("\n").length > 6) {
      const more = el("button", "p2-more", expanded.has(it.key) ? "Show less" : "Show all")
      more.onclick = () => (expanded.has(it.key) ? expanded.delete(it.key) : expanded.add(it.key), renderStream(true))
      c.append(more)
    }
  }

  const streamCard = (it: Item): HTMLElement => {
    const c = el("article", `p2-card ${it.kind}`)
    c.style.setProperty("--c", colorOf(it.agentId))
    c.dataset.agent = it.agentId
    const head = el("div", "p2-card-head")
    c.append(head)
    if (it.kind === "decision") {
      if (decisionCard(it, c, head)) return c
    } else if (it.kind === "review") reviewCard(it, c, head)
    else {
      reportCard(it, c, head)
      return c
    }
    head.append(...who(it.agentId), el("time", "", hhmm(it.at)))
    return c
  }

  const runBlock = (run: Item[]): HTMLElement => {
    const first = run[0]!
    const b = el("div", "p2-blk")
    b.style.setProperty("--c", colorOf(first.agentId))
    const body = el("div", "p2-blk-body")
    const head = el("div", "p2-blk-head")
    head.append(...who(first.agentId), el("time", "", hhmm(first.at)))
    body.append(head)
    const open = expanded.has(first.key)
    const shown = open ? run : run.slice(-3)
    if (run.length > 3) {
      const t = el("button", "p2-thread", open ? "▾ collapse" : `▸ ${run.length - shown.length} earlier`)
      t.onclick = () => (open ? expanded.delete(first.key) : expanded.add(first.key), renderStream(true))
      body.append(t)
    }
    for (const it of shown)
      body.append(
        el(
          "div",
          `p2-line ${it.kind}${it.text.startsWith("⚙") ? " tool" : ""}`,
          it.kind === "user" ? `→ ${it.text.slice(0, 400)}` : it.text,
        ),
      )
    b.append(avatar(first.agentId), body)
    return b
  }

  const appendPulses = (st: State, seen: Set<string>, out: Item[]) => {
    for (const p of st.pulses) {
      const key = `${p.agentId}:${p.seq}`
      if (seen.has(key) || !backlog.has(p.agentId)) continue
      // Pulse text is cut at 240 chars: reload the agent's log once to get the full report.
      if (p.type === "assistant.message" && p.text.length >= 240 && !refetched.has(key)) {
        refetched.add(key)
        fetchBacklog(p.agentId)
      }
      const kind: Kind =
        p.type === "user.message" ? "user" : p.type === "assistant.message" && isReport(p.text) ? "report" : "line"
      out.push({
        key,
        at: p.at,
        agentId: p.agentId,
        kind,
        text: kind === "user" ? p.text.replace(/^→ /, "") : p.text,
        threadId: p.threadId,
      })
    }
  }

  const appendDecisionItems = (st: State, out: Item[]) => {
    const ownerOf = (threadId: string | null) => {
      const t = st.threads.find((x) => x.id === threadId)
      return (t && agentOfThread(t)) || "coordinator"
    }
    for (const d of st.decisions)
      out.push({
        key: `d:${d.id}`,
        at: d.createdAt,
        agentId: ownerOf(d.threadId),
        kind: "decision",
        text: d.title,
        ref: d,
      })
    for (const r of st.reviews)
      out.push({
        key: `r:${r.id}`,
        at: r.at ?? 0,
        agentId: r.scopeId ?? (r.threadId ? ownerOf(r.threadId) : "coordinator"),
        kind: "review",
        text: "",
        ref: r,
      })
  }

  const streamItems = (st: State): Item[] => {
    fetchBacklog(...st.agents.map((a) => a.id).filter((id) => !fetched.has(id)))
    const out = [...backlog.values()].flat()
    const seen = new Set(out.map((it) => it.key))
    appendPulses(st, seen, out)
    appendDecisionItems(st, out)
    const only = host.scope?.() ?? null
    return out
      .filter((i) => !only || only.has(i.agentId))
      .sort((a, b) => a.at - b.at)
      .slice(-300)
  }

  const streamBlocks = (items: Item[]): HTMLElement[] => {
    // Runs of consecutive lines by one agent (< 10 min apart); reports, decisions, reviews stand alone as cards.
    const out: HTMLElement[] = []
    let run: Item[] = []
    let lastDay = ""
    const flush = () => (run.length && out.push(runBlock(run)), (run = []))
    for (const it of items) {
      if (day(it.at) !== lastDay) {
        flush()
        lastDay = day(it.at)
        out.push(el("div", "p2-day", lastDay === day(Date.now()) ? "Today" : lastDay))
      }
      if (standaloneItem(it)) {
        flush()
        out.push(streamCard(it))
        continue
      }
      const prev = run.at(-1)
      if (startsNewRun(prev, it)) flush()
      run.push(it)
    }
    flush()
    return out
  }

  const pruneGenui = () => {
    for (const [k, g] of genui)
      if (!genuiUsed.has(k)) {
        g.stop()
        genui.delete(k)
      }
    genuiUsed.clear()
  }

  const renderHead = () => {
    const title = el("div", "p2-rail-title")
    title.append(
      el("b", "", "Factory stream"),
      el("span", "", host.subtitle?.() ?? "Every agent, newest at the bottom"),
    )
    railHead.replaceChildren(...(host.headBefore?.() ?? []), title, ...(host.headAfter?.() ?? []))
  }

  /** Rebuild only when the inputs change (new events, decisions, reviews, scope, expansions), or when forced. */
  const renderStream = (force = false) => {
    const st = s
    if (!st) return
    const open = host.open?.() ?? true
    const scope = [...(host.scope?.() ?? [])].join()
    const sig = [
      backlogVer,
      st.pulses.at(-1)?.seq,
      scope,
      open,
      st.decisions.map((d) => d.id + d.status).join(),
      st.reviews.map((r) => r.id + r.status + r.findings.length).join(),
      st.agents.map((a) => a.id + a.status).join(),
      st.past.length,
    ].join("|")
    if (!force && sig === streamSig) return
    streamSig = sig
    renderHead()
    if (!open) return void list.replaceChildren()
    const atEnd = railScroll.scrollHeight - railScroll.scrollTop - railScroll.clientHeight < 80
    const out = streamBlocks(streamItems(st))
    if (!out.length)
      out.push(
        el("div", "p2-empty", host.empty?.() ?? "Nothing yet. Events from every agent appear here as they happen."),
      )
    list.replaceChildren(...out)
    pruneGenui()
    const jump = lastScope !== scope
    lastScope = scope
    if (atEnd || jump) railScroll.scrollTop = railScroll.scrollHeight
  }

  return {
    render: (st: State, force = false) => ((s = st), renderStream(force)),
    clearSearch,
    stop: () => {
      alive = false
      clearTimeout(searchTimer)
      window.removeEventListener("keydown", onSearchKey, true)
      for (const g of genui.values()) g.stop()
      genui.clear()
    },
  }
}
