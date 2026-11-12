// Resume after a coordinator restart. A shutdown records which agents were running; the next start sends each
// repo conversation that had running work one handoff turn built from factory state (not from the lost turn), so
// its sub-coordinator continues the delivery loop instead of stopping silently.
import { execFileSync } from "node:child_process"
import { loadPrompt } from "./prompt.ts"
import type { Sdlc } from "./sdlc.ts"

/** One agent that was running when the coordinator stopped. */
export type Interrupted = { id: string; name: string; owner: string | null; step: string | null; task: string | null }
/** `factory.shutdown`: published before the coordinator stops its agents. */
export type Shutdown = { at: number; running: Interrupted[] }
/** `factory.resumed`: published once the shutdown at `shutdownAt` was handled, so a second start does not repeat it. */
export type Resumed = { shutdownAt: number; scopes: string[] }

const isSub = (id: string | null): id is string => !!id && id.startsWith("sub-")

/**
 * Sub-coordinator ids with interrupted work in the latest shutdown, and the workers each lost. Empty when there was
 * no shutdown record (first start, or a crash) or that shutdown was already resumed.
 */
export const interruptedScopes = (shutdown: Shutdown | undefined, resumed: Resumed | undefined) => {
  const out = new Map<string, Interrupted[]>()
  if (!shutdown || resumed?.shutdownAt === shutdown.at) return out
  for (const a of shutdown.running) {
    const scope = isSub(a.id) ? a.id : isSub(a.owner) ? a.owner : null
    if (!scope) continue
    out.set(scope, [...(out.get(scope) ?? []), ...(scope === a.id ? [] : [a])])
  }
  return out
}

const git = (workdir: string, args: string[]): string => {
  try {
    return execFileSync("git", ["-C", workdir, ...args], { encoding: "utf8", maxBuffer: 1 << 20 }).trim()
  } catch (e) {
    return `(git ${args[0]} failed: ${e instanceof Error ? e.message.split("\n")[0] : e})`
  }
}

const firstLines = (text: string, n: number) => {
  const lines = text.split("\n").filter(Boolean)
  return lines.length > n ? [...lines.slice(0, n), `… ${lines.length - n} more`].join("\n") : lines.join("\n")
}

/** The handoff turn for one interrupted conversation: what stopped, and the branch and SDLC state now. */
export const resumePrompt = (p: {
  at: number
  /** Why the work stopped; default: a coordinator restart at `at`. */
  event?: { tag: string; text: string }
  lost: Interrupted[]
  workdir: string
  base: string | undefined
  sdlc: Sdlc | undefined
}): string => {
  const lost = p.lost.length
    ? p.lost
        .map((w) => `- ${w.name} (step ${w.step ?? "none"}): ${(w.task ?? "").replace(/\s+/g, " ").slice(0, 300)}`)
        .join("\n")
    : "- none (only your own turn was cut off)"
  const s = p.sdlc
  const k = s?.contractState
  const contract =
    k?.status === "failed" && (k.error === "coordinator restarted" || k.error === "paused at cost limit")
      ? ["- contract: stopped before it finished; call sdlc_plan again with the same criteria to run it again"]
      : []
  const gates =
    s?.gates.length || contract.length
      ? [
          ...(s?.gates ?? [])
            .filter((g) => g.chosen)
            .map((g) => `- ${g.id}: ${g.status}${g.detail ? ` (${g.detail})` : ""}`),
          ...contract,
        ].join("\n")
      : "- none chosen yet"
  return loadPrompt("resume", {
    tag: p.event?.tag ?? "factory restarted",
    event: p.event?.text ?? `The factory coordinator restarted at ${new Date(p.at).toISOString().slice(11, 16)} UTC.`,
    lost,
    commits: (p.base && firstLines(git(p.workdir, ["log", "--oneline", `${p.base}..HEAD`]), 20)) || "(none)",
    uncommitted: firstLines(git(p.workdir, ["status", "--short"]), 30) || "(clean)",
    criteria: s?.criteria.length
      ? s.criteria.map((c, i) => `- AC-${i + 1}: ${c}`).join("\n")
      : "- none (sdlc_plan not called)",
    gates,
  })
}
