import "./transcript.css"
import { markdown } from "./decisions"
import { appendCompact, onFeed, RESYNC, type FeedEvent } from "./feed"
import { groupTools, type Group } from "./toolgroups"
import { reconcile, ToolCard, ToolGroup, toolIcon, type CardInput } from "./toolcard"
import { Schema } from "effect"
import { json, runOr } from "./http"
import { StoredEvent } from "./schemas"
// Readable transcript of one agent, shared by both UIs. Plain DOM, like the decision center.
// A host renders an empty <div data-transcript="<worker id>">; this module fills it from the
// worker's event backlog and the live feed: chat bubbles, one card per tool call, worker and
// decision links. Clicking a worker link raises window event "sf:select-worker".

/** `seq`: the event that started the item, so a view can scroll to it. */
export type Item = (
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; args: any; done: boolean; ok: boolean; result: string; startedAt?: number; endedAt?: number }
  | { kind: "error"; text: string }
  | { kind: "thinking"; text: string }
) & { seq?: number }

/** Wrappers the factory adds to prompts; hidden in the transcript. */
const strip = (s: string) => s.replace(/<(ui-format|user-instructions|disabled-tools)>[\s\S]*?<\/\1>/g, "").trim()

/** Event time in ms; undefined when the timestamp does not parse. */
const time = (ev: FeedEvent): number | undefined => {
  const t = Date.parse(ev.timestamp)
  return Number.isNaN(t) ? undefined : t
}

/** Fold raw Copilot SDK events into transcript items. Sub-agent and nested tool events are skipped. */
export const toTranscript = (events: readonly FeedEvent[]): Item[] => {
  const out: Item[] = []
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>()
  const streams = new Map<string, Extract<Item, { kind: "assistant" }>>()
  for (const ev of events) {
    const d = ev.data ?? {}
    if (ev.agentId || (d.parentToolCallId !== undefined && d.parentToolCallId !== null)) continue
    const before = out.length
    switch (ev.type) {
      case "user.message": {
        const text = strip(String(d.content ?? ""))
        if (text) out.push({ kind: "user", text })
        break
      }
      case "assistant.message_delta": {
        let m = streams.get(d.messageId)
        if (!m) streams.set(d.messageId, (m = { kind: "assistant", text: "" })), out.push(m)
        m.text += d.deltaContent ?? ""
        break
      }
      case "assistant.message": {
        const m = streams.get(d.messageId)
        if (m) m.text = d.content || m.text
        else if (d.content) out.push({ kind: "assistant", text: d.content })
        break
      }
      case "tool.execution_start": {
        const t = { kind: "tool" as const, id: d.toolCallId, name: d.toolName, args: d.arguments ?? {}, done: false, ok: true, result: "", startedAt: time(ev) }
        tools.set(t.id, t)
        out.push(t)
        break
      }
      case "assistant.reasoning":
        if (d.content) out.push({ kind: "thinking", text: String(d.content) })
        break
      case "tool.execution_partial_result": {
        const t = tools.get(d.toolCallId)
        if (t && !t.done && typeof d.partialOutput === "string") t.result = d.partialOutput
        break
      }
      case "tool.execution_complete": {
        const t = tools.get(d.toolCallId)
        if (!t) break
        const c = d.result?.content ?? d.error?.message ?? ""
        Object.assign(t, { done: true, ok: d.success !== false, result: typeof c === "string" ? c : JSON.stringify(c), endedAt: time(ev) })
        break
      }
      case "session.error":
        out.push({ kind: "error", text: String(d.message ?? "session error") })
        break
    }
    for (const it of out.slice(before)) it.seq = ev.seq
  }
  return out.filter((i) => i.kind !== "assistant" || i.text.trim())
}

/**
 * What the agent is doing right now, from its latest events; null when it is not working.
 * Covers the gaps between visible items: thinking, writing a tool call, waiting for a permission.
 */
export const activity = (events: readonly FeedEvent[]): { label: string; detail: string } | null => {
  let working = false
  let now: { label: string; detail: string } = { label: "Thinking", detail: "" }
  const running = new Map<string, string>()
  let reasoning = ""
  for (const ev of events) {
    const d = ev.data ?? {}
    if (ev.agentId) continue
    switch (ev.type) {
      case "user.message":
      case "assistant.turn_start":
        working = true
        now = { label: "Thinking", detail: "" }
        break
      case "session.idle":
      case "session.error":
        working = false
        break
      case "assistant.reasoning_delta":
        reasoning = now.label === "Thinking" ? reasoning + (d.deltaContent ?? "") : d.deltaContent ?? ""
        now = { label: "Thinking", detail: reasoning }
        break
      case "assistant.tool_call_delta":
        reasoning = ""
        now = { label: `Preparing ${d.toolName ?? "tool"} call`, detail: "" }
        break
      case "assistant.message_delta":
        reasoning = ""
        now = { label: "Writing a reply", detail: "" }
        break
      case "permission.requested":
        now = { label: `Waiting for permission (${d.permissionRequest?.kind ?? "tool"})`, detail: String(d.permissionRequest?.fullCommandText ?? "") }
        break
      case "tool.execution_start":
        if (d.parentToolCallId) break
        running.set(d.toolCallId, d.toolName)
        now = { label: `Running ${d.toolName}`, detail: "" }
        break
      case "tool.execution_partial_result":
        if (running.has(d.toolCallId)) now = { label: `Running ${running.get(d.toolCallId)}`, detail: String(d.partialOutput ?? "") }
        break
      case "tool.execution_complete":
        running.delete(d.toolCallId)
        reasoning = ""
        now = running.size ? { label: `Running ${[...running.values()].join(", ")}`, detail: "" } : { label: "Thinking", detail: "" }
        break
      case "subagent.started":
        now = { label: `Sub-agent ${d.agentDisplayName ?? d.agentName ?? ""} working`, detail: "" }
        break
    }
  }
  if (!working) return null
  const tail = now.detail.trim().split("\n").filter(Boolean).at(-1) ?? ""
  return { label: now.label, detail: tail.slice(-200) }
}

const parse = (s: string): any => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** One-line summary of a tool call. `link` marks a worker or decision the line points to. */
export const toolLine = (t: Extract<Item, { kind: "tool" }>): { icon: string; text: string; link?: { worker?: string; decision?: string; label: string } } => {
  const a = t.args ?? {}
  const r = t.done && t.ok ? parse(t.result) : null
  switch (t.name) {
    case "spawn_worker":
      return { icon: "▶", text: `Started worker${r?.model ? ` · ${r.model}` : ""}${a.step ? ` · step ${a.step}` : ""}`, link: { worker: r?.id, label: a.name ?? "worker" } }
    case "read_worker":
      return { icon: "◀", text: r ? `Read worker · ${r.status}` : a.wait ? "Waiting for worker…" : "Read worker", link: { worker: a.id, label: a.id } }
    case "message_worker":
      return { icon: "✉", text: `Message to worker: ${String(a.prompt ?? "").slice(0, 120)}`, link: { worker: a.id, label: a.id } }
    case "stop_worker":
      return { icon: "■", text: "Stopped worker", link: { worker: a.id, label: a.id } }
    case "request_approval":
    case "ask_user":
      return { icon: t.name === "ask_user" ? "?" : "✓", text: t.name === "ask_user" ? "Question for you" : "Approval requested", link: { decision: r?.id, label: a.title ?? "decision" } }
    case "next_step":
      return { icon: "◆", text: r?.step ? `Jev: next step ${r.step} (${Math.round((r.confidence ?? 0) * 100)}%)` : "Asking Jev for the next step" }
    default: {
      const first = a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? Object.values(a).find((v) => typeof v === "string") ?? ""
      return { icon: "⚙", text: String(first).split("\n")[0]!.slice(0, 140) }
    }
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

const seqOf = (e: HTMLElement, seq: number | undefined): HTMLElement => {
  if (seq !== undefined) e.dataset.seq = String(seq)
  return e
}

const renderItem = (i: Item): HTMLElement => {
  const e = renderItemBody(i)
  if (i.seq !== undefined) e.dataset.seq = String(i.seq)
  return e
}

const renderItemBody = (i: Item): HTMLElement => {
  if (i.kind === "user" || i.kind === "assistant") {
    const b = el("div", `sft-msg sft-${i.kind}`)
    b.innerHTML = markdown(i.text)
    return b
  }
  if (i.kind === "error") return el("div", "sft-error", `Error: ${i.text}`)
  if (i.kind === "thinking") {
    const t = el("details", "sft-thinking")
    t.append(el("summary", "", `💭 ${i.text.split("\n")[0]!.slice(0, 160)}`), el("div", "sft-thought", i.text))
    return t
  }
  // Tool calls are ToolCards (see toolViews); this branch is never reached.
  return el("div")
}

/** A worker or decision link inside a tool card. */
const linkEl = (link: NonNullable<ReturnType<typeof toolLine>["link"]>): HTMLElement => {
  const a = el("a", "ui-tcc__link", `Open ${link.worker ? "worker" : "decision"}: ${link.label}`)
  if (link.decision) a.href = `#decision=${link.decision}`
  else if (link.worker) {
    a.href = "#"
    const id = link.worker
    a.onclick = (e) => (e.preventDefault(), window.dispatchEvent(new CustomEvent("sf:select-worker", { detail: id })))
  }
  return a
}

type Tool = Extract<Item, { kind: "tool" }>

/** A tool item as card input. `stoppedAt`: the agent stopped, so a call that never finished stops its timer there. */
const toCard = (t: Tool, stoppedAt: number | undefined): CardInput => {
  const line = toolLine(t)
  const status = !t.done ? "running" : t.ok ? "success" : "error"
  return {
    id: t.id,
    name: t.name,
    summary: line.text,
    icon: toolIcon(t.name),
    status,
    args: t.args,
    result: status === "success" ? (t.result.length > 6000 ? `${t.result.slice(0, 6000)}\n… (${t.result.length} chars)` : t.result) : undefined,
    error: status === "error" ? t.result : undefined,
    startedAt: t.startedAt,
    endedAt: t.endedAt ?? (t.done ? t.startedAt : stoppedAt),
    link: line.link?.worker || line.link?.decision ? linkEl(line.link) : undefined,
  }
}

/** Tool cards and groups that stay in the page between renders, so they keep their open state and animations. */
const toolViews = (open: Set<string>) => {
  const touched = new Set<string>()
  const opts = { isOpen: (id: string) => open.has(id), setOpen: (id: string, on: boolean) => void (on ? open.add(id) : open.delete(id)), touched }
  const cards = new Map<string, { card: ToolCard; key: string }>()
  const groups = new Map<string, ToolGroup>()
  const icons = new Map<string, SVGSVGElement>()
  let seen = new Set<string>()
  const card = (t: Tool, stoppedAt: number | undefined): ToolCard => {
    seen.add(t.id)
    const input = toCard(t, stoppedAt)
    // One icon element per tool name, so an unchanged card is not repainted.
    input.icon = icons.get(t.name) ?? (icons.set(t.name, input.icon), input.icon)
    const key = JSON.stringify([input.status, input.summary, input.result, input.error, input.endedAt, t.args])
    const got = cards.get(t.id)
    if (!got) {
      const c = new ToolCard(input, opts)
      cards.set(t.id, { card: c, key })
      return c
    }
    if (got.key !== key) (got.key = key), got.card.update(input)
    return got.card
  }
  const group = (g: Group<Item>, stoppedAt: number | undefined): ToolGroup => {
    seen.add(g.id)
    const tools = g.items as Tool[]
    const views = tools.map((t) => card(t, stoppedAt))
    let v = groups.get(g.id)
    if (!v) groups.set(g.id, (v = new ToolGroup({ id: g.id, label: g.label, cards: [] }, opts)))
    v.update({ id: g.id, label: g.label, cards: views.map((c) => c.card) }, views)
    reconcile(v.list, views.map((c) => c.el))
    return v
  }
  /** Drop views whose items are gone (trimmed from the log). */
  const sweep = () => {
    for (const id of cards.keys()) if (!seen.has(id)) cards.delete(id)
    for (const id of groups.keys()) if (!seen.has(id)) groups.delete(id)
    seen = new Set()
  }
  const tick = () => {
    const now = Date.now()
    let live = false
    for (const { card: c } of cards.values()) if (c.card.status === "running" && c.card.endedAt === undefined) (c.tick(now), (live = true))
    for (const g of groups.values()) g.tick(now)
    return live
  }
  return { card, group, sweep, tick }
}

/** Scroll to the item started by event `seq` (or the last one before it), open its group, and mark it. */
const reveal = (host: HTMLElement, seq: number): void => {
  let best: HTMLElement | null = null
  for (const e of host.querySelectorAll<HTMLElement>("[data-seq]")) if (Number(e.dataset.seq) <= seq) best = e
  if (!best) return
  for (let p = best.parentElement; p && p !== host; p = p.parentElement) {
    if (p instanceof HTMLDetailsElement) p.open = true
    if (p.matches(".ui-tcc-group:not([data-open])")) p.querySelector<HTMLElement>(":scope > .ui-tcc-group__head")?.click()
  }
  best.classList.add("sft-focus")
  best.scrollIntoView({ block: "center" })
}

export type MountOptions = {
  /** The agent has stopped: its last activity line ("Waiting for…") is stale, so it is not shown. */
  stopped?: boolean
  /** After loading, scroll to the item of this event seq. */
  focus?: number
}

/** Fill `host` with the live transcript of one worker. Returns a cleanup function. */
export const mount = (host: HTMLElement, id: string, opts: MountOptions = {}): (() => void) => {
  host.classList.add("ui-tcc-dark")
  let focus = opts.focus
  let events: FeedEvent[] = []
  let loaded = false
  let backlogMax = -1
  const pending: FeedEvent[] = []
  const open = new Set<string>()
  const tools = toolViews(open)
  let frame = 0
  let timer = 0
  const ticking = () => {
    const live = tools.tick()
    if (!live && timer) (clearInterval(timer), (timer = 0))
    return live
  }
  const render = () => {
    frame = 0
    const scroller = host.closest<HTMLElement>("[data-transcript-scroll]") ?? host
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60
    const now = opts.stopped ? null : activity(events)
    const live: HTMLElement[] = []
    if (now) {
      const a = el("div", "sft-activity")
      a.append(el("span", "sft-spin"), el("b", "", `${now.label}…`))
      if (now.detail) a.append(el("span", "sft-detail", now.detail))
      live.push(a)
    }
    const stoppedAt = opts.stopped ? Date.parse(events.at(-1)?.timestamp ?? "") || undefined : undefined
    const nodes = groupTools(toTranscript(events)).map((i): HTMLElement => {
      if (i.kind === "group") return seqOf(tools.group(i, stoppedAt).el, i.items[0]?.seq)
      if (i.kind === "tool") return seqOf(tools.card(i, stoppedAt).el, i.seq)
      return renderItem(i)
    })
    tools.sweep()
    reconcile(host, [...nodes, ...live])
    // A 100ms timer keeps the live durations moving while any call runs.
    if (ticking() && !timer) timer = window.setInterval(ticking, 100)
    if (focus !== undefined && ready) reveal(host, focus), (focus = undefined)
    else if (atEnd) scroller.scrollTop = scroller.scrollHeight
  }
  const schedule = () => (frame ||= requestAnimationFrame(render))
  /** Events kept; raised when older events are loaded to reach a focus seq. */
  let cap = 4000
  /** All events needed for the focus are loaded; only then does render scroll to it. */
  let ready = false
  /** Focus older than the loaded window: fetch the stored events from it up to the window, then show them. */
  const loadOlder = (first: number) =>
    runOr(json(`/api/workers/${encodeURIComponent(id)}/events?from=${focus}&before=${first}`, Schema.Array(StoredEvent)), [])
      .then((older) => {
        const keep: FeedEvent[] = []
        for (const e of older) appendCompact(keep, e, Infinity)
        events = [...keep, ...events]
        cap = Math.max(cap, events.length + 4000)
      })
  const load = () => {
    loaded = ready = false
    pending.length = 0
    // A failed or malformed backlog keeps the transcript empty; the next feed gap reloads it.
    void runOr(json(`/api/workers/${encodeURIComponent(id)}/events`, Schema.Array(StoredEvent)), null)
      .then((log) => {
        if (!log) return
        backlogMax = log.at(-1)?.seq ?? -1
        events = []
        for (const e of [...log, ...pending.filter((e) => e.seq > backlogMax)]) appendCompact(events, e, cap)
        loaded = true
        const first = log[0]?.seq
        if (focus === undefined || first === undefined || focus >= first) return void ((ready = true), schedule())
        // Live events keep appending while the older part loads; it is put in front of them.
        void loadOlder(first).then(() => ((ready = true), schedule()))
      })
  }
  const off = onFeed((ev) => {
    if (ev.type === RESYNC) return load()
    if (ev.workerId !== id) return
    if (!loaded) return void pending.push(ev)
    // A restarted coordinator numbers events from a lower start; take them anyway.
    if (ev.seq > backlogMax || ev.seq < backlogMax - 1e9) appendCompact(events, ev, cap), schedule()
  })
  load()
  return () => (off(), cancelAnimationFrame(frame), clearInterval(timer))
}

/** Watch the page for [data-transcript] hosts and keep each one mounted. Call once per page. */
export const startTranscripts = (): void => {
  const live = new Map<HTMLElement, { id: string; stop: () => void }>()
  const sync = () => {
    for (const [host, m] of live) if (!host.isConnected || host.dataset.transcript !== m.id) (m.stop(), live.delete(host))
    for (const host of document.querySelectorAll<HTMLElement>("[data-transcript]"))
      if (!live.has(host) && host.dataset.transcript) live.set(host, { id: host.dataset.transcript, stop: mount(host, host.dataset.transcript) })
  }
  new MutationObserver(sync).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-transcript"] })
  sync()
}
