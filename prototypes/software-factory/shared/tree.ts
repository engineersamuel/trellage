// Worker tree shared by both UIs: global coordinator → sub-coordinators → their workers.
// `owner` is the coordinator that started an agent; a missing or unknown owner means the global coordinator.

type Node = { id: string; role: string; owner?: string | null }

/** Depth-first order with depth: each agent follows the coordinator that owns it. */
export const workerTree = <W extends Node>(workers: readonly W[]): { w: W; depth: number }[] => {
  const ids = new Set(workers.map((w) => w.id))
  const parent = (w: W) =>
    w.id === "coordinator"
      ? null
      : w.owner && ids.has(w.owner) && w.owner !== w.id
        ? w.owner
        : ids.has("coordinator")
          ? "coordinator"
          : null
  const out: { w: W; depth: number }[] = []
  const seen = new Set<string>()
  const visit = (w: W, depth: number) => {
    if (seen.has(w.id)) return
    seen.add(w.id)
    out.push({ w, depth })
    // Sub-coordinators first, then plain workers.
    const kids = workers
      .filter((k) => parent(k) === w.id)
      .sort((a, b) => (a.role === b.role ? 0 : a.role === "coordinator" ? -1 : 1))
    for (const k of kids) visit(k, depth + 1)
  }
  for (const w of workers) if (parent(w) === null) visit(w, 0)
  for (const w of workers) visit(w, 0) // cycles, if any, still show
  return out
}

/** Role tag and display name. A sub-coordinator's name is "<folder> · <conversation title>". */
export const agentLabel = (w: {
  id: string
  role: string
  name: string
}): { tag: string; kind: "global" | "sub" | "worker"; name: string } => {
  if (w.id === "coordinator") return { tag: "🌐 Chief of Staff", kind: "global", name: "Chief of Staff" }
  if (w.id.startsWith("gen-")) return { tag: "💬 General chat", kind: "sub", name: w.name.replace(/^General · /, "") }
  if (w.role === "coordinator") {
    const [folder, ...rest] = w.name.split(" · ")
    return { tag: `⎇ Sub-coordinator · ${folder}`, kind: "sub", name: rest.join(" · ") || w.name }
  }
  return { tag: "Worker", kind: "worker", name: w.name }
}
