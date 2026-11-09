// The Timeline of one sub-coordinator: its milestones (plan, decisions, workers, reviews, ship check, report) as a
// list, and the picked milestone's markdown in a side panel. Data: the agent's stored events (GET /api/events,
// only the types the timeline reads), the shared decisions and agents. Reloads when a matching feed event arrives.
import "./timeline.css"
import { Effect, Schema } from "effect"
import { markdown } from "../decisions"
import { onFeed, RESYNC } from "../feed"
import { json, runOr } from "../http"
import { StoredEvent } from "../schemas"
import { timeline, TIMELINE_TYPES, type Milestone, type TimelineEvent } from "../timeline"
import { el, openDecision, subscribe, type State } from "./core"

const ICON: Record<Milestone["kind"], string> = { plan: "📝", approval: "✓", question: "?", ship: "🚀", worker: "⚙", review: "🔍", security: "🛡", check: "☑", report: "📣" }
const TYPES = new Set<string>(TIMELINE_TYPES)
const clock = (t: number) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")

export type TimelineOpts = {
  /** Open a worker in the host (the conversation tree's own selection). */
  selectWorker: (id: string) => void
  /** The milestone to show first (a tool call id); otherwise the newest. */
  focus?: string | null
}

export const mountTimeline = (box: HTMLElement, agentId: string, opts: TimelineOpts): (() => void) => {
  box.classList.add("p3-tl")
  const list = el("ol", "p3-tl-list")
  const panel = el("article", "p3-tl-panel")
  box.replaceChildren(list, panel)
  let events: readonly TimelineEvent[] = []
  let s: State | null = null
  let picked: string | null = opts.focus ?? null
  let shown = ""

  const workerOf = (id: string) => {
    const a = s ? (s.agents.find((x) => x.id === id) ?? s.past.find((x) => x.id === id)) : undefined
    return a && { status: a.status, model: a.model, lastMessage: a.lastMessage }
  }
  const render = () => {
    const ms = timeline(events, s?.decisions ?? [], workerOf)
    // Unchanged data keeps the DOM (and the panel's scroll position).
    const key = JSON.stringify([ms, picked])
    if (key === shown) return
    shown = key
    if (!picked || !ms.some((m) => m.id === picked)) picked = ms.at(-1)?.id ?? null
    list.replaceChildren(
      ...ms.map((m) => {
        const li = el("li", `p3-tl-item k-${m.kind} ${m.id === picked ? "on" : ""}`)
        li.dataset.testid = "timeline-item"
        li.dataset.id = m.id
        const top = el("div", "p3-row")
        top.append(el("span", "p3-tl-icon", ICON[m.kind]), el("b", "p3-ell", m.title), el("span", "p3-n", clock(m.at)))
        li.append(top)
        if (m.sub || m.badge) {
          const sub = el("div", "p3-row p3-sub")
          if (m.badge) sub.append(el("span", `p3-tl-badge t-${m.badge.tone}`, m.badge.text))
          if (m.sub) sub.append(el("span", "p3-ell", m.sub))
          li.append(sub)
        }
        li.onclick = () => ((picked = m.id), render())
        return li
      }),
      ...(ms.length ? [] : [el("li", "p3-empty", "No milestones yet. The plan, decisions and workers show here as they happen.")]),
    )
    const m = ms.find((x) => x.id === picked)
    if (!m) return void panel.replaceChildren()
    const head = el("header", "p3-tl-head")
    head.append(el("h3", "", `${ICON[m.kind]} ${m.title}`))
    const meta = el("div", "p3-row p3-sub")
    if (m.badge) meta.append(el("span", `p3-tl-badge t-${m.badge.tone}`, m.badge.text))
    meta.append(el("span", "", m.at ? new Date(m.at).toLocaleString() : ""))
    if (m.link?.decision) {
      const id = m.link.decision
      const b = el("button", "", "Open decision")
      b.onclick = () => openDecision(id)
      meta.append(b)
    }
    if (m.link?.worker) {
      const id = m.link.worker
      const b = el("button", "", "Open worker")
      b.onclick = () => opts.selectWorker(id)
      meta.append(b)
    }
    head.append(meta)
    const doc = el("div", "p3-tl-doc sfd-summary")
    doc.innerHTML = markdown(m.body)
    panel.replaceChildren(head, doc)
    panel.scrollTop = 0
  }

  let gen = 0
  const load = () => {
    const mine = ++gen
    void runOr(
      json(`/api/events?workers=${encodeURIComponent(agentId)}&types=${TIMELINE_TYPES.join(",")}`, Schema.Array(StoredEvent)).pipe(
        Effect.map((evs) => {
          if (mine !== gen) return
          events = evs
          render()
        }),
      ),
      undefined,
    )
  }
  // A burst of tool events (one turn) reloads once.
  let timer: ReturnType<typeof setTimeout> | null = null
  const soon = () => (timer ??= setTimeout(() => ((timer = null), load()), 400))
  const offFeed = onFeed((ev) => (ev.type === RESYNC || (ev.workerId === agentId && TYPES.has(ev.type))) && soon())
  const offState = subscribe((st) => ((s = st), render()))
  load()
  return () => (offFeed(), offState(), timer && clearTimeout(timer), (gen = -1), box.classList.remove("p3-tl"))
}
