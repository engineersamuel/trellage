// The original prompt and the accepted plan of one sub-coordinator, pinned at the top of its detail.
// Two collapsed disclosures; their open state stays across data reloads.
import "./timeline.css"
import { Effect, Schema } from "effect"
import { markdown } from "../decisions"
import { onFeed, RESYNC } from "../feed"
import { json, runOr } from "../http"
import { StoredEvent } from "../schemas"
import { pins, PIN_TYPES } from "../pins"
import type { TimelineEvent } from "../timeline"
import { el, subscribe, type State } from "./core"

const TYPES = new Set<string>(PIN_TYPES)
const oneLine = (s: string, n = 90) => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export const mountPins = (box: HTMLElement, agentId: string): (() => void) => {
  box.classList.add("p3-pins")
  box.dataset.testid = "pins"
  let events: readonly TimelineEvent[] = []
  let s: State | null = null
  let shown = ""
  const pin = (key: string, summary: string, body: string) => {
    const d = el("details", "p3-pin")
    d.dataset.pin = key
    d.open = !!box.querySelector<HTMLDetailsElement>(`[data-pin="${key}"]`)?.open
    const doc = el("div", "p3-pin-doc sfd-summary")
    doc.innerHTML = markdown(body)
    d.append(el("summary", "p3-ell", summary), doc)
    return d
  }
  const render = () => {
    const p = pins(events, s?.decisions ?? [])
    const key = JSON.stringify(p)
    if (key === shown) return
    shown = key
    box.replaceChildren(
      ...(p.prompt ? [pin("prompt", `📌 Prompt · ${oneLine(p.prompt)}`, p.prompt)] : []),
      ...(p.plan
        ? [pin("plan", p.plan.accepted ? "📝 Accepted plan" : "📝 Plan · not accepted yet", p.plan.body)]
        : []),
    )
  }
  let gen = 0
  const load = () => {
    const mine = ++gen
    void runOr(
      json(
        `/api/events?workers=${encodeURIComponent(agentId)}&types=${PIN_TYPES.join(",")}`,
        Schema.Array(StoredEvent),
      ).pipe(
        Effect.map((evs) => {
          if (mine !== gen) return
          events = evs
          render()
        }),
      ),
      undefined,
    )
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const soon = () => (timer ??= setTimeout(() => ((timer = null), load()), 400))
  const offFeed = onFeed((ev) => (ev.type === RESYNC || (ev.workerId === agentId && TYPES.has(ev.type))) && soon())
  const offState = subscribe((st) => ((s = st), render()))
  load()
  return () => (offFeed(), offState(), timer && clearTimeout(timer), (gen = -1))
}
