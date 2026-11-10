// Prototype 2 — Org Canvas: the factory as a live org chart. Global coordinator on top, sub-coordinators
// below, workers under their owner. Click a node: a slide-over opens with its conversation (native chat for
// coordinators, readable transcript + direct message for workers). Nothing selected: the global chat floats docked.
// Left rail: the factory stream (one timeline across agents, Slack-style runs, report/decision/review cards),
// filtered to the selected node's subtree; clicking an agent in the stream selects its node.
import "./p2.css"
import { openSpec } from "../spec"
import { harnessBadge } from "../harness"
import { markdown } from "../decisions"
import { Effect, Schema } from "effect"
import { fire, json, send } from "../http"
import { Draft } from "../schemas"
import { colorOf, mountStream, openHistory } from "./stream"
import {
  agentLabel,
  el,
  newThread,
  messageAgent,
  mountTranscript,
  openAgentChat,
  openDecision,
  openThread,
  register,
  statusColor,
  subscribe,
  threadOf,
  type Agent,
  type Ctx,
  type Decision,
  type Review,
  type State,
  type Thread,
} from "./core"

type Node = {
  id: string
  kind: "global" | "sub" | "worker" | "ghost" | "draft"
  tag: string
  name: string
  status: string
  agent?: Agent
  thread?: Thread
  parent: string | null
  children: Node[]
  x: number
  y: number
  w: number
}

const W = 236,
  H = 132,
  GX = 26,
  GY = 74,
  PAD = 40,
  HEAD = 78
const MAX_GHOSTS = 6
/** Width the docked global chat takes from the canvas when nothing is selected (518px chat + gaps). */
const DOCK_W = 560
/** Row label from what is in the row: a dormant or desk-owned repo conversation sits next to General chats, so a fixed label per depth is wrong. */
const ROLE = (n: Node) =>
  n.kind === "global"
    ? "Factory desk · event inbox · read only"
    : n.id.startsWith("gen-")
      ? "General chats · chat here"
      : n.kind === "worker"
        ? "Workers"
        : n.kind === "draft"
          ? "Drafts · not started"
          : "Repo conversations · one per run"
const tierLabels = (nodes: Iterable<Node>): [number, string][] => {
  const rows = new Map<number, Set<string>>()
  for (const n of nodes) (rows.get(n.y) ?? rows.set(n.y, new Set()).get(n.y)!).add(ROLE(n))
  return [...rows].sort((a, b) => a[0] - b[0]).map(([y, r]) => [y, [...r].join("  +  ")])
}

const agentNode = (a: Agent): Node => {
  const l = agentLabel(a)
  const tag =
    l.kind === "global"
      ? "Factory desk"
      : a.id.startsWith("gen-")
        ? "General chat"
        : l.kind === "sub"
          ? `Sub-coordinator · ${a.name.split(" · ")[0]}`
          : "Worker"
  return {
    id: a.id,
    kind: l.kind,
    tag,
    name: l.kind === "global" ? "Factory desk" : l.name,
    status: a.status,
    agent: a,
    thread: l.kind === "sub" ? threadOf(a.id) : undefined,
    parent: null,
    children: [],
    x: 0,
    y: 0,
    w: W,
  }
}

const linkParents = (nodes: Map<string, Node>) => {
  const root = nodes.get("coordinator")
  for (const n of nodes.values()) {
    if (n === root) continue
    // A draft node has no agent, and a stopped worker may hang under a dormant conversation: buildTree sets their `parent`.
    const o = n.kind === "draft" || n.agent?.status === "stopped" ? n.parent : n.agent?.owner
    n.parent = o && o !== n.id && nodes.has(o) ? o : root ? root.id : null
    if (n.parent) nodes.get(n.parent)!.children.push(n)
  }
}

const placeNode = (n: Node, x: number, depth: number): number => {
  n.y = depth * (H + GY)
  if (!n.children.length) return ((n.x = x), (n.w = W))
  let cx = x
  for (const c of n.children) cx += placeNode(c, cx, depth + 1) + GX
  n.w = Math.max(W, cx - GX - x)
  n.x = x + (n.w - W) / 2
  return n.w
}

/** A draft that has not started yet: it shows as a draft node, not as a ghost or a sub-coordinator. */
const isDraft = (t: Thread) => !!t.draft && !t.draft.startedAt
const draftPrompt = (t: Thread) => t.draft?.versions.find((v) => v.id === t.draft!.current)?.prompt ?? ""

/** The ring around a draft node, in clockwise order from the top. */
const RING = [
  ["enhance", "✨", "Enhance"],
  ["council", "🏛", "Council"],
  ["debate", "⚖", "Debate"],
  ["research", "🔎", "Research"],
  ["hyperresearch", "📚", "Hyperresearch"],
  ["run", "▶", "Run"],
] as const
type RingAction = (typeof RING)[number][0]
const LABEL: Record<string, string> = Object.fromEntries(RING.map(([a, , l]) => [a, l]))

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

/** Build the org tree: agents by owner, unstarted drafts under their General chat (else the global node), and dormant repo conversations (no live sub-coordinator) as ghosts under the global node. */
const buildTree = (s: State, focus: string | null = null): Map<string, Node> => {
  const archivedChat = (a: Agent) =>
    a.id.startsWith("gen-") && s.threads.some((t) => !t.worktree && t.archivedAt && `gen-${t.id.slice(0, 8)}` === a.id)
  const nodes = new Map(s.agents.filter((a) => !archivedChat(a)).map((a) => [a.id, agentNode(a)]))
  const live = new Set(s.agents.map((a) => a.id))
  for (const t of s.threads.filter((x) => isDraft(x) && !x.archivedAt)) {
    const id = `draft-${t.id.slice(0, 8)}`
    const gen = t.parentThreadId ? `gen-${t.parentThreadId.slice(0, 8)}` : null
    nodes.set(id, {
      id,
      kind: "draft",
      tag: `Draft · ${t.folderId}`,
      name: draftPrompt(t).slice(0, 48),
      status: "draft",
      thread: t,
      parent: gen && live.has(gen) ? gen : null,
      children: [],
      x: 0,
      y: 0,
      w: W,
    })
  }
  s.threads
    .filter((t) => t.worktree && !t.cleanedAt && !t.archivedAt && !isDraft(t) && !live.has(`sub-${t.id.slice(0, 8)}`))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_GHOSTS)
    .forEach((t) =>
      nodes.set(`t:${t.id}`, {
        id: `t:${t.id}`,
        kind: "ghost",
        tag: `Dormant · ${t.folderId}`,
        name: t.title,
        status: "dormant",
        thread: t,
        parent: null,
        children: [],
        x: 0,
        y: 0,
        w: W,
      }),
    )
  // Stopped workers, for the record, only along the selected node's chain (there can be dozens across the factory):
  // under their live sub-coordinator or its dormant conversation. Orphans are left out.
  const byStream = new Map([...nodes.values()].map((n) => [streamId(n), n.id]))
  // The chain is in agent ids: a dormant conversation's node is `t:<thread>`, its agent id `sub-<thread>`.
  const ownerOf = new Map([...s.agents, ...s.past].map((a) => [a.id, a.owner ?? null]))
  const chain = new Set<string>()
  for (
    let id = focus && nodes.has(focus) ? streamId(nodes.get(focus)!) : focus;
    id && !chain.has(id);
    id = ownerOf.get(id) ?? null
  )
    chain.add(id)
  for (const a of s.past) {
    const owner = a.owner ? byStream.get(a.owner) : undefined
    if (owner && chain.has(a.owner!) && !nodes.has(a.id)) nodes.set(a.id, { ...agentNode(a), parent: owner })
  }
  linkParents(nodes)
  // Siblings in spawn order (oldest first).
  for (const n of nodes.values()) n.children.sort((a, b) => (a.agent?.startedAt ?? 0) - (b.agent?.startedAt ?? 0))
  let x = 0
  for (const n of nodes.values()) if (!n.parent) x += placeNode(n, x, 0) + GX * 2
  return nodes
}

/** Stream agent id of a node: a dormant conversation's events still belong to its sub-coordinator id. */
const streamId = (n: Node) => (n.kind === "ghost" ? `sub-${n.thread!.id.slice(0, 8)}` : n.id)

const generalIds = (s: State) => new Set(s.threads.filter((t) => t.folderId === "general").map((t) => t.id))
const pendingOf = (s: State, n: Node): Decision[] => {
  const p = s.decisions.filter((d) => d.status === "pending")
  if (n.kind === "global") {
    const g = generalIds(s)
    return p.filter((d) => !d.threadId || g.has(d.threadId))
  }
  return n.thread ? p.filter((d) => d.threadId === n.thread!.id) : []
}
const reviewOf = (s: State, n: Node): Review | undefined =>
  n.thread
    ? s.reviews.filter((r) => r.threadId === n.thread!.id).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
    : undefined
const reviewText = (r: Review) => {
  if (r.status !== "done") return `review ${r.status}`
  const kept = r.findings.filter((f) => f.verdict === "keep").length
  return r.findings.length ? `${r.findings.length} findings · ${kept} kept` : "review clean"
}
/** The repo conversation a node works in: its own for a sub-coordinator or ghost, its owner's for a worker. */
const worktreeOf = (n: Node): Thread | undefined => n.thread ?? (n.agent?.owner ? threadOf(n.agent.owner) : undefined)
const shortSha = (s?: string) => (s ? s.slice(0, 7) : "")
/** One line naming where the node's work happens: repo, branch, and the commit it came from. */
const worktreeLine = (t: Thread) => `${t.folderId} ⎇ ${t.branch ?? "?"}${t.base ? ` ← ${shortSha(t.base)}` : ""}`

const activityText = (s: State, n: Node) => {
  if (n.kind === "ghost") return n.thread?.branch ?? "no live coordinator"
  const a = s.activity[n.id]
  if (a) return `${a.label} ${a.detail}`.trim()
  return n.agent?.status === "running"
    ? "Working…"
    : n.agent?.status === "stopped"
      ? "Stopped · saved history"
      : (n.agent?.lastMessage ?? "Idle").replace(/[`*#>\n]+/g, " ").trim()
}

/** Archive hides a dormant conversation or a General chat from the canvas. Delete removes the conversation (and a repo conversation's worktree and local branch). */
const ghostAction = (t: Thread, kind: "archive" | "delete") => {
  const b = el("button", `p2-gact ${kind}`, kind === "archive" ? "⤓" : "✕")
  b.title =
    kind === "archive"
      ? "Archive: hide from the canvas (stays in the sidebar)"
      : t.worktree
        ? "Delete conversation, worktree, and branch"
        : "Delete chat"
  b.setAttribute("aria-label", `${kind === "archive" ? "Archive" : "Delete"} ${t.title}`)
  b.onclick = (e) => {
    e.stopPropagation()
    if (kind === "archive") return fire(send(`/api/threads/update/${t.id}`, "PATCH", { archivedAt: Date.now() }))
    const what = t.worktree
      ? `the conversation, the worktree ${t.worktree} (uncommitted changes too), and the local branch ${t.branch ?? ""}`
      : "the chat and its messages, and stops its session"
    if (!confirm(`Delete "${t.title}"?\n\nThis removes ${what}. It cannot be undone.`)) return
    fire(send(`/api/threads/delete/${t.id}`, "DELETE"))
  }
  return b
}

/** Replace only the children whose HTML changed. The shared state changes on every streamed event; an unchanged
 *  button stays the same element, so a click on it is not lost. */
const patchChildren = (host: Element, next: Element[]) => {
  const old = host.children
  if (old.length !== next.length) return host.replaceChildren(...next)
  next.forEach((n, i) => old[i]!.outerHTML !== n.outerHTML && old[i]!.replaceWith(n))
}

const mount = ({ root, placeChat }: Ctx): (() => void) => {
  root.classList.add("sfp-p2")
  const canvas = el("div", "p2-canvas")
  const world = el("div", "p2-world")
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.classList.add("p2-edges")
  world.append(svg)
  canvas.append(world)
  const top = el("div", "p2-top")
  const brand = el("div", "p2-brand")
  const where = el("span")
  brand.append(el("b", "", "Org Canvas"), where)
  const stats = el("div", "p2-stats")
  const decisions = el("div", "p2-decisions")
  // "+ Draft": an inline form that creates a draft in a repo folder (POST /api/drafts).
  const draftBox = el("div", "p2-newdraft")
  const draftBtn = el("button", "p2-newchat", "+ Draft")
  draftBtn.dataset.testid = "new-draft"
  draftBtn.title = "Write a prompt as a draft first: refine, enhance or research it before a run starts"
  const draftForm = el("form", "p2-draft-form")
  const draftFolder = el("select")
  draftFolder.setAttribute("aria-label", "Repo folder")
  const draftText = el("textarea")
  draftText.placeholder = "What should the factory do?"
  draftText.rows = 4
  draftText.setAttribute("aria-label", "Draft prompt")
  const draftErr = el("div", "p2-err")
  const draftCreate = el("button", "p2-newchat", "Create")
  draftCreate.type = "submit"
  draftForm.append(draftFolder, draftText, draftErr, draftCreate)
  draftForm.hidden = true
  draftBox.append(draftBtn, draftForm)
  draftBtn.onclick = () => {
    draftForm.hidden = !draftForm.hidden
    if (draftForm.hidden) return
    const repos = s?.folders.filter((f) => f.path) ?? []
    draftFolder.replaceChildren(...repos.map((f) => Object.assign(el("option", "", f.name), { value: f.id })))
    draftErr.textContent = repos.length ? "" : "No repo folder yet: add one first."
    draftText.focus()
  }
  draftForm.onsubmit = (e) => {
    e.preventDefault()
    const prompt = draftText.value.trim()
    if (!prompt || !draftFolder.value) return
    draftCreate.disabled = true
    draftErr.textContent = ""
    void Effect.runPromise(
      send("/api/drafts", "POST", { folderId: draftFolder.value, prompt }).pipe(
        Effect.match({ onFailure: (err) => errorText(err.reason), onSuccess: () => null }),
      ),
    ).then((error) => {
      draftCreate.disabled = false
      if (error) return void (draftErr.textContent = `Create failed: ${error}`)
      draftText.value = ""
      draftForm.hidden = true
    })
  }
  top.append(brand, draftBox, decisions, stats)
  const dock = el("div", "p2-dock")
  const dockCue = el("div", "p2-dock-cue", "▼ Type new requests here · ＋ New chat for each new topic")
  const dockHead = el("div", "p2-dock-head")
  dock.append(dockHead)
  const panel = el("aside", "p2-panel")
  const panelHead = el("div", "p2-panel-head")
  const panelBody = el("div", "p2-panel-body")
  panel.append(panelHead, panelBody)
  const rail = el("section", "p2-rail")
  root.replaceChildren(rail, canvas, top, dock, dockCue, panel)

  let s: State | null = null
  let nodes = new Map<string, Node>()
  let sel: string | null = null
  let mounted: { key: string; stop: () => void } | null = null
  const cards = new Map<string, HTMLElement>()
  const edges = new Map<string, SVGPathElement>()
  let orderKey = ""
  const tiers = el("div", "p2-tiers")
  world.append(tiers)

  let railOpen = true
  let alive = true

  const select = (id: string | null) => {
    // A draft node has no chat: a click toggles its action ring and never opens a conversation.
    if (id && nodes.get(id)?.kind === "draft") {
      ring = ring === id ? null : id
      sel = null
      sync(true)
      if (ring) ringBtns.find((b) => !b.disabled)?.focus({ preventScroll: true })
      return
    }
    if (id) overId = null
    sel = id && nodes.has(id) ? id : null
    if (s) nodes = buildTree(s, sel)
    sync(true)
  }

  // ---------- draft node: action ring and slide-over ----------

  /** Show a draft's slide-over; it replaces an open agent panel, which would cover it. */
  const openOver = (id: string) => {
    ring = null
    sel = null
    overId = id
    if (alive) sync(true)
  }
  let ring: string | null = null
  /** Thread id of the draft open in the slide-over. */
  let overId: string | null = null
  let overSig = ""
  /** Draft actions waiting for the server, and the last error per draft (full text; the card shows its first line). */
  const busy = new Map<string, RingAction>()
  const errs = new Map<string, string>()
  const DOCK_BOX = { right: "21px", bottom: "57px", width: "518px", height: "calc(70% - 40px)" }
  const ringEl = el("div", "p2-ring")
  ringEl.setAttribute("role", "menu")
  /** Ellipse radii: the buttons sit just outside the 236×132 card. */
  const RX = 170,
    RY = 118
  const ringBtns = RING.map(([a, icon, label], i) => {
    const b = el("button", "p2-ring-btn", icon)
    b.setAttribute("role", "menuitem")
    b.setAttribute("aria-label", label)
    b.append(el("span", "", label))
    const ang = (i / RING.length) * 2 * Math.PI - Math.PI / 2
    b.style.transform = `translate(${Math.round(Math.cos(ang) * RX)}px, ${Math.round(Math.sin(ang) * RY)}px)`
    b.onclick = (e) => {
      e.stopPropagation()
      const n = ring ? nodes.get(ring) : undefined
      if (n) act(n.thread!.id, a)
    }
    return b
  })
  ringEl.append(...ringBtns)
  const over = el("aside", "p2-draftover")
  over.setAttribute("aria-label", "Draft versions and reports")
  root.append(over)

  const running = (id: string) => !!s?.agents.some((a) => a.id === id && a.status === "running")
  /** Why a ring action cannot start now, or null. */
  const blocked = (n: Node, a: RingAction): string | null => {
    const t = n.thread!,
      d = t.draft!,
      b = busy.get(t.id)
    if (b) return b === "enhance" ? "Enhancing…" : `${LABEL[b]} is starting…`
    if (a === "enhance") return null
    if (d.pending) return "Pick a rewrite first"
    if (a === "run") {
      const r = d.reports.find((x) => running(x.workerId))
      return r
        ? `${LABEL[r.action]} is running`
        : s!.agents.some((x) => x.owner === n.id && x.status === "running")
          ? "A draft worker is running"
          : null
    }
    return d.reports.some((r) => r.action === a && running(r.workerId)) ? `${LABEL[a]} is running` : null
  }

  /** POST a draft endpoint; the reply is the new Draft. Resolves to the error text, or null. */
  const post = (id: string, path: string, body?: unknown) =>
    Effect.runPromise(
      json(`/api/drafts/${id}/${path}`, Draft, {
        method: "POST",
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }).pipe(Effect.match({ onFailure: (e) => errorText(e.reason), onSuccess: () => null })),
    )

  const act = (id: string, a: RingAction) => {
    ring = null
    busy.set(id, a)
    errs.delete(id)
    sync()
    void post(id, a).then((err) => {
      busy.delete(id)
      if (err) errs.set(id, err)
      // Enhance opens the slide-over either way: candidates, or the full error.
      if (a === "enhance") return void openOver(id)
      else if (a === "run") overId = null
      if (alive) sync()
    })
  }
  /** Pick a candidate or switch the current version from the slide-over. */
  const change = (id: string, path: string, body: unknown) => {
    errs.delete(id)
    void post(id, path, body).then((err) => {
      if (err) errs.set(id, err)
      if (alive) sync()
    })
  }

  /** Discard a draft (DELETE /api/drafts/:id); a failure shows on its card. */
  const discardDraft = (t: Thread) => {
    const b = el("button", "p2-gact delete", "✕")
    b.title = "Delete draft, its worktree, and branch"
    b.setAttribute("aria-label", `Delete draft ${t.title}`)
    b.onclick = (e) => {
      e.stopPropagation()
      if (
        !confirm(
          `Delete draft "${t.title}"?\n\nThis removes the draft, its worktree ${t.worktree ?? ""} (reports too), and the local branch ${t.branch ?? ""}. It cannot be undone.`,
        )
      )
        return
      errs.delete(t.id)
      void Effect.runPromise(
        send(`/api/drafts/${t.id}`, "DELETE").pipe(
          Effect.match({ onFailure: (err) => errorText(err.reason), onSuccess: () => null }),
        ),
      ).then((err) => {
        if (err) errs.set(t.id, `Delete failed: ${err}`)
        if (alive) sync()
      })
    }
    return b
  }

  const renderRing = () => {
    const n = ring ? nodes.get(ring) : undefined
    if (n?.kind !== "draft") ring = null
    if (!n || !ring) return void ringEl.remove()
    ringEl.style.left = `${n.x + PAD + W / 2}px`
    ringEl.style.top = `${n.y + PAD + H / 2}px`
    ringEl.setAttribute("aria-label", `Draft actions: ${n.name}`)
    RING.forEach(([a, , label], i) => {
      const why = blocked(n, a)
      ringBtns[i]!.disabled = !!why
      ringBtns[i]!.title = why ?? label
    })
    if (!ringEl.isConnected) world.append(ringEl)
  }

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
    const body = el("div", "sfs-body p2-report full", "Loading…")
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

  const versionRow = (t: Thread, i: number) => {
    const d = t.draft!,
      v = d.versions[i]!
    const row = el("div", "p2-ver")
    const head = el("div", "p2-ver-head")
    head.append(el("b", "", `v${i + 1}`), el("span", "p2-ph-tag", v.source), el("span", "p2-ver-title", v.title ?? ""))
    if (v.id === d.current) head.append(el("span", "p2-badge ok", "current"))
    else {
      const use = el("button", "p2-newchat", "Use")
      use.title = `Make v${i + 1} the current prompt`
      use.onclick = () => change(t.id, "current", { versionId: v.id })
      head.append(use)
    }
    row.append(head)
    if (v.notes) row.append(el("div", "p2-ver-notes", v.notes))
    if (!i) return (row.append(el("div", "p2-ver-prompt", v.prompt)), row)
    const diff = el("div", "p2-diff")
    diff.setAttribute("aria-label", `Changes from v${i} to v${i + 1}`)
    for (const [op, line] of lineDiff(d.versions[i - 1]!.prompt.split("\n"), v.prompt.split("\n")))
      diff.append(el("div", op === "-" ? "del" : op === "+" ? "add" : "same", `${op} ${line}`))
    return (row.append(diff), row)
  }

  /** Slide-over of one draft: enhance candidates, versions (newest first, diff to the previous), and reports. */
  const renderOver = () => {
    const t = overId ? s?.threads.find((x) => x.id === overId && isDraft(x)) : undefined
    if (!t) overId = null
    if (root.classList.contains("drafting") !== !!t) {
      root.classList.toggle("drafting", !!t)
      // The slide-over takes the docked chat's place.
      if (!sel) placeChat(t ? null : DOCK_BOX)
    }
    const sig = t ? JSON.stringify([t.draft, errs.get(t.id)]) : ""
    if (sig === overSig) return
    overSig = sig
    if (!t) return void over.replaceChildren()
    const d = t.draft!
    const close = el("button", "p2-close", "✕")
    close.title = "Close (Esc)"
    close.setAttribute("aria-label", "Close draft")
    close.onclick = () => ((overId = null), sync())
    const head = el("div", "p2-ph-row p2-over-head")
    head.append(
      el("span", "p2-ph-tag", `Draft · ${t.folderId}`),
      el("span", "p2-ph-act", draftPrompt(t).split("\n")[0]!),
      close,
    )
    const body = el("div", "p2-over-body")
    const err = errs.get(t.id)
    if (err) body.append(el("div", "p2-err p2-err-full", err))
    if (d.pending) {
      body.append(el("h4", "", "Pick a rewrite"))
      const row = el("div", "p2-cands")
      d.pending.candidates.forEach((c, i) => {
        const card = el("div", "p2-cand")
        const pick = el("button", "p2-newchat", "Pick")
        pick.onclick = () => change(t.id, "pick", { index: i })
        card.append(
          el("b", "", c.title),
          el("div", "p2-cand-prompt", c.prompt),
          el("div", "p2-ver-notes", c.notes),
          pick,
        )
        row.append(card)
      })
      const keep = el("button", "p2-more", "Keep current")
      keep.title = "Dismiss the rewrites and keep the current prompt"
      keep.onclick = () => change(t.id, "dismiss", undefined)
      body.append(row, keep)
    }
    body.append(el("h4", "", "Versions"))
    for (let i = d.versions.length - 1; i >= 0; i--) body.append(versionRow(t, i))
    if (d.reports.length) {
      body.append(el("h4", "", "Reports"))
      const chips = el("div", "p2-chips")
      for (const r of d.reports) {
        const b = el(
          "button",
          "p2-chip",
          `${LABEL[r.action]} · v${d.versions.findIndex((v) => v.id === r.versionId) + 1}`,
        )
        b.title = r.path
        b.onclick = () => openReport(t.id, r.path)
        chips.append(b)
      }
      body.append(chips)
    }
    over.replaceChildren(head, body)
  }

  const fit = () => {
    const cw = Math.max(...[...nodes.values()].map((n) => n.x + W), W) + PAD * 2
    const ch = Math.max(...[...nodes.values()].map((n) => n.y + H), H) + PAD * 2
    const aw = canvas.clientWidth - (sel || overId ? 0 : DOCK_W),
      ah = canvas.clientHeight - HEAD - (sel ? 50 : 40)
    const k = Math.min(1, aw / cw, ah / ch)
    world.style.width = `${cw}px`
    world.style.height = `${ch}px`
    svg.setAttribute("width", String(cw))
    svg.setAttribute("height", String(ch))
    world.style.transform = `translate(${Math.max(0, (aw - cw * k) / 2)}px, ${HEAD}px) scale(${k})`
  }

  const styleCard = (n: Node, card: HTMLElement) => {
    const path = new Set<string>()
    for (let p: string | null = sel; p; p = nodes.get(p)?.parent ?? null) path.add(p)
    card.className = `p2-node k-${n.kind}${n.kind === "draft" ? " draft" : ""} s-${n.status}${sel === n.id ? " sel" : ""}${sel && !path.has(n.id) ? " dim" : ""}`
    card.style.left = `${n.x + PAD}px`
    card.style.top = `${n.y + PAD}px`
    card.style.setProperty("--glow", n.kind === "ghost" || n.kind === "draft" ? "#525252" : statusColor(n.status))
    card.style.setProperty("--c", colorOf(streamId(n)))
  }

  const cardHead = (n: Node) => {
    const pend = pendingOf(s!, n),
      rev = reviewOf(s!, n)
    const head = el("div", "p2-n-head")
    head.append(el("i", "p2-dot"))
    if (n.agent) head.append(harnessBadge(n.agent.harness))
    head.append(el("span", "p2-tag", n.tag))
    if (pend.length) {
      const b = el("button", "p2-badge warn", `⚑ ${pend.length}`)
      b.title = pend.map((d) => d.title).join("\n")
      b.onclick = (e) => (e.stopPropagation(), openDecision(pend[0].id))
      head.append(b)
    }
    if (rev)
      head.append(
        el(
          "span",
          `p2-badge ${rev.findings.some((f) => f.verdict === "keep") ? "warn" : "ok"}`,
          rev.findings.length ? `🛡 ${rev.findings.length}` : "🛡 ✓",
        ),
      )
    const chat = n.id.startsWith("gen-") ? threadOf(n.id) : undefined
    const t = n.kind === "ghost" ? n.thread! : chat
    if (t) head.append(ghostAction(t, "archive"), ghostAction(t, "delete"))
    return head
  }

  /** Draft card: version badge, one chip per report (dimmed while its worker runs). */
  const renderDraftCard = (n: Node, card: HTMLElement) => {
    const t = n.thread!,
      d = t.draft!
    const head = el("div", "p2-n-head")
    const badge = el("button", "p2-badge", `v${d.versions.findIndex((v) => v.id === d.current) + 1}`)
    badge.title = "Versions and reports"
    badge.onclick = (e) => (e.stopPropagation(), openOver(t.id))
    head.append(el("i", "p2-dot"), el("span", "p2-tag", n.tag), badge, discardDraft(t))
    const chips = el("div", "p2-n-act p2-chips")
    if (d.pending) {
      const pick = el("button", "p2-chip pend", `✨ ${d.pending.candidates.length} rewrites · pick one`)
      pick.title = "Open the Enhance rewrites"
      pick.onclick = (e) => (e.stopPropagation(), openOver(t.id))
      chips.append(pick)
    }
    // A finished report opens from the card; a running one says so.
    for (const r of d.reports) {
      const isRunning = s!.agents.some((a) => a.id === r.workerId && a.status === "running")
      if (isRunning) {
        chips.append(el("span", "p2-chip run", `${LABEL[r.action]} · running…`))
        continue
      }
      const open = el(
        "button",
        "p2-chip done",
        `📄 ${LABEL[r.action]} · v${d.versions.findIndex((v) => v.id === r.versionId) + 1}`,
      )
      open.title = `Open ${r.path}`
      open.onclick = (e) => (e.stopPropagation(), openReport(t.id, r.path))
      chips.append(open)
    }
    const err = errs.get(t.id),
      b = busy.get(t.id)
    patchChildren(card, [
      head,
      el("div", "p2-n-name", n.name),
      el("div", "p2-n-wt", t.folderId),
      chips,
      ...(err ? [errLine(err)] : []),
      el(
        "div",
        "p2-n-foot",
        b ? (b === "enhance" ? "Enhancing…" : `${LABEL[b]} is starting…`) : "draft · click for actions",
      ),
    ])
  }

  /** One clipped error line on the card; the full text is in the tooltip and the slide-over. */
  const errLine = (err: string) => {
    const e = el("div", "p2-err p2-n-err", err.split("\n")[0]!)
    e.title = err
    return e
  }

  const renderCard = (n: Node, card: HTMLElement) => {
    styleCard(n, card)
    if (n.kind === "draft") return renderDraftCard(n, card)
    const ctx = n.agent?.contextTokens && n.agent.contextLimit ? n.agent.contextTokens / n.agent.contextLimit : 0
    const bar = el("div", "p2-ctx")
    bar.append(el("span"))
    ;(bar.firstChild as HTMLElement).style.width = `${Math.round(ctx * 100)}%`
    const foot = el(
      "div",
      "p2-n-foot",
      n.agent
        ? `${n.status} · ${n.agent.harness ?? "copilot"} · ${n.agent.model.replace(/^claude-/, "")} · ${Math.round(ctx * 100)}% context`
        : "dormant · click to resume",
    )
    if (n.children.length) foot.append(el("span", "p2-kids", `${n.children.length} ▾`))
    const t = n.kind === "global" ? undefined : worktreeOf(n)
    const wt = el(
      "div",
      "p2-n-wt",
      t?.worktree
        ? worktreeLine(t)
        : n.kind === "global"
          ? "event inbox · read only"
          : n.id.startsWith("gen-")
            ? "own memory · no worktree"
            : "own workspace",
    )
    if (t?.worktree) wt.title = `Worktree ${t.worktree}\nBranch ${t.branch}${t.base ? `\nBased on ${t.base}` : ""}`
    patchChildren(card, [
      cardHead(n),
      el("div", "p2-n-name", n.name),
      wt,
      el("div", "p2-n-act", activityText(s!, n)),
      bar,
      foot,
    ])
  }

  const createCard = (id: string) => {
    const c = el("div")
    c.setAttribute("role", "button")
    c.tabIndex = 0
    c.onclick = (e) => (e.stopPropagation(), select(sel === id ? null : id))
    c.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), select(sel === id ? null : id))
    cards.set(id, c)
    world.append(c)
    return c
  }

  const renderEdges = () => {
    const seen = new Set<string>()
    for (const n of nodes.values()) {
      if (!n.parent) continue
      const p = nodes.get(n.parent)!
      seen.add(n.id)
      let e = edges.get(n.id)
      if (!e) {
        e = document.createElementNS("http://www.w3.org/2000/svg", "path")
        edges.set(n.id, e)
        svg.append(e)
      }
      const x1 = p.x + PAD + W / 2,
        y1 = p.y + PAD + H,
        x2 = n.x + PAD + W / 2,
        y2 = n.y + PAD,
        my = (y1 + y2) / 2
      e.setAttribute("d", `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`)
      e.setAttribute(
        "class",
        `${n.status === "running" ? "run" : ""} ${n.kind === "ghost" || n.kind === "draft" ? "ghost" : ""}`,
      )
    }
    for (const [id, e] of edges)
      if (!seen.has(id)) {
        e.remove()
        edges.delete(id)
      }
  }

  const renderGraph = () => {
    for (const [id, c] of cards)
      if (!nodes.has(id)) {
        c.remove()
        cards.delete(id)
      }
    for (const n of nodes.values()) renderCard(n, cards.get(n.id) ?? createCard(n.id))
    // Reading order (top row first, left to right) for keyboard and screen readers; reorder only when it changes.
    const order = [...nodes.values()].sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.id)
    if (order.join() !== orderKey) {
      orderKey = order.join()
      world.append(...order.map((id) => cards.get(id)!))
    }
    patchChildren(
      tiers,
      tierLabels(nodes.values()).map(([y, t]) => {
        const l = el("div", "p2-tier", t)
        l.style.top = `${y + PAD - 24}px`
        return l
      }),
    )
    renderEdges()
  }

  const renderStats = () => {
    const st = s!
    const runningCount = st.agents.filter((a) => a.status === "running").length
    const legend = el("span", "p2-legend")
    for (const [c, t] of [
      ["#22c55e", "idle"],
      ["#f59e0b", "running"],
      ["#ef4444", "error"],
      ["#525252", "dormant"],
    ]) {
      const d = el("i", "p2-dot")
      d.style.setProperty("--glow", c)
      legend.append(d, el("span", "", t))
    }
    patchChildren(stats, [
      legend,
      el("span", "", `${st.agents.length} agents`),
      el("span", runningCount ? "on" : "", `${runningCount} running`),
    ])
    const n = sel ? nodes.get(sel) : undefined
    where.textContent = n
      ? `Viewing ${n.kind === "global" ? "Factory" : n.name} · Esc goes back`
      : "Factory overview · click any card to open its chat"
    // Decisions waiting for a human: each one is a button that opens its card.
    const pend = st.decisions.filter((d) => d.status === "pending").sort((a, b) => a.createdAt - b.createdAt)
    decisions.classList.toggle("warn", pend.length > 0)
    const items: Element[] = [
      el(
        "b",
        "",
        pend.length ? `⚑ ${pend.length} decision${pend.length > 1 ? "s" : ""} waiting` : "Decisions: none waiting",
      ),
    ]
    for (const d of pend.slice(0, 3)) {
      const b = el("button", "", d.title)
      b.onclick = () => openDecision(d.id)
      items.push(b)
    }
    const last = pend.length ? undefined : [...st.decisions].sort((a, b) => b.createdAt - a.createdAt)[0]
    if (last) {
      const b = el("button", "p2-last", `Last answered: ${last.title}`)
      b.onclick = () => openDecision(last.id)
      items.push(b)
    }
    patchChildren(decisions, items)
  }

  const crumbs = (n: Node) => {
    const chain: Node[] = []
    for (let p: Node | undefined = n; p; p = p.parent ? nodes.get(p.parent) : undefined) chain.unshift(p)
    const c = el("div", "p2-crumbs")
    chain.forEach((p, i) => {
      if (i) c.append(el("span", "p2-sep", "›"))
      const b = el("button", p.id === n.id ? "cur" : "", p.kind === "global" ? "Factory" : p.name)
      b.onclick = () => select(p.id)
      c.append(b)
    })
    return c
  }

  const renderPanelHead = (n: Node) => {
    const st = s!
    const close = el("button", "p2-close", "✕")
    close.title = "Close (Esc)"
    close.onclick = () => select(null)
    const row1 = el("div", "p2-ph-row")
    const gear = el("button", "p2-gear", "⚙")
    gear.title = "Spec: skills, MCP servers, plugins, tools and worktree this agent runs with"
    gear.setAttribute("aria-label", "Show spec")
    gear.onclick = () => openSpec(streamId(n))
    if (n.agent) row1.append(crumbs(n), gear, close)
    else row1.append(crumbs(n), close)
    const row2 = el("div", "p2-ph-row")
    const dot = el("i", "p2-dot")
    dot.style.setProperty("--glow", n.kind === "ghost" ? "#525252" : statusColor(n.status))
    row2.append(
      dot,
      ...(n.agent ? [harnessBadge(n.agent.harness)] : []),
      el("span", "p2-ph-tag", n.tag),
      el("span", "p2-ph-act", activityText(st, n)),
    )
    for (const d of pendingOf(st, n)) {
      const b = el("button", "p2-badge warn", `⚑ ${d.title}`)
      b.onclick = () => openDecision(d.id)
      row2.append(b)
    }
    const rev = reviewOf(st, n)
    if (rev) row2.append(el("span", "p2-badge", `🛡 ${reviewText(rev)}`))
    // Drill down without leaving the panel: one button per direct report.
    const row3 = el("div", "p2-ph-row p2-kidrow")
    if (n.children.length) {
      row3.append(el("span", "p2-ph-tag", n.kind === "global" ? "Sub-coordinators" : "Workers"))
      for (const c of n.children) {
        const b = el("button", "p2-kid", c.name)
        const d = el("i", "p2-dot")
        d.style.setProperty("--glow", c.kind === "ghost" ? "#525252" : statusColor(c.status))
        b.prepend(d)
        b.onclick = () => select(c.id)
        row3.append(b)
      }
    } else row3.append(el("span", "p2-ph-tag", n.kind === "worker" ? "No sub-agents" : "No workers yet"))
    const t = n.kind === "global" ? undefined : worktreeOf(n)
    const row4 = el("div", "p2-ph-row p2-wtrow")
    if (t?.worktree) {
      row4.append(el("span", "p2-wt-repo", t.folderId), el("span", "p2-wt-branch", `⎇ ${t.branch ?? "?"}`))
      if (t.base) row4.append(el("span", "p2-wt-base", `from ${shortSha(t.base)}`))
      const p = el("button", "p2-wt-path", t.worktree)
      p.title = "Copy the worktree path"
      p.onclick = () =>
        void navigator.clipboard
          ?.writeText(t.worktree!)
          .then(() => ((p.textContent = "Copied ✓"), setTimeout(() => (p.textContent = t.worktree!), 1200)))
      row4.append(p)
    } else
      row4.append(
        el("span", "p2-ph-tag", n.kind === "global" ? "General · no worktree" : "Own workspace · no repo worktree"),
      )
    patchChildren(panelHead, [row1, row4, row2, row3])
  }

  /** A search hit to scroll to when this worker's panel transcript mounts. */
  let panelFocus: { id: string; seq: number } | null = null
  const workerBody = (id: string): (() => void) => {
    const scroll = el("div", "p2-transcript")
    if (nodes.get(id)?.status === "stopped") {
      panelBody.replaceChildren(scroll)
      return mountTranscript(scroll, id, { stopped: true })
    }
    const form = el("form", "p2-compose")
    const ta = el("textarea")
    ta.placeholder = "Message this worker directly… (Enter sends)"
    ta.rows = 2
    const sendButton = el("button", "", "Send")
    form.append(ta, sendButton)
    form.onsubmit = (e) => {
      e.preventDefault()
      const text = ta.value.trim()
      if (!text) return
      ta.value = ""
      void messageAgent(id, text).then(
        (error) => (ta.placeholder = error ? `Send failed: ${error}` : "Sent. Message again…"),
      )
    }
    ta.onkeydown = (e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), form.requestSubmit())
    panelBody.replaceChildren(scroll, form)
    const focus = panelFocus?.id === id ? panelFocus.seq : undefined
    panelFocus = null
    return mountTranscript(scroll, id, focus === undefined ? undefined : { focus })
  }

  const dockChat = () => {
    placeChat(overId ? null : DOCK_BOX)
    if (!new URL(window.location.href).searchParams.has("thread")) openAgentChat("general")
    panelBody.replaceChildren()
  }

  const renderDockHead = () => {
    // The docked chat is the open General chat; its own agent, else the desk.
    const open = new URL(window.location.href).searchParams.get("thread")
    // A General chat has no node until its session starts; then show idle, not the desk's status.
    const g = open ? nodes.get(`gen-${open.slice(0, 8)}`) : undefined
    const b = el("button", "p2-expand", "⤢ Expand")
    b.title = "Open as panel"
    b.onclick = () => select(g?.id ?? "coordinator")
    const fresh = el("button", "p2-newchat", "＋ New chat")
    fresh.title = "Start a new General chat (clean memory, sees the whole factory)"
    fresh.onclick = () => newThread("general")
    const dot = el("i", "p2-dot")
    dot.style.setProperty("--glow", statusColor(g?.status ?? "idle"))
    patchChildren(dockHead, [
      dot,
      el("b", "", "💬 Chat here"),
      el("span", "p2-ph-act", g && s ? activityText(s, g) : "new requests start here"),
      fresh,
      b,
    ])
  }

  const mountPanelBody = (n: Node | undefined): (() => void) => {
    if (!n) {
      dockChat()
    } else if (n.kind === "worker") {
      placeChat(null)
      return workerBody(n.id)
    } else {
      placeChat({ right: "0", top: "112px", bottom: "48px", width: "min(42%, 680px)" })
      if (n.kind === "ghost") openThread(n.thread!.id)
      else openAgentChat(n.id)
      panelBody.replaceChildren()
    }
    return () => {}
  }

  /** Place the native chat and the panel body for the current selection; mount only when the selection changes. */
  const syncPanel = () => {
    const n = sel ? nodes.get(sel) : undefined
    root.classList.toggle("open", !!n)
    const key = n ? n.id : "dock"
    if (n) renderPanelHead(n)
    else renderDockHead()
    if (mounted?.key === key) return
    if (key === "dock" && !s!.threads.length) return // wait for threads, or openAgentChat would start a new conversation
    mounted?.stop()
    mounted = { key, stop: mountPanelBody(n) }
  }

  // ---------- factory stream (left rail, shared with the Inbox) ----------

  const nodeOfAgent = (id: string) => nodes.get(id) ?? [...nodes.values()].find((n) => streamId(n) === id)
  const selectAgent = (id: string) => {
    const n = nodeOfAgent(id)
    if (n) select(n.id)
  }
  const STREAM_KIND = { global: "desk", worker: "worker", sub: "sub", ghost: "sub", draft: "sub" } as const
  const stream = mountStream(rail, {
    agent: (id) => {
      const n = nodeOfAgent(id)
      if (!n) return undefined
      return {
        name: n.kind === "global" ? "Factory desk" : n.name,
        kind: id.startsWith("gen-") ? "chat" : STREAM_KIND[n.kind],
        status: n.status,
      }
    },
    select: selectAgent,
    /** Agent ids of the selected node and everything under it; null = whole factory. */
    scope: () => {
      const n = sel ? nodes.get(sel) : undefined
      if (!n) return null
      const out = new Set<string>()
      const walk = (x: Node) => (out.add(streamId(x)), x.children.forEach(walk))
      walk(n)
      return out
    },
    subtitle: () => {
      const n = sel ? nodes.get(sel) : undefined
      if (!n) return "Every agent, newest at the bottom"
      return `${n.kind === "global" ? "Factory desk" : n.name}${n.children.length ? " and its agents" : ""}`
    },
    headBefore: () => {
      const toggle = el("button", "p2-rail-toggle", railOpen ? "⟨" : "⟩")
      toggle.title = railOpen ? "Collapse the stream" : "Show the factory stream"
      toggle.onclick = () => ((railOpen = !railOpen), renderStream(true), requestAnimationFrame(fit))
      return [toggle]
    },
    headAfter: () => {
      if (!sel || !nodes.get(sel)) return []
      const all = el("button", "p2-rail-all", "Show all")
      all.onclick = () => select(null)
      return [all]
    },
    open: () => railOpen,
    empty: () =>
      sel ? "Nothing from this agent yet." : "Nothing yet. Events from every agent appear here as they happen.",
    openHit: (h) => {
      const n = nodes.get(h.workerId)
      if (!n) return openHistory(h.workerId, h.seq, `${h.workerId} · stopped · saved history`)
      // A coordinator's panel is its chat, which cannot scroll to an event: show its transcript instead.
      if (n.kind !== "worker") return openHistory(h.workerId, h.seq, `${n.name} · live transcript`, false)
      stream.clearSearch()
      panelFocus = { id: h.workerId, seq: h.seq }
      // Already open: remount so the transcript scrolls to the match.
      if (sel === h.workerId) {
        mounted?.stop()
        mounted = null
      }
      select(h.workerId)
    },
  })
  const renderStream = (force = false) => {
    rail.classList.toggle("shut", !railOpen)
    if (s) stream.render(s, force)
  }

  const sync = (refit = false) => {
    if (!s) return
    if (sel && !nodes.has(sel)) sel = null
    renderGraph()
    renderRing()
    renderOver()
    renderStats()
    syncPanel()
    renderStream()
    if (refit) requestAnimationFrame(fit)
    else fit()
  }

  // A render between mousedown and mouseup can still replace the pressed element (its text changed): wait for the release.
  let pressed = false
  let owed = false
  const press = () => void (pressed = true)
  // Click fires after pointerup in the same task; the owed render runs after it.
  const release = () => ((pressed = false), owed && ((owed = false), setTimeout(() => alive && sync())))
  root.addEventListener("pointerdown", press, true)
  window.addEventListener("pointerup", release, true)
  window.addEventListener("pointercancel", release, true)
  const unsub = subscribe((st) => {
    s = st
    nodes = buildTree(st, sel)
    if (!mounted) {
      const threadId = new URL(window.location.href).searchParams.get("thread")
      const linked = [...nodes.values()].find((n) => n.thread?.id === threadId && n.kind !== "draft")
      if (linked) {
        sel = linked.id
        nodes = buildTree(st, sel)
      }
    }
    if (pressed) owed = true
    else sync()
  })
  const ro = new ResizeObserver(() => fit())
  ro.observe(canvas)
  canvas.addEventListener("click", () => sel && select(null))
  canvas.addEventListener("transitionend", () => fit())
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    // A report dialog takes Escape first.
    const dialog = !!document.querySelector(".sfs-backdrop")
    if (ring && !dialog) return void ((ring = null), sync())
    if (overId && !sel && !dialog) return void ((overId = null), sync())
    if (sel && !(e.target as HTMLElement)?.closest?.(".p2-compose")) select(null)
  }
  window.addEventListener("keydown", onKey, true)
  /** A press outside the ring and its node closes the ring. */
  const onDown = (e: PointerEvent) => {
    const t = e.target as Element
    if (ring && !ringEl.contains(t) && !cards.get(ring)?.contains(t)) {
      ring = null
      sync()
    }
  }
  document.addEventListener("pointerdown", onDown, true)

  return () => {
    alive = false
    unsub()
    ro.disconnect()
    window.removeEventListener("keydown", onKey, true)
    document.removeEventListener("pointerdown", onDown, true)
    root.removeEventListener("pointerdown", press, true)
    window.removeEventListener("pointerup", release, true)
    window.removeEventListener("pointercancel", release, true)
    mounted?.stop()
    stream.stop()
    root.classList.remove("sfp-p2", "open", "drafting")
    root.replaceChildren()
  }
}

register({
  id: 2,
  name: "Org Canvas",
  blurb: "Live org chart of every agent; click a node to open its chat in a slide-over",
  mount,
})
