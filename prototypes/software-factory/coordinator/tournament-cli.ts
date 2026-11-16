// sf tournament: tournaments (src/tournamentRun.ts), each run by its own sub-coordinator conversation.
//   sf tournament new [--limit USD] FILE|-     UI skills: sources, one per line (URLs; # comments)
//   sf tournament idea [--limit USD] "IDEA"   prototypes: approaches to an idea, built and judged
//   sf tournament list
//   sf tournament show ID                      status, sources and the leaderboard
//   sf tournament resume ID [--limit USD]      go on after a stop (a higher limit when it was spent)
//   sf tournament stop ID
import { Console, Effect } from "effect"
import { readFileSync } from "node:fs"
import type { Row, SourceCard, Tournament } from "./src/tournament.ts"

type Json = <A = unknown>(path: string, init?: RequestInit) => Effect.Effect<A, Error>
type View = Tournament & { running: boolean; leaderboard: Row[] }
type Summary = {
  id: string
  status: string
  reason: string | null
  variants: number
  spentUsd: number
  limitUsd: number
  leader: string | null
}

const usd = (n: number) => `$${n.toFixed(2)}`
const base = process.env.SF_UI_URL ?? "http://localhost:5174"
const started = (t: View) =>
  `${t.id}: ${t.title}, limit ${usd(t.limitUsd)}\n  conversation: ${base}/?thread=${t.threadId ?? ""}`
const pct = (n: number) => `${Math.round(n * 100)}%`
const mark = (s: string) => (s === "ok" ? "✓" : s === "pending" || s === "building" ? "·" : "✗")

/** The leaderboard and source status as text. */
export const tournamentText = (t: View): string => {
  const head = `${t.id}  ${t.title}  ${t.status}${t.running ? " (running)" : ""}  ${usd(t.spentUsd)} of ${usd(t.limitUsd)}${t.reason ? `\n  ${t.reason}` : ""}`
  const rows = t.leaderboard.map(
    (r, i) =>
      `${String(i + 1).padStart(2)}. ${(r.games ? String(r.rating) : "-").padStart(5)}  vs base ${r.kind === "baseline" || !r.games ? "   -" : pct(r.vsBaseline).padStart(4)}  ${r.wins}-${r.losses}-${r.ties}  [${r.builds.map((b) => mark(b.status)).join("")}]  ${r.label}`,
  )
  const cards = Object.values(t.cards as Record<string, SourceCard>).map(
    (c) =>
      `  ${c.status.padEnd(8)} ${c.source}${c.status !== "ok" && c.reason ? `\n          ${c.reason.slice(0, 200)}` : ""}`,
  )
  return [head, "", "Leaderboard (rating, P(beat baseline), W-L-T, builds):", ...rows, "", "Sources:", ...cards].join(
    "\n",
  )
}

/** `--limit N` out of the args. */
const limitFlag = (args: string[]) => {
  const i = args.indexOf("--limit")
  return i < 0
    ? { limit: undefined, rest: args }
    : { limit: Number(args[i + 1]), rest: [...args.slice(0, i), ...args.slice(i + 2)] }
}

/** Sources from a list file: one per line; `#` comments and Markdown bullets are dropped. */
export const parseSources = (text: string): string[] =>
  text
    .split("\n")
    .map((l) =>
      l
        .replace(/\s#.*$|^#.*$/, "")
        .replace(/^[\s*-]+/, "")
        .trim(),
    )
    .filter(Boolean)

export const tournamentCommand = (json: Json, args: string[]) => {
  const [sub, ...rest] = args
  const show = (id: string) =>
    json<View>(`/api/tournaments/${encodeURIComponent(id)}`).pipe(Effect.flatMap((t) => Console.log(tournamentText(t))))
  switch (sub) {
    case "new": {
      const { limit, rest: files } = limitFlag(rest)
      const sources = parseSources(readFileSync(files[0] && files[0] !== "-" ? files[0] : 0, "utf8"))
      return json<View>("/api/tournaments", {
        method: "POST",
        body: JSON.stringify({ sources, ...(limit ? { limitUsd: limit } : {}) }),
      }).pipe(Effect.flatMap((t) => Console.log(started(t))))
    }
    case "idea": {
      const { limit, rest: words } = limitFlag(rest)
      return json<View>("/api/tournaments", {
        method: "POST",
        body: JSON.stringify({ preset: "prototypes", idea: words.join(" "), ...(limit ? { limitUsd: limit } : {}) }),
      }).pipe(Effect.flatMap((t) => Console.log(started(t))))
    }
    case undefined:
    case "list":
      return json<Summary[]>("/api/tournaments").pipe(
        Effect.flatMap((all) =>
          Console.log(
            all.length
              ? all
                  .map(
                    (t) =>
                      `${t.id}  ${t.status.padEnd(8)} ${usd(t.spentUsd)}/${usd(t.limitUsd)}  ${t.variants} variants  leader: ${t.leader ?? "-"}`,
                  )
                  .join("\n")
              : "no tournaments",
          ),
        ),
      )
    case "show":
      return show(rest[0] ?? "")
    case "resume": {
      const { limit, rest: ids } = limitFlag(rest)
      return json(`/api/tournaments/${encodeURIComponent(ids[0] ?? "")}/resume`, {
        method: "POST",
        body: JSON.stringify(limit ? { limitUsd: limit } : {}),
      }).pipe(Effect.flatMap(() => show(ids[0] ?? "")))
    }
    case "stop":
      return json(`/api/tournaments/${encodeURIComponent(rest[0] ?? "")}/stop`, { method: "POST", body: "{}" }).pipe(
        Effect.flatMap(() => show(rest[0] ?? "")),
      )
    default:
      return Effect.fail(
        new Error(
          'usage: sf tournament [list|new [--limit USD] FILE|idea [--limit USD] "IDEA"|show ID|resume ID [--limit USD]|stop ID]',
        ),
      )
  }
}
