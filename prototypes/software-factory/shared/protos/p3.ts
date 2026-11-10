// Prototype 3 — Inbox + workspace. Four columns:
//   sidebar (views, repos) · inbox (what needs you) · conversation tree (chat → sub-coordinators → workers) · detail.
// The detail of a chat, sub-coordinator or the desk is the host's native chat (placed by placeChat), so you keep talking to it.
// The detail of a worker is its live transcript plus a composer to the worker or to the coordinator it reports to.
import "./p3.css"
import { answer, runApprovals } from "../approvals"
import { fire, send } from "../http"
import { harnessBadge } from "../harness"
import { openSpec } from "../spec"
import {
  el,
  messageAgent,
  mountTranscript,
  newThread,
  openDecision,
  openThread,
  register,
  subscribe,
  type Ctx,
  type State,
} from "./core"
import { mountStream, openHistory, type StreamAgent } from "./stream"
import { mountTimeline } from "./timeline-view"
import {
  ancestors,
  bornAt,
  bossOf,
  build,
  count,
  items,
  modelReason,
  rootOf,
  subtree,
  VIEWS,
  type Model,
  type Node,
  type View,
} from "./p3-model"

const LABEL: Record<Node["status"], string> = {
  running: "Running",
  idle: "Idle",
  error: "Failed",
  needs: "Needs you",
  dormant: "Dormant",
  draft: "Draft",
  stopped: "Stopped",
}
const ICON: Record<Node["kind"], string> = { desk: "🌐", chat: "💬", sub: "◆", worker: "⚙", draft: "📄" }
const KIND: Record<Node["kind"], string> = {
  desk: "Factory desk",
  chat: "General chat",
  sub: "Sub-coordinator",
  worker: "Worker",
  draft: "Draft",
}
/** Agent fields that change on every model call and that p3 does not draw. */
const VOLATILE = new Set(["contextTokens", "contextLimit", "rssKb", "eventCount", "lastMessage", "pid"])
const ago = (t?: number) => {
  if (!t) return ""
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`
}
const pill = (n: Node) => {
  const p = el("span", `p3-pill s-${n.status}`)
  p.append(el("i", "p3-dot"), LABEL[n.status])
  return p
}
const btn = (text: string, onClick: () => void, cls = "") => {
  const b = el("button", cls, text)
  b.onclick = (e) => (e.stopPropagation(), onClick())
  return b
}
const archive = (n: Node, at: number | null) =>
  n.thread && fire(send(`/api/threads/update/${n.thread.id}`, "PATCH", { archivedAt: at }))

const mount = ({ root, placeChat }: Ctx): (() => void) => {
  root.classList.add("sfp-p3")
  const side = el("nav", "p3-side")
  const inbox = el("section", "p3-inbox")
  const tree = el("section", "p3-tree")
  const detail = el("section", "p3-detail")
  const head = el("header", "p3-head")
  const body = el("div", "p3-body")
  detail.append(head, body)
  root.replaceChildren(side, inbox, tree, detail)

  let s: State | null = null
  let m: Model = { nodes: new Map(), roots: [] }
  let view: View = "needs"
  let autoView = true
  /** Selected inbox row, and the node shown in the detail column (same tree). */
  let sel: string | null = null
  /** Conversations whose live activity (the coordinator's own tool calls and messages) is shown instead of the chat. */
  const liveOn = new Set<string>()
  const liveOff = new Set<string>()
  /** Sub-coordinators whose Timeline (milestones) is shown instead of the chat or live activity, and the milestone to open first. */
  const tlOn = new Set<string>()
  let tlFocus: string | null = null
  /** Live by default while the coordinator runs a turn, unless the human switched it off; on when switched on. */
  const showsLive = (n: Node) =>
    !!n.agent &&
    n.kind !== "worker" &&
    n.kind !== "draft" &&
    (liveOn.has(n.id) || (n.agent.status === "running" && !liveOff.has(n.id)))
  let cur: string | null = null
  const opened = new Set<string>()
  let mounted: { key: string; stop: () => void } | null = null
  /** Open questions of the shown worker, between its transcript and composer. Filled on every render. */
  let askBox: HTMLElement | null = null

  /** The 📡 Factory stream shows in the detail column; any other pick in the sidebar, inbox or tree leaves it. */
  let streamOn = false
  let stream: ReturnType<typeof mountStream> | null = null
  const choose = (id: string) => ((streamOn = false), (cur = id), render())

  // ---------- sidebar ----------
  const renderSide = (live: Model) => {
    const row = (v: View, label: string, n: number, badge = false) => {
      const r = el("div", `p3-sv ${view === v ? "on" : ""}`)
      r.append(el("span", "p3-ell", label), el("span", badge && n ? "p3-badge" : "p3-n", String(n)))
      r.onclick = () => ((view = v), (autoView = false), (streamOn = false), (sel = cur = null), render())
      return r
    }
    const desk = live.nodes.get("coordinator")
    const deskRow = el("div", `p3-sv ${cur === "coordinator" && !streamOn ? "on" : ""}`)
    deskRow.append(
      el("span", "p3-ell", "🌐 Factory desk"),
      el("span", "p3-n", desk?.agg.needs ? `▲${desk.pending.length}` : ""),
    )
    deskRow.onclick = () => ((autoView = false), (streamOn = false), (sel = cur = "coordinator"), render())
    const streamRow = el("div", `p3-sv ${streamOn ? "on" : ""}`)
    streamRow.dataset.testid = "stream-row"
    streamRow.append(el("span", "p3-ell", "📡 Factory stream"))
    streamRow.onclick = () => ((streamOn = true), render())
    const repos = (s?.folders ?? []).filter((f) => f.path)
    const archivedN = (s?.threads ?? []).filter((t) => t.archivedAt && !t.desk).length
    side.replaceChildren(
      btn("＋ New General chat", () => newThread("general"), "p3-new"),
      el("h5", "", "Views"),
      ...VIEWS.map((v) => row(v.id, v.label, count(live, v.id), v.id === "needs")),
      deskRow,
      streamRow,
      el("h5", "", "Repos"),
      ...repos.map((f) => row(`repo:${f.id}`, `# ${f.name}`, count(live, `repo:${f.id}`))),
      el("h5", "", "Archive"),
      row("archived", "Marked done", archivedN),
    )
  }

  // ---------- inbox ----------
  const renderInbox = () => {
    const list = items(m, view)
    // sel is the open conversation (a root); cur is the node shown in the detail column.
    // The desk is no inbox row in most views, but stays open once picked.
    const isDesk = sel === "coordinator" && m.nodes.has(sel)
    if (!isDesk && (!sel || !list.some((x) => x.root.id === rootOf(m, sel!)))) {
      sel = list[0]?.root.id ?? null
      cur = list[0]?.focus.id ?? null
    }
    if (!cur || !m.nodes.has(cur)) cur = sel
    const bar = el("div", "p3-bar")
    bar.append(el("span", "p3-n", `${list.length} ${list.length === 1 ? "conversation" : "conversations"}`))
    inbox.replaceChildren(
      bar,
      ...list.map(({ root: n, focus, reason, tone }) => {
        const r = el("div", `p3-item s-${tone} ${n.id === rootOf(m, sel!) ? "on" : ""}`)
        r.dataset.testid = "inbox-item"
        const top = el("div", "p3-row")
        top.append(el("i", "p3-dot"), el("b", "p3-ell", n.title), el("span", "p3-n", ago(n.thread?.createdAt)))
        const repos = [
          ...new Set(
            subtree(m, n.id)
              .map((x) => x.thread?.folderId)
              .filter((f) => f && f !== "general"),
          ),
        ]
        const path = focus.id === n.id ? "" : ` › ${KIND[focus.kind]}`
        const where = el(
          "div",
          "p3-sub p3-ell",
          `${ICON[n.kind]} ${KIND[n.kind]}${repos.length ? ` · ${repos.join(", ")}` : ""}${path}`,
        )
        r.append(top, where)
        // Quiet rows (idle, dormant, draft): the dot says it all.
        if (tone === "needs" || tone === "error" || tone === "running")
          r.append(el("div", "p3-sub p3-st p3-ell", reason))
        r.onclick = () => ((autoView = false), (streamOn = false), (sel = n.id), (cur = focus.id), render())
        return r
      }),
      ...(list.length ? [] : [el("div", "p3-empty", view === "needs" ? "Nothing needs you. 🎉" : "Nothing here.")]),
    )
  }

  // ---------- conversation tree ----------
  const card = (n: Node) => {
    const c = el("div", `p3-card s-${n.status} ${n.id === cur ? "on" : ""} ${n.parent ? "" : "root"}`)
    c.dataset.testid = `tree-${n.kind}`
    c.dataset.id = n.id
    const hd = el("div", "p3-row")
    hd.append(el("b", "", `${ICON[n.kind]} ${KIND[n.kind]}`), pill(n))
    c.append(hd, el("div", "p3-title", n.title))
    const meta = [n.thread?.folderId, n.agent?.model, ago(n.thread?.createdAt)].filter(Boolean).join(" · ")
    if (meta) c.append(el("div", "p3-sub", meta))
    if (!n.parent && n.agg.desc) {
      const a = el("div", "p3-sub", `${n.agg.desc} below · ${n.agg.running} running`)
      if (n.agg.needs) a.append(el("span", "p3-needs", ` · ▲ ${n.agg.needs} need you`))
      c.append(a)
    }
    c.onclick = (e) => (e.stopPropagation(), choose(n.id))
    return c
  }
  /** Spawn-order badge: the node's place among its siblings by spawn time. */
  const order = (n: Node) => {
    const sibs = m.nodes.get(n.parent ?? "")?.children.map((id) => m.nodes.get(id)!) ?? [n]
    const k = [...sibs].sort((x, y) => bornAt(x) - bornAt(y)).indexOf(n) + 1
    const t = bornAt(n)
    const b = el("span", "p3-ord", String(k))
    b.title = `Spawned #${k}${t ? ` at ${new Date(t).toLocaleTimeString()}` : ""}`
    return b
  }
  const row = (n: Node) => {
    const r = el("div", `p3-w s-${n.status} ${n.id === cur ? "on" : ""}`)
    r.dataset.testid = "tree-row"
    r.append(
      order(n),
      el("i", "p3-dot"),
      el(
        "b",
        "",
        n.kind === "draft"
          ? "📄 draft"
          : n.kind === "worker"
            ? (n.agent?.name ?? "worker")
            : `${ICON[n.kind]} ${KIND[n.kind]}`,
      ),
      el("span", "p3-tt p3-ell", n.kind === "worker" ? (n.agent?.task ?? "") : n.title),
      el("span", "p3-n", ago(bornAt(n))),
      el("span", "p3-st", LABEL[n.status]),
    )
    r.onclick = (e) => (e.stopPropagation(), choose(n.id))
    return r
  }
  /** A sub-coordinator card with its workers on their own branch. Quiet ones fold to one line. */
  const subCard = (n: Node) => {
    const c = card(n)
    c.querySelector(".p3-row")!.prepend(order(n))
    const kids = n.children.map((id) => m.nodes.get(id)!)
    const open = opened.has(n.id) || n.agg.running || n.agg.error || n.agg.needs || kids.some((k) => k.id === cur)
    if (!kids.length) c.append(el("div", "p3-sub", "no workers yet"))
    else if (open) {
      const w = el("div", "p3-wks")
      w.append(...kids.map((k) => (k.children.length ? subCard(k) : row(k))))
      c.append(w)
    } else {
      const more = el("div", "p3-more", `▸ ${kids.length} workers, all quiet`)
      more.onclick = (e) => (e.stopPropagation(), opened.add(n.id), render())
      c.append(more)
    }
    return c
  }
  const renderTree = () => {
    const r = sel ? m.nodes.get(rootOf(m, sel)) : undefined
    if (!r)
      return void tree.replaceChildren(el("h5", "", "Conversation tree"), el("div", "p3-empty", "Select an item."))
    const branches = r.children.map((id) => {
      const k = m.nodes.get(id)!
      const b = el("div", "p3-br")
      b.append(k.kind === "sub" || k.children.length ? subCard(k) : row(k))
      return b
    })
    const foot = el("div", "p3-foot")
    if (r.thread && !r.thread.desk)
      foot.append(
        r.thread.archivedAt
          ? btn("Restore", () => archive(r, null))
          : btn("Mark done (archive tree)", () => ((sel = cur = null), archive(r, Date.now()))),
      )
    tree.replaceChildren(
      el("h5", "", "Conversation tree"),
      card(r),
      ...branches,
      ...(branches.length ? [] : [el("div", "p3-empty", "No team yet. Ask the chat to spawn one.")]),
      foot,
    )
  }

  // ---------- detail ----------
  const renderHead = (n: Node) => {
    const crumbs = el("div", "p3-crumbs")
    for (const a of ancestors(m, n.id))
      crumbs.append(
        btn(a.kind === "desk" ? "Global" : a.title.slice(0, 24), () => choose(a.id)),
        el("span", "", "›"),
      )
    crumbs.append(el("b", "", KIND[n.kind]))
    const st = el("div", "p3-sub p3-row")
    const why = n.agent ? modelReason(n.agent) : null
    const reason = why ? el("span", "p3-why", `⇢ ${why.text}`) : null
    if (reason && why) reason.title = why.title
    st.append(
      pill(n),
      ...(n.agent ? [harnessBadge(n.agent.harness)] : []),
      el(
        "span",
        "p3-ell",
        [n.agent?.model, n.thread?.folderId, n.thread?.branch && `⎇ ${n.thread.branch}`].filter(Boolean).join(" · "),
      ),
      ...(reason ? [reason] : []),
    )
    const acts = el("div", "p3-acts")
    for (const d of n.pending) acts.append(btn(`⚑ ${d.title}`, () => openDecision(d.id), "warn"))
    if (n.agent) acts.append(btn("⚙ Spec", () => openSpec(n.id)))
    const tl = tlOn.has(n.id)
    if (tl) {
      acts.append(
        btn("💬 Chat", () => (tlOn.delete(n.id), liveOn.delete(n.id), liveOff.add(n.id), render())),
        ...(n.agent
          ? [btn("◉ Live activity", () => (tlOn.delete(n.id), liveOff.delete(n.id), liveOn.add(n.id), render()))]
          : []),
      )
    } else if (n.agent && n.kind !== "worker" && n.kind !== "draft") {
      const live = showsLive(n)
      acts.append(
        btn(
          live ? "💬 Chat" : "◉ Live activity",
          () => (live ? (liveOn.delete(n.id), liveOff.add(n.id)) : (liveOff.delete(n.id), liveOn.add(n.id)), render()),
        ),
      )
    }
    // A dormant sub-coordinator (no live agent) still has its stored events, so its Timeline shows too.
    if (n.kind === "sub" && !tl) acts.append(btn("🕘 Timeline", () => (tlOn.add(n.id), render())))
    if (n.agent?.status === "running")
      acts.append(btn("■ Stop", () => fire(send(`/api/workers/${encodeURIComponent(n.id)}/abort`, "POST"))))
    if (n.kind === "draft" && n.thread)
      acts.append(btn("▶ Run draft", () => fire(send(`/api/drafts/${n.thread!.id}/run`, "POST")), "primary"))
    const kids = el("div", "p3-kids")
    for (const id of n.children) {
      const k = m.nodes.get(id)!
      const b = btn(
        `${ICON[k.kind]} ${k.kind === "worker" ? (k.agent?.name ?? k.title) : k.title.slice(0, 28)}`,
        () => choose(k.id),
        `s-${k.status}`,
      )
      b.prepend(el("i", "p3-dot"))
      kids.append(b)
    }
    head.replaceChildren(crumbs, el("h2", "p3-ell", n.title), st, acts, ...(n.children.length ? [kids] : []))
  }
  /** Worker: its live transcript and a composer to the worker or to the coordinator it reports to. */
  const workerBody = (n: Node): (() => void) => {
    const scroll = el("div", "p3-log")
    const form = el("form", "p3-comp")
    const to = el("select")
    const boss = bossOf(m, n.id)
    // A stopped worker cannot take messages; its coordinator can.
    if (n.status !== "stopped" || !boss?.agent)
      to.append(Object.assign(el("option", "", "this worker"), { value: n.id }))
    if (boss?.agent)
      to.append(
        Object.assign(el("option", "", `its ${KIND[boss.kind]}: ${boss.title.slice(0, 40)}`), { value: boss.id }),
      )
    const ta = el("textarea")
    ta.rows = 2
    to.onchange = () =>
      (ta.placeholder =
        to.value === n.id
          ? "Steer this worker… (Enter sends)"
          : "Ask its coordinator: more work, another worker… (Enter sends)")
    to.onchange(new Event("change"))
    const go = el("button", "primary", "Send")
    const label = el("label", "p3-sub", "To ")
    label.append(to)
    const chips = el("div", "p3-chips")
    for (const q of ["Status?", "Try another approach", "Stop and report up"])
      chips.append(btn(q, () => ((ta.value = q), form.requestSubmit())))
    form.append(label, ta, chips, go)
    form.onsubmit = (e) => {
      e.preventDefault()
      const text = ta.value.trim()
      if (!text) return
      ta.value = ""
      const target = to.value === n.id ? n : boss!
      void messageAgent(target.id, text, target.thread?.id).then(
        (err) => (ta.placeholder = err ? `Send failed: ${err}` : "Sent. Message again…"),
      )
    }
    ta.onkeydown = (e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), form.requestSubmit())
    askBox = el("div", "p3-asks")
    body.replaceChildren(scroll, askBox, form)
    return mountTranscript(scroll, n.id, { stopped: n.agent?.status !== "running" })
  }
  /** Open questions of the conversation the worker reports to (decisions belong to conversations, not workers), answered in place.
   *  Free-text questions open the decision drawer. */
  const renderAsks = (n: Node) => {
    if (!askBox) return
    const boss = bossOf(m, n.id)
    const from = boss ? ` · from its ${KIND[boss.kind]}` : ""
    askBox.replaceChildren(
      ...(boss?.pending ?? []).map((d) => {
        const q = el("div", "p3-ask")
        const acts = el("div", "p3-acts")
        const err = el("span", "p3-sub p3-err")
        for (const o of d.options)
          acts.append(
            btn(
              o,
              () =>
                void runApprovals(answer(d.id, o, null)).catch(
                  (e: { reason?: string }) => (err.textContent = e.reason ?? String(e)),
                ),
            ),
          )
        acts.append(
          btn(d.allowText || !d.options.length ? "Answer…" : "Details", () => openDecision(d.id)),
          err,
        )
        q.append(
          el("div", "p3-label", `${d.kind === "question" ? "Question for you" : "Approval for you"}${from}`),
          el("div", "", d.title),
          acts,
        )
        return q
      }),
    )
  }
  const draftBody = (n: Node) => {
    const p = el("pre", "p3-draft", n.title)
    body.replaceChildren(el("div", "p3-sub", "Not started yet. Run it, or refine it from the Org Canvas layout."), p)
    return () => {}
  }
  /** Place the host's native chat over the detail body. */
  const placeOverBody = () => {
    const box = body.getBoundingClientRect(),
      stage = root.getBoundingClientRect()
    placeChat({ left: `${box.left - stage.left}px`, top: `${box.top - stage.top}px`, right: "0", bottom: "0" })
  }
  /** Stream click on an agent: show it in the inbox and tree; the stream stays open. */
  const streamSelect = (id: string) => {
    const n = m.nodes.get(id)
    if (!n) return
    const top = rootOf(m, id)
    if (top !== "coordinator" && !items(m, view).some((x) => x.root.id === top)) {
      autoView = false
      view = "chats"
    }
    sel = top
    cur = id
    render()
  }
  const STREAM_KIND: Record<Node["kind"], StreamAgent["kind"]> = {
    desk: "desk",
    chat: "chat",
    sub: "sub",
    worker: "worker",
    draft: "sub",
  }
  const streamAgent = (id: string): StreamAgent | undefined => {
    const n = m.nodes.get(id)
    if (n)
      return {
        name: n.kind === "worker" ? (n.agent?.name ?? n.title) : n.title,
        kind: STREAM_KIND[n.kind],
        status: n.agent?.status ?? "idle",
      }
    const a = s ? [...s.agents, ...s.past].find((x) => x.id === id) : undefined
    return (
      a && {
        name: a.name,
        kind: id.startsWith("sub-") ? "sub" : id.startsWith("gen-") ? "chat" : "worker",
        status: a.status,
      }
    )
  }
  const showStream = () => {
    head.replaceChildren()
    head.style.display = "none"
    placeChat(null)
    askBox = null
    const box = el("section", "p3-stream")
    box.dataset.testid = "factory-stream"
    body.replaceChildren(box)
    const v = mountStream(box, {
      agent: streamAgent,
      select: streamSelect,
      // The Inbox has no transcript that scrolls to an event: every hit opens the agent's history in a dialog.
      openHit: (h) => {
        const a = streamAgent(h.workerId)
        const live = !!s?.agents.some((x) => x.id === h.workerId)
        openHistory(
          h.workerId,
          h.seq,
          live ? `${a?.name ?? h.workerId} · live transcript` : `${a?.name ?? h.workerId} · stopped · saved history`,
          !live,
        )
      },
    })
    stream = v
    if (s) v.render(s)
    return () => ((stream = null), v.stop(), (head.style.display = ""))
  }
  const syncDetail = () => {
    if (streamOn) {
      if (mounted?.key === "stream") return
      mounted?.stop()
      mounted = { key: "stream", stop: showStream() }
      return
    }
    const n = cur ? m.nodes.get(cur) : undefined
    if (!n) {
      head.replaceChildren(el("div", "p3-empty", "Inbox zero."))
      if (mounted?.key !== "none") {
        mounted?.stop()
        mounted = { key: "none", stop: () => {} }
        body.replaceChildren()
        placeChat(null)
      }
      return
    }
    renderHead(n)
    const tl = tlOn.has(n.id) && n.kind === "sub"
    const live = !tl && showsLive(n)
    const chat = !tl && showsChat(n.id) && !live
    const key = tl ? `tl:${n.id}` : live ? `live:${n.id}` : n.id
    if (mounted?.key === key && n.kind === "worker") renderAsks(n)
    if (chat) placeOverBody()
    if (mounted?.key === key) return
    mounted?.stop()
    if (tl) {
      placeChat(null)
      askBox = null
      const box = el("div")
      box.dataset.testid = "timeline"
      body.replaceChildren(box)
      mounted = { key, stop: mountTimeline(box, n.id, { selectWorker: choose, focus: tlFocus }) }
      tlFocus = null
    } else if (live) {
      // The coordinator's own live log: every tool call, shell command and message, also for runs started from sf.
      placeChat(null)
      askBox = null
      const scroll = el("div", "p3-log")
      body.replaceChildren(
        el("div", "p3-sub", "Live activity of this coordinator (tool calls and messages). Switch back with 💬 Chat."),
        scroll,
      )
      mounted = { key, stop: mountTranscript(scroll, n.id, { stopped: n.agent?.status !== "running" }) }
    } else if (chat) {
      body.replaceChildren()
      if (n.thread) openThread(n.thread.id)
      mounted = { key: n.id, stop: () => {} }
    } else {
      placeChat(null)
      askBox = null
      mounted = { key: n.id, stop: n.kind === "worker" ? workerBody(n) : draftBody(n) }
      if (n.kind === "worker") renderAsks(n)
    }
  }

  const render = () => {
    if (!s) return
    const agents = [...s.agents, ...s.past]
    const live = build(agents, s.threads, s.decisions)
    m = view === "archived" ? build(agents, s.threads, s.decisions, true) : live
    renderSide(live)
    renderInbox()
    renderTree()
    syncDetail()
  }
  /** Native chat shows only for a conversation (chat, sub-coordinator, desk), never over a worker or draft. */
  const showsChat = (id: string | null) => {
    const k = id ? m.nodes.get(id)?.kind : undefined
    return !!k && k !== "worker" && k !== "draft"
  }
  /** "Open in timeline" on a plan or decision tool card in the live activity: show the Timeline at that milestone. */
  const openTimeline = (e: Event) => {
    const n = cur ? m.nodes.get(cur) : undefined
    if (n?.kind !== "sub") return
    tlFocus = String((e as CustomEvent).detail ?? "") || null
    tlOn.add(n.id)
    if (mounted?.key === `tl:${n.id}`) {
      mounted.stop()
      mounted = null
    }
    render()
  }
  window.addEventListener("sf:open-timeline", openTimeline)
  const ro = new ResizeObserver(() => mounted?.key === cur && showsChat(cur) && placeOverBody())
  ro.observe(head)
  ro.observe(root)
  // The shared state changes on every streamed event of any agent. A render replaces the tree and inbox rows, so it
  // runs only when what p3 draws changed, and waits while a pointer is down: a row replaced between mousedown and
  // mouseup gets no click.
  let seen: readonly unknown[] = []
  let drawn = ""
  const changed = (st: State): boolean => {
    const refs = [st.agents, st.past, st.threads, st.folders, st.decisions]
    if (refs.every((r, i) => r === seen[i])) return false
    seen = refs
    const next = JSON.stringify(refs, (k, v) => (VOLATILE.has(k) ? undefined : v))
    if (next === drawn) return false
    drawn = next
    return true
  }
  let pressed = false
  let owed = false
  const paint = () => (pressed ? (owed = true) : render())
  const press = () => void (pressed = true)
  // Click fires after pointerup in the same task; the owed render runs after it.
  const release = () => ((pressed = false), owed && ((owed = false), setTimeout(render)))
  root.addEventListener("pointerdown", press, true)
  window.addEventListener("pointerup", release, true)
  window.addEventListener("pointercancel", release, true)
  // Ages ("3m") move without data changes.
  const clock = setInterval(paint, 60_000)
  let ready = false
  const unsub = subscribe((st) => {
    s = st
    // The stream draws every agent's events, so it checks each update itself (it skips unchanged ones).
    stream?.render(st)
    // Wait for the first thread list; an empty one (a new factory) still draws the Inbox.
    if (!st.threadsLoaded) return
    if (!changed(st)) return
    const first = !ready
    ready = true
    // Until you pick a view, it follows: Needs me if anything needs you, else All conversations
    // (decisions can arrive after the threads, so this is checked on every update, the same in every host).
    if (autoView) view = count(build(st.agents, st.threads, st.decisions), "needs") ? "needs" : "chats"
    // The conversation the host already shows (?thread=) stays selected: the desk opens as the desk,
    // an archived conversation opens in "Marked done", any other in the view that lists it.
    // It counts as a pick, so the view stops following: a decision that arrives later must not move it to "Needs me".
    if (first) {
      const t = new URL(location.href).searchParams.get("thread")
      const thread = t ? st.threads.find((x) => x.id === t) : undefined
      if (thread) autoView = false
      if (thread?.desk) sel = cur = "coordinator"
      else if (thread) {
        if (thread.archivedAt) view = "archived"
        const shown = build(st.agents, st.threads, st.decisions, view === "archived")
        const hit = [...shown.nodes.values()].find((n) => n.thread?.id === t)
        const inView = hit && items(shown, view).find((x) => x.root.id === rootOf(shown, hit.id))
        if (hit && !inView && view !== "archived") view = "chats"
        const r = hit && items(shown, view).find((x) => x.root.id === rootOf(shown, hit.id))
        if (r) {
          sel = r.root.id
          cur = hit.id
        }
      }
    }
    paint()
  })
  placeChat(null)
  return () => (
    unsub(),
    window.removeEventListener("sf:open-timeline", openTimeline),
    ro.disconnect(),
    clearInterval(clock),
    root.removeEventListener("pointerdown", press, true),
    window.removeEventListener("pointerup", release, true),
    window.removeEventListener("pointercancel", release, true),
    mounted?.stop(),
    root.classList.remove("sfp-p3")
  )
}

register({
  id: 3,
  name: "Inbox",
  blurb: "Inbox of what needs you, the conversation tree, and the chat or worker you pick",
  mount,
})
