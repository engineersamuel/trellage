// Tools of a tournament sub-coordinator: it runs the tournament with these, one job at a time (tournamentRun.ts).
// Each tool's name, parameters and description are a contract with code, so they live here (coordinator/AGENTS.md).
import { defineTool, type Tool } from "@github/copilot-sdk"
import { leaderboard, type Row, type Tournament } from "./tournament.ts"
import { presetOf } from "./tournamentPresets.ts"
import type { Tournaments } from "./tournamentRun.ts"

type Args = Record<string, unknown>
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required })
const json = (v: unknown) => JSON.stringify(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])
const pairs = (v: unknown): [string, string][] =>
  Array.isArray(v) ? v.flatMap((p) => (Array.isArray(p) && p.length === 2 ? [[String(p[0]), String(p[1])]] : [])) : []
const pairSchema = {
  type: "array",
  items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
  description: 'Pairs of variant ids, e.g. [["a", "b"]].',
}

const pct = (n: number) => `${Math.round(n * 100)}%`

/** A build's asset (its page, live) and first screenshot, through the coordinator. */
export const assetUrl = (tournament: string, variant: string, build: number, file: string) =>
  `/api/tournaments/${encodeURIComponent(tournament)}/builds/${encodeURIComponent(variant)}/${build}/${file}`
export const thumbUrl = (file: string) => `/api/files/image?path=${encodeURIComponent(file)}`

/** The leaderboard as a Markdown table, best first. */
export const leaderboardTable = (rows: Row[]): string =>
  [
    "| # | Variant | Rating | Beats baseline | W-L-T | Builds |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r, i) =>
        `| ${i + 1} | ${r.label} | ${r.games ? r.rating : "-"} | ${r.kind === "baseline" || !r.games ? "-" : pct(r.vsBaseline)} | ${r.wins}-${r.losses}-${r.ties} | ${r.builds.map((b) => (b.status === "ok" ? "✓" : b.status === "pending" || b.status === "building" ? "·" : "✗")).join("")} |`,
    ),
  ].join("\n")

/** What the sub-coordinator reads: state, the running job, open work, failures, the leaderboard. */
export const statusView = (t: Tournament) => {
  const rows = leaderboard(t)
  const cards = Object.values(t.cards)
  const builds = Object.values(t.variants).flatMap((v) => v.builds.map((b) => ({ v: v.id, ...b })))
  return {
    id: t.id,
    preset: t.preset,
    status: t.status,
    reason: t.reason,
    spentUsd: Math.round(t.spentUsd * 100) / 100,
    limitUsd: t.limitUsd,
    job: t.jobs.at(-1) ?? null,
    sources: Object.fromEntries(
      ["pending", "ok", "excluded", "skipped", "failed"].map((s) => [s, cards.filter((c) => c.status === s).length]),
    ),
    failedSources: cards.filter((c) => c.status === "failed").map((c) => ({ source: c.source, reason: c.reason })),
    builds: Object.fromEntries(
      ["pending", "ok", "dropped", "failed"].map((s) => [s, builds.filter((b) => b.status === s).length]),
    ),
    failedBuilds: builds
      .filter((b) => b.status === "failed" || b.status === "dropped")
      .map((b) => ({ variant: b.v, build: b.n, status: b.status, error: b.error })),
    rounds: t.rounds.map((r) => ({ n: r.n, pairs: r.pairs.length, done: r.done })),
    generations: t.generations.map((g) => ({ n: g.n, combos: g.combos, leaderBefore: g.leaderBefore })),
    leaderboard: leaderboardTable(rows),
    variants: rows.map((r) => ({ id: r.id, label: r.label, kind: r.kind, rating: r.rating, games: r.games })),
  }
}

export const tournamentTools = (ts: Tournaments, id: string): Tool<Args>[] => {
  const preset = presetOf(ts.get(id).preset)
  const started = (r: unknown) => json(r)
  return [
    defineTool("tournament_status", {
      description:
        "The tournament now: status, spend, the last job, sources and builds by status with failure reasons, rounds, and the leaderboard (a Markdown table to show the human).",
      parameters: obj({}),
      handler: () => json(statusView(ts.get(id))),
    }),
    ...(preset.variants === "sources"
      ? [
          defineTool("tournament_scout", {
            description:
              "Start a job: read sources and turn each usable one into a variant. Paid sources are excluded by code. Default: every pending source. retry=true scouts failed ones again.",
            parameters: obj({
              sources: { type: "array", items: { type: "string" }, description: "Source URLs; omit for all." },
              retry: { type: "boolean" },
            }),
            handler: (a: Args) => started(ts.scout(id, strings(a.sources), a.retry === true)),
          }),
        ]
      : [
          defineTool("tournament_add_variants", {
            description:
              "Add approaches to the idea as variants (no job). Each: a short id (letters, digits, dashes), a label, and the approach: 3-8 sentences of direction the builder follows.",
            parameters: obj(
              {
                variants: {
                  type: "array",
                  items: obj({ id: { type: "string" }, label: { type: "string" }, approach: { type: "string" } }, [
                    "id",
                    "label",
                    "approach",
                  ]),
                },
              },
              ["variants"],
            ),
            handler: (a: Args) =>
              json(
                ts.addVariants(
                  id,
                  (Array.isArray(a.variants) ? a.variants : []).map((v: Record<string, unknown>) => ({
                    id: String(v.id ?? ""),
                    label: String(v.label ?? v.id ?? ""),
                    approach: String(v.approach ?? ""),
                  })),
                ),
              ),
          }),
        ]),
    defineTool("tournament_build", {
      description:
        "Start a job: build every pending build of these variants (default: all), then screenshot and check them. Only a blank or broken page drops a build; other checks are notes. retry=true builds failed and dropped ones again.",
      parameters: obj({
        variants: { type: "array", items: { type: "string" }, description: "Variant ids; omit for all." },
        retry: { type: "boolean" },
      }),
      handler: (a: Args) => started(ts.build(id, strings(a.variants), a.retry === true)),
    }),
    defineTool("tournament_round", {
      description:
        "Start a job: play one round, every build of each side (build 1 vs 1, 2 vs 2, ...). baseline=true: every variant against the baseline. Without pairs: Swiss pairs (nearest rating, nobody meets twice; an odd one out sits out once). With pairs: exactly those, e.g. a combo against the leader. An unfinished round is finished first.",
      parameters: obj({
        pairs: pairSchema,
        baseline: { type: "boolean", description: "Every variant meets the baseline once (do this first)." },
      }),
      handler: (a: Args) => {
        const p = pairs(a.pairs)
        return started(ts.round(id, a.baseline === true ? "baseline" : p.length ? p : undefined))
      },
    }),
    defineTool("tournament_combine", {
      description:
        "Without pairs: the combination candidates (top variants that beat the baseline) with Jev's fit probability and the threshold. With pairs: add those combinations as new variants of the next generation (then build them).",
      parameters: obj({ pairs: pairSchema }),
      handler: async (a: Args) => {
        const p = pairs(a.pairs)
        return json(await ts.combine(id, p.length ? p : undefined))
      },
    }),
    defineTool("tournament_finish", {
      description:
        "End the tournament with your conclusion: the winner, the aspects it won, how sure the result is, and what failed or was excluded.",
      parameters: obj({ summary: { type: "string" } }, ["summary"]),
      handler: (a: Args) => json(ts.finish(id, String(a.summary ?? ""))),
    }),
  ] as Tool<Args>[]
}
