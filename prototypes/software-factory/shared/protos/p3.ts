// Prototype 3 — Inbox + workspace. Four columns:
//   sidebar (views, repos) · inbox (what needs you) · conversation tree (chat → sub-coordinators → workers) · detail.
// The detail of a chat, sub-coordinator or the desk is the host's native chat (placed by placeChat), so you keep talking to it.
// The detail of a worker is its live transcript plus a composer to the worker or to the coordinator it reports to.
import "./p3.css"
import { fire, send } from "../http"
import { harnessBadge } from "../harness"
import { openSpec } from "../spec"
import { el, messageAgent, mountTranscript, newThread, openDecision, openThread, register, subscribe, type Ctx, type State } from "./core"
import { ancestors, bossOf, build, count, items, rootOf, subtree, VIEWS, type Model, type Node, type View } from "./p3-model"

const LABEL: Record<Node["status"], string> = { running: "Running", idle: "Idle", error: "Failed", needs: "Needs you", dormant: "Dormant", draft: "Draft" }
const ICON: Record<Node["kind"], string> = { desk: "🌐", chat: "💬", sub: "◆", worker: "⚙", draft: "📄" }
const KIND: Record<Node["kind"], string> = { desk: "Factory desk", chat: "General chat", sub: "Sub-coordinator", worker: "Worker", draft: "Draft" }
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
const archive = (n: Node, at: number | null) => n.thread && fire(send(`/api/threads/update/${n.thread.id}`, "PATCH", { archivedAt: at }))

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
  let cur: string | null = null
  const opened = new Set<string>()
  let mounted: { key: string; stop: () => void } | null = null

  const choose = (id: string) => ((cur = id), render())

  // ---------- sidebar ----------
  const renderSide = (live: Model) => {
    const row = (v: View, label: string, n: number, badge = false) => {
      const r = el("div", `p3-sv ${view === v ? "on" : ""}`)
      r.append(el("span", "p3-ell", label), el("span", badge && n ? "p3-badge" : "p3-n", String(n)))
      r.onclick = () => ((view = v), (autoView = false), (sel = cur = null), render())
      return r
    }
    const desk = live.nodes.get("coordinator")
    const deskRow = el("div", `p3-sv ${cur === "coordinator" ? "on" : ""}`)
    deskRow.append(el("span", "p3-ell", "🌐 Factory desk"), el("span", "p3-n", desk?.agg.needs ? `▲${desk.pending.length}` : ""))
    deskRow.onclick = () => ((autoView = false), (sel = cur = "coordinator"), render())
    const repos = (s?.folders ?? []).filter((f) => f.path)
    const archivedN = (s?.threads ?? []).filter((t) => t.archivedAt && !t.desk).length
    side.replaceChildren(
      btn("＋ New General chat", () => newThread("general"), "p3-new"),
      el("h5", "", "Views"),
      ...VIEWS.map((v) => row(v.id, v.label, count(live, v.id), v.id === "needs")),
      deskRow,
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
    if (!sel || !list.some((x) => x.root.id === rootOf(m, sel!))) (sel = list[0]?.root.id ?? null), (cur = list[0]?.focus.id ?? null)
    if (!cur || !m.nodes.has(cur)) cur = sel
    const bar = el("div", "p3-bar")
    bar.append(el("span", "p3-n", `${list.length} ${list.length === 1 ? "conversation" : "conversations"}`))
    inbox.replaceChildren(bar, ...list.map(({ root: n, focus, reason, tone }) => {
      const r = el("div", `p3-item s-${tone} ${n.id === rootOf(m, sel!) ? "on" : ""}`)
      r.dataset.testid = "inbox-item"
      const top = el("div", "p3-row")
      top.append(el("b", "p3-ell", `${ICON[n.kind]} ${n.title}`), el("span", "p3-n", ago(n.thread?.createdAt)))
      const repos = [...new Set(subtree(m, n.id).map((x) => x.thread?.folderId).filter((f) => f && f !== "general"))]
      const where = el("div", "p3-sub p3-ell", `${KIND[n.kind]}${repos.length ? ` · ${repos.join(", ")}` : ""}`)
      r.append(top, where, el("div", "p3-sub p3-st p3-ell", reason))
      r.onclick = () => ((autoView = false), (sel = n.id), (cur = focus.id), render())
      return r
    }), ...(list.length ? [] : [el("div", "p3-empty", view === "needs" ? "Nothing needs you. 🎉" : "Nothing here.")]))
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
  const row = (n: Node) => {
    const r = el("div", `p3-w s-${n.status} ${n.id === cur ? "on" : ""}`)
    r.dataset.testid = "tree-row"
    r.append(el("i", "p3-dot"), el("b", "", n.kind === "draft" ? "📄 draft" : n.kind === "worker" ? n.agent?.name ?? "worker" : `${ICON[n.kind]} ${KIND[n.kind]}`), el("span", "p3-tt p3-ell", n.kind === "worker" ? n.agent?.task ?? "" : n.title), el("span", "p3-st", LABEL[n.status]))
    r.onclick = (e) => (e.stopPropagation(), choose(n.id))
    return r
  }
  /** A sub-coordinator card with its workers on their own branch. Quiet ones fold to one line. */
  const subCard = (n: Node) => {
    const c = card(n)
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
    if (!r) return void tree.replaceChildren(el("h5", "", "Conversation tree"), el("div", "p3-empty", "Select an item."))
    const branches = r.children.map((id) => {
      const k = m.nodes.get(id)!
      const b = el("div", "p3-br")
      b.append(k.kind === "sub" || k.children.length ? subCard(k) : row(k))
      return b
    })
    const foot = el("div", "p3-foot")
    if (r.thread && !r.thread.desk) foot.append(r.thread.archivedAt ? btn("Restore", () => archive(r, null)) : btn("Mark done (archive tree)", () => ((sel = cur = null), archive(r, Date.now()))))
    tree.replaceChildren(el("h5", "", "Conversation tree"), card(r), ...branches, ...(branches.length ? [] : [el("div", "p3-empty", "No team yet. Ask the chat to spawn one.")]), foot)
  }

  // ---------- detail ----------
  const renderHead = (n: Node) => {
    const crumbs = el("div", "p3-crumbs")
    for (const a of ancestors(m, n.id)) crumbs.append(btn(a.kind === "desk" ? "Global" : a.title.slice(0, 24), () => choose(a.id)), el("span", "", "›"))
    crumbs.append(el("b", "", KIND[n.kind]))
    const st = el("div", "p3-sub p3-row")
    st.append(pill(n), ...(n.agent ? [harnessBadge(n.agent.harness)] : []), el("span", "p3-ell", [n.agent?.model, n.thread?.folderId, n.thread?.branch && `⎇ ${n.thread.branch}`].filter(Boolean).join(" · ")))
    const acts = el("div", "p3-acts")
    for (const d of n.pending) acts.append(btn(`⚑ ${d.title}`, () => openDecision(d.id), "warn"))
    if (n.agent) acts.append(btn("⚙ Spec", () => openSpec(n.id)))
    if (n.agent?.status === "running") acts.append(btn("■ Stop", () => fire(send(`/api/workers/${encodeURIComponent(n.id)}/abort`, "POST"))))
    if (n.kind === "draft" && n.thread) acts.append(btn("▶ Run draft", () => fire(send(`/api/drafts/${n.thread!.id}/run`, "POST")), "primary"))
    const kids = el("div", "p3-kids")
    for (const id of n.children) {
      const k = m.nodes.get(id)!
      const b = btn(`${ICON[k.kind]} ${k.kind === "worker" ? k.agent?.name ?? k.title : k.title.slice(0, 28)}`, () => choose(k.id), `s-${k.status}`)
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
    to.append(Object.assign(el("option", "", "this worker"), { value: n.id }))
    const boss = bossOf(m, n.id)
    if (boss?.agent) to.append(Object.assign(el("option", "", `its ${KIND[boss.kind]}: ${boss.title.slice(0, 40)}`), { value: boss.id }))
    const ta = el("textarea")
    ta.rows = 2
    ta.placeholder = "Steer this worker… (Enter sends)"
    to.onchange = () => (ta.placeholder = to.value === n.id ? "Steer this worker… (Enter sends)" : "Ask its coordinator: more work, another worker… (Enter sends)")
    const go = el("button", "primary", "Send")
    const label = el("label", "p3-sub", "To ")
    label.append(to)
    form.append(label, ta, go)
    form.onsubmit = (e) => {
      e.preventDefault()
      const text = ta.value.trim()
      if (!text) return
      ta.value = ""
      const target = to.value === n.id ? n : boss!
      void messageAgent(target.id, text, target.thread?.id).then((err) => (ta.placeholder = err ? `Send failed: ${err}` : "Sent. Message again…"))
    }
    ta.onkeydown = (e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), form.requestSubmit())
    body.replaceChildren(scroll, form)
    return mountTranscript(scroll, n.id, { stopped: n.agent?.status !== "running" })
  }
  const draftBody = (n: Node) => {
    const p = el("pre", "p3-draft", n.title)
    body.replaceChildren(el("div", "p3-sub", "Not started yet. Run it, or refine it from the Org Canvas layout."), p)
    return () => {}
  }
  /** Place the host's native chat over the detail body. */
  const placeOverBody = () => {
    const box = body.getBoundingClientRect(), stage = root.getBoundingClientRect()
    placeChat({ left: `${box.left - stage.left}px`, top: `${box.top - stage.top}px`, right: "0", bottom: "0" })
  }
  const syncDetail = () => {
    const n = cur ? m.nodes.get(cur) : undefined
    if (!n) {
      head.replaceChildren(el("div", "p3-empty", "Inbox zero."))
      if (mounted?.key !== "none") (mounted?.stop(), (mounted = { key: "none", stop: () => {} }), body.replaceChildren(), placeChat(null))
      return
    }
    renderHead(n)
    const chat = showsChat(n.id)
    if (chat) placeOverBody()
    if (mounted?.key === n.id) return
    mounted?.stop()
    if (chat) {
      body.replaceChildren()
      if (n.thread) openThread(n.thread.id)
      mounted = { key: n.id, stop: () => {} }
    } else {
      placeChat(null)
      mounted = { key: n.id, stop: n.kind === "worker" ? workerBody(n) : draftBody(n) }
    }
  }

  const render = () => {
    if (!s) return
    const live = build(s.agents, s.threads, s.decisions)
    m = view === "archived" ? build(s.agents, s.threads, s.decisions, true) : live
    renderSide(live)
    renderInbox()
    renderTree()
    syncDetail()
  }
  /** Native chat shows only for a conversation (chat, sub-coordinator, desk), never over a worker or draft. */
  const showsChat = (id: string | null) => { const k = id ? m.nodes.get(id)?.kind : undefined; return !!k && k !== "worker" && k !== "draft" }
  const ro = new ResizeObserver(() => mounted?.key === cur && showsChat(cur) && placeOverBody())
  ro.observe(head)
  ro.observe(root)
  let ready = false
  const unsub = subscribe((st) => {
    s = st
    if (!st.threads.length) return
    const first = !ready
    ready = true
    // Until you pick a view, it follows: Needs me if anything needs you, else All conversations
    // (decisions can arrive after the threads, so this is checked on every update, the same in every host).
    if (autoView) view = count(build(st.agents, st.threads, st.decisions), "needs") ? "needs" : "chats"
    // The conversation the host already shows (?thread=) is selected when it is in that view.
    if (first) {
      const live = build(st.agents, st.threads, st.decisions)
      const t = new URL(location.href).searchParams.get("thread")
      const hit = t ? [...live.nodes.values()].find((n) => n.thread?.id === t) : undefined
      const r = hit && items(live, view).find((x) => x.root.id === rootOf(live, hit.id))
      if (r) (sel = r.root.id), (cur = r.focus.id)
    }
    render()
  })
  placeChat(null)
  return () => (unsub(), ro.disconnect(), mounted?.stop(), root.classList.remove("sfp-p3"))
}

register({ id: 3, name: "Inbox", blurb: "Inbox of what needs you, the conversation tree, and the chat or worker you pick", mount })
