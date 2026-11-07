// Prototype 3 — Inbox: pure model. No DOM, no HTTP.
// A "conversation" is a root of the tree: the Factory desk, a General chat, or a repo conversation no General chat started.
// Each conversation's tree: chat → sub-coordinators (repo conversations) → workers; drafts and direct workers hang off the chat.
import type { Agent, Decision, Thread } from "./core"

export type Kind = "desk" | "chat" | "sub" | "worker" | "draft"
export type Status = "running" | "idle" | "error" | "needs" | "dormant" | "draft" | "stopped"
export type Node = {
  id: string
  kind: Kind
  title: string
  /** Own status; `needs` when one of its decisions is open. */
  status: Status
  agent?: Agent
  thread?: Thread
  parent: string | null
  children: string[]
  /** Open decisions of this node. */
  pending: Decision[]
  /** Roll-up over the subtree (node included). */
  agg: { running: number; error: number; needs: number; desc: number }
}
export type Model = { nodes: Map<string, Node>; roots: string[] }

const short = (id: string) => id.slice(0, 8)
const isDraft = (t: Thread) => !!t.draft && !t.draft.startedAt
const draftPrompt = (t: Thread) => t.draft?.versions.find((v) => v.id === t.draft!.current)?.prompt ?? t.title
/** Agent id of a thread's coordinator. */
export const agentIdOf = (t: Thread): string => (t.desk ? "coordinator" : isDraft(t) ? `draft-${short(t.id)}` : `${t.worktree ? "sub" : "gen"}-${short(t.id)}`)

const agentStatus = (a: Agent | undefined): Status => (!a ? "dormant" : a.status === "running" ? "running" : a.status === "error" ? "error" : a.status === "stopped" ? "stopped" : "idle")

/** Build every conversation tree from the live agents, the saved threads and the open decisions. Archived threads are left out unless `archived`. */
export const build = (agents: readonly Agent[], threads: readonly Thread[], decisions: readonly Decision[], archived = false): Model => {
  const nodes = new Map<string, Node>()
  const byAgent = new Map(agents.map((a) => [a.id, a]))
  const pending = decisions.filter((d) => d.status === "pending")
  const add = (n: Omit<Node, "children" | "parent" | "pending" | "agg"> & { parent?: string | null }) => {
    nodes.set(n.id, { parent: null, ...n, children: [], pending: [], agg: { running: 0, error: 0, needs: 0, desc: 0 } })
  }
  const shown = threads.filter((t) => !!t.archivedAt === archived || t.desk)
  for (const t of shown) {
    const id = agentIdOf(t)
    const a = byAgent.get(id)
    const kind: Kind = t.desk ? "desk" : isDraft(t) ? "draft" : t.worktree ? "sub" : "chat"
    add({ id, kind, title: t.desk ? "Factory desk" : isDraft(t) ? draftPrompt(t) : t.title, status: kind === "draft" ? "draft" : agentStatus(a), agent: a, thread: t })
  }
  // Workers (and helper agents) that are not a conversation of their own.
  for (const a of agents) if (!nodes.has(a.id) && a.role !== "coordinator") add({ id: a.id, kind: "worker", title: a.name, status: agentStatus(a), agent: a })
  // Parent: a thread's parentThreadId, else the agent's owner. The desk owns nothing it did not start itself.
  for (const n of nodes.values()) {
    if (n.kind === "desk") continue
    const pt = n.thread?.parentThreadId ? threads.find((t) => t.id === n.thread!.parentThreadId) : undefined
    let owner = pt ? agentIdOf(pt) : n.kind === "worker" ? n.agent?.owner ?? "coordinator" : null
    // A live worker whose owner is gone (archived chat, stopped run) still shows, under the desk.
    // A stopped one belongs to its conversation's record only: it shows when that conversation does.
    if (n.kind === "worker" && (!owner || !nodes.has(owner))) {
      if (n.status === "stopped") continue
      owner = "coordinator"
    }
    if (owner && owner !== n.id && nodes.has(owner)) {
      n.parent = owner
      nodes.get(owner)!.children.push(n.id)
    }
  }
  for (const n of [...nodes.values()]) if (n.kind === "worker" && n.status === "stopped" && !n.parent) nodes.delete(n.id)
  for (const d of pending) {
    const t = d.threadId ? threads.find((x) => x.id === d.threadId) : threads.find((x) => x.desk)
    const n = t ? nodes.get(agentIdOf(t)) : undefined
    if (n) (n.pending.push(d), (n.status = "needs"))
  }
  const roll = (n: Node): Node["agg"] => {
    const agg = { running: +(n.status === "running"), error: +(n.status === "error"), needs: n.pending.length, desc: 0 }
    for (const c of n.children) {
      const k = roll(nodes.get(c)!)
      agg.running += k.running; agg.error += k.error; agg.needs += k.needs; agg.desc += k.desc + 1
    }
    // Sub-coordinators before workers, then in spawn order (oldest first).
    n.children.sort((x, y) => rank(nodes.get(x)!) - rank(nodes.get(y)!) || bornAt(nodes.get(x)!) - bornAt(nodes.get(y)!))
    return (n.agg = agg)
  }
  const roots = [...nodes.values()].filter((n) => !n.parent).map((n) => n.id)
  roots.forEach((r) => roll(nodes.get(r)!))
  return { nodes, roots }
}
const ORDER: Record<Kind, number> = { desk: 0, chat: 1, sub: 2, draft: 3, worker: 4 }
const rank = (n: Node) => ORDER[n.kind]
/** When a node was spawned: its agent's start, else its thread's creation; 0 when unknown. */
export const bornAt = (n: Node): number => n.agent?.startedAt ?? n.thread?.createdAt ?? 0

export const rootOf = (m: Model, id: string): string => {
  let n = m.nodes.get(id)
  while (n?.parent) n = m.nodes.get(n.parent)
  return n?.id ?? id
}
export const ancestors = (m: Model, id: string): Node[] => {
  const out: Node[] = []
  for (let n = m.nodes.get(m.nodes.get(id)?.parent ?? ""); n; n = n.parent ? m.nodes.get(n.parent) : undefined) out.unshift(n)
  return out
}
/** The coordinator a worker reports to (its parent, if that is a chat, sub-coordinator or the desk). */
export const bossOf = (m: Model, id: string): Node | undefined => {
  const p = m.nodes.get(m.nodes.get(id)?.parent ?? "")
  return p && p.kind !== "worker" && p.kind !== "draft" ? p : undefined
}

// ---------- inbox views ----------

export type View = "needs" | "failed" | "running" | "chats" | "archived" | `repo:${string}`
export const VIEWS: { id: View; label: string }[] = [
  { id: "needs", label: "Needs me" },
  { id: "failed", label: "Failed" },
  { id: "running", label: "Running" },
  { id: "chats", label: "All conversations" },
]
/** Every node of a subtree, depth-first (root first). */
export const subtree = (m: Model, id: string): Node[] => {
  const n = m.nodes.get(id)
  return n ? [n, ...n.children.flatMap((c) => subtree(m, c))] : []
}
/** One inbox row = one conversation tree. `focus` is the node the row is about (selected on click). */
export type Row = { root: Node; focus: Node; reason: string; tone: Node["status"] }
const newest = (m: Model, r: Node) => Math.max(0, ...subtree(m, r.id).map((n) => n.thread?.createdAt ?? 0))
/** Header text for how an agent's model was picked, with a tooltip that explains it. Null when the server did not say. */
export const modelReason = (a: Agent): { text: string; title: string } | null => {
  const s = a.modelSource
  if (!s) return null
  switch (s.kind) {
    case "routed":
      return { text: `${s.by} ${Math.round(s.confidence * 100)}%`, title: s.by === "ui-rule" ? "Jev saw UI work; the UI rule forced the latest Opus" : s.by === "jev" ? "Jev picked this model for the task" : "Jev's top pick is not usable with this auth; next usable model in Jev's ranking" }
    case "pinned":
      return { text: "set by spawner", title: "The coordinator or the factory named this model; Jev was not asked" }
    case "fallback":
      return { text: "default · Jev unavailable", title: "Jev routing failed or gave no usable model; SF_MODEL was used" }
    case "default":
      return { text: "default", title: "Not routed (coordinator, or no task); settings or SF_MODEL" }
  }
}
const name = (n: Node) => (n.kind === "worker" ? n.agent?.name ?? n.title : n.title)

/** Why the conversation is in the inbox. The view's own reason leads (Failed shows the failure); else open questions, failures, running work. */
export const row = (m: Model, r: Node, v?: View): Row => {
  const all = subtree(m, r.id), a = r.agg
  const asks = all.filter((n) => n.pending.length), fails = all.filter((n) => n.status === "error"), runs = all.filter((n) => n.status === "running")
  const needs = (): Row => ({ root: r, focus: asks[0]!, tone: "needs", reason: a.needs === 1 ? `▲ ${asks[0]!.id === r.id ? "" : `${name(asks[0]!)} asks: `}${asks[0]!.pending[0]!.title}` : `▲ ${a.needs} need you` })
  const failed = (): Row => ({ root: r, focus: fails[0]!, tone: "error", reason: a.error === 1 ? `✗ ${fails[0]!.id === r.id ? "failed" : `${name(fails[0]!)} failed`}` : `✗ ${a.error} failed` })
  const running = (): Row => ({ root: r, focus: runs.length === 1 ? runs[0]! : r, tone: "running", reason: `${a.running} running${a.desc ? ` · ${a.desc} below` : ""}` })
  if (v === "failed" && a.error) return failed()
  if (v === "running" && a.running) return running()
  if (a.needs) return needs()
  if (a.error) return failed()
  if (a.running) return running()
  return { root: r, focus: r, tone: r.status, reason: `${r.status === "draft" ? "Draft" : r.status === "dormant" ? "Dormant" : "Idle"}${a.desc ? ` · ${a.desc} below` : ""}` }
}

/** Inbox rows of a view: one per conversation, open questions first, then newest. The desk is a row only when it has something for you. */
export const items = (m: Model, v: View): Row[] => {
  const roots = m.roots.map((r) => m.nodes.get(r)!)
  const pick =
    v === "needs" ? roots.filter((r) => r.agg.needs)
    : v === "failed" ? roots.filter((r) => r.agg.error)
    : v === "running" ? roots.filter((r) => r.agg.running)
    : v === "chats" || v === "archived" ? roots.filter((r) => r.kind !== "desk")
    : roots.filter((r) => r.kind !== "desk" && subtree(m, r.id).some((n) => n.thread?.folderId === v.slice(5)))
  return pick.sort((a, b) => b.agg.needs - a.agg.needs || newest(m, b) - newest(m, a)).map((r) => row(m, r, v))
}
export const count = (m: Model, v: View) => items(m, v).length
