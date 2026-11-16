// Tournaments: the state, the ratings and the pairing. Pure functions; tournamentRun.ts runs the jobs and a
// tournament sub-coordinator decides which job runs next (tournamentTools.ts). A preset (tournamentPresets.ts) says
// what the variants are: UI skill sources, or approaches to an idea.
//
// A variant is one way to build the same brief: the baseline (no skill), one source (a skill repo or page, read by a
// scout), or a combination of two variants. Each variant is built `runs` times. A game compares one build of A with
// one build of B; every judge sees both orders, and its vote counts only when both orders agree (else a tie).
// Ratings are Bradley-Terry strengths from all games, shown on the Elo scale with the baseline at 1000.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * The aspects an expert designer grades a storefront on, 1-10 each (prompts/tournament/ui-skills/judge.md). Each
 * preset has its own list; code parses those keys from the judge's JSON, and a game is decided aspect by aspect.
 */
export const CRITERIA = [
  "typography",
  "color",
  "layout",
  "hierarchy",
  "spacing",
  "consistency",
  "imagery",
  "accessibility",
  "responsiveness",
  "commerce_clarity",
  "distinctiveness",
] as const
export type Rubric = Partial<Record<string, number>>

export type Shot = { page: string; viewport: "desktop" | "mobile"; file: string }

export type Build = {
  n: number
  status: "pending" | "building" | "ok" | "dropped" | "failed"
  workerId?: string
  error?: string
  shots: Shot[]
  /** Jev pass probability per check (tournament/checks/<id>.md). */
  checks?: Record<string, number>
  /** Objective audit (scripts/buildAudit.cjs): axe WCAG AA, JS errors, overflow at 320 px, hover/press/focus feedback. */
  audit?: BuildAudit
}

export type BuildAudit = {
  pages: Record<
    string,
    {
      axe: { critical: number; serious: number; moderate: number; minor: number; rules: string[] }
      errors: number
      overflow320: number
      interactive: { n: number; hover: number; press: number; focus: number }
    }
  >
}

/** One line per page a judge reads: the measured facts the screenshots cannot show. */
export const auditSummary = (a: BuildAudit | undefined): string =>
  !a
    ? "not measured"
    : Object.entries(a.pages)
        .map(
          ([page, x]) =>
            `${page}: ${x.axe.critical + x.axe.serious} serious accessibility (WCAG AA) violations${x.axe.rules.length ? ` (${x.axe.rules.join(", ")})` : ""}; ${x.errors} JS errors; ${x.overflow320 ? `${x.overflow320} px too wide at 320 px` : "fits a 320 px phone"}; of ${x.interactive.n} controls ${x.interactive.hover} change on hover, ${x.interactive.press} on press, ${x.interactive.focus} show keyboard focus`,
        )
        .join("\n")

export type Variant = {
  id: string
  label: string
  kind: "baseline" | "source" | "approach" | "combo"
  /** Combos: the two variants it joins. */
  parents?: [string, string]
  sources: string[]
  /** Skill folders the builder loads (a SKILL.md in each). */
  skills: { name: string; dir: string }[]
  plugins: string[]
  /** Text added to the brief: how to use the skills. */
  instructions: string
  generation: number
  builds: Build[]
}

export type SourceCard = {
  source: string
  /** excluded: it needs a paid token, licence, subscription or paywall; nothing more is spent on it. */
  status: "pending" | "ok" | "skipped" | "excluded" | "failed"
  reason?: string
  workerId?: string
  variantId?: string
}

/** One judge on one game: its aspect scores in each order (mapped back to A/B) and its reasons. */
export type Vote = {
  judge: string
  scores: { A: Rubric; B: Rubric }[]
  reasons: string[]
  error?: string
}

export type Game = {
  id: string
  round: number
  a: { variant: string; build: number }
  b: { variant: string; build: number }
  votes: Vote[]
  /** A's score: mean over judges of 1 (both orders pick A), 0 (both B) or 0.5. */
  score: number | null
}

export type Round = {
  n: number
  generation: number
  kind: "swiss" | "challenge"
  pairs: [string, string][]
  done: boolean
}

export type Generation = {
  n: number
  /** Jev's probability per proposed combination "a+b". */
  proposals: Record<string, number>
  combos: string[]
  leaderBefore: string | null
  ratingBefore: number | null
}

/** running: the sub-coordinator works on it; paused: at the cost limit, the human decides. */
export type Status = "running" | "paused" | "stopped" | "done"

/** One unit of work the sub-coordinator started (scout, build, round). One job runs at a time. */
export type Job = {
  id: string
  kind: "scout" | "build" | "round"
  /** What it works on: sources, variant ids, or "a vs b" pairs. */
  items: string[]
  status: "running" | "done" | "halted" | "failed" | "interrupted"
  startedAt: number
  endedAt?: number
  summary?: string
}

export type Tournament = {
  id: string
  /** tournamentPresets.ts: what the variants are and how they are built and judged. */
  preset: string
  title: string
  createdAt: number
  /** What every builder builds: the storefront brief, or the human's idea. */
  brief: string
  sources: string[]
  status: Status
  /** The conversation of its sub-coordinator. */
  threadId?: string
  jobs: Job[]
  /** The open cost-limit decision. */
  approvalId?: string
  /** Why the tournament is paused, stopped, failed or done. */
  reason: string | null
  limitUsd: number
  spentUsd: number
  cards: Record<string, SourceCard>
  variants: Record<string, Variant>
  rounds: Round[]
  games: Game[]
  generations: Generation[]
  log: { at: number; text: string }[]
}

export const BASELINE = "baseline"

/** A short, stable id for a source: "github.com/pbakaus/impeccable" -> "pbakaus-impeccable". */
export const sourceId = (source: string): string => {
  const u = source.trim().replace(/\/+$/, "")
  const gh = u.match(/github\.com\/([^/]+)\/([^/#?]+)/)
  const raw = gh ? `${gh[1]}-${gh[2]!.replace(/\.git$/, "")}` : u.replace(/^https?:\/\/(www\.)?/, "")
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 64)
    .replace(/^-|-$/g, "")
}

export const comboId = (a: string, b: string): string => [a, b].sort().join("+")

/** Sources once each, by id, in the order given. */
export const uniqueSources = (sources: string[]): string[] => {
  const seen = new Set<string>()
  return sources.map((s) => s.trim()).filter((s) => s && !seen.has(sourceId(s)) && seen.add(sourceId(s)))
}

/** Builds a judge may see. */
export const usableBuilds = (v: Variant): Build[] => v.builds.filter((b) => b.status === "ok")

/** A variant is in the field once all its builds settled and at least one is usable. */
export const inField = (v: Variant): boolean =>
  v.builds.every((b) => b.status !== "pending" && b.status !== "building") && usableBuilds(v).length > 0

/**
 * A judge's vote on one game, decided aspect by aspect: each aspect goes to the side with the higher mean score over
 * both orders (so a position bias cancels), a tie is half. The vote is A's share of the aspects, each aspect equal.
 * Only aspects scored for both sides in both orders count; null when the judge failed or scored none.
 */
export const voteValue = (v: Vote): number | null => {
  if (v.error || v.scores.length < 2) return null
  const aspects = [...new Set(v.scores.flatMap((s) => [...Object.keys(s.A), ...Object.keys(s.B)]))]
  const won = aspects.flatMap((k) => {
    const a = v.scores.map((s) => s.A[k])
    const b = v.scores.map((s) => s.B[k])
    if ([...a, ...b].some((n) => n === undefined)) return []
    const sum = (xs: (number | undefined)[]) => xs.reduce<number>((acc, n) => acc + (n ?? 0), 0)
    const diff = sum(a) - sum(b)
    return [diff > 0 ? 1 : diff < 0 ? 0 : 0.5]
  })
  return won.length ? won.reduce((s, x) => s + x, 0) / won.length : null
}

/** A's game score: the mean vote of the judges that voted; null when none did. */
export const gameScore = (votes: Vote[]): number | null => {
  const vals = votes.map(voteValue).filter((x): x is number => x !== null)
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

/**
 * Bradley-Terry strengths by the MM algorithm. Each game gives A `score` and B `1 - score` wins. Every player also
 * plays one virtual tie with a player of strength 1, so a player who only won or only lost keeps a finite strength.
 */
export const bradleyTerry = (players: string[], games: { a: string; b: string; score: number }[], iterations = 200) => {
  const p = new Map(players.map((x) => [x, 1]))
  const wins = new Map(players.map((x) => [x, 0.5]))
  for (const g of games) {
    if (!p.has(g.a) || !p.has(g.b)) continue
    wins.set(g.a, wins.get(g.a)! + g.score)
    wins.set(g.b, wins.get(g.b)! + 1 - g.score)
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>()
    for (const x of players) {
      let denom = 1 / (p.get(x)! + 1)
      for (const g of games) {
        if (g.a === x && p.has(g.b)) denom += 1 / (p.get(x)! + p.get(g.b)!)
        else if (g.b === x && p.has(g.a)) denom += 1 / (p.get(x)! + p.get(g.a)!)
      }
      next.set(x, wins.get(x)! / denom)
    }
    for (const [k, v] of next) p.set(k, v)
  }
  return p
}

/** Elo-scale rating: 1000 is the baseline (or the geometric mean when there is no baseline). */
export const eloScale = (strengths: Map<string, number>, anchor = BASELINE): Map<string, number> => {
  const vals = [...strengths.values()]
  const ref = strengths.get(anchor) ?? Math.exp(vals.reduce((s, v) => s + Math.log(v), 0) / Math.max(1, vals.length))
  return new Map([...strengths].map(([k, v]) => [k, 1000 + 400 * Math.log10(v / ref)]))
}

/** Probability that x beats y under the strengths. */
export const winProbability = (s: Map<string, number>, x: string, y: string): number => {
  const a = s.get(x) ?? 1
  const b = s.get(y) ?? 1
  return a / (a + b)
}

export type Row = {
  id: string
  label: string
  kind: Variant["kind"]
  generation: number
  rating: number
  /** Probability of beating the baseline. */
  vsBaseline: number
  games: number
  wins: number
  losses: number
  ties: number
  /** Mean judge score per criterion, 1-10, over every game and order this variant played. */
  rubric: Rubric
  builds: { n: number; status: Build["status"]; error?: string; checks?: Record<string, number>; shots: Shot[] }[]
  skills: string[]
  sources: string[]
  reasons: string[]
}

const scoredGames = (t: Tournament) => t.games.filter((g): g is Game & { score: number } => g.score !== null)

export const strengthsOf = (t: Tournament): Map<string, number> => {
  const field = Object.values(t.variants)
    .filter(inField)
    .map((v) => v.id)
  return bradleyTerry(
    field,
    scoredGames(t).map((g) => ({ a: g.a.variant, b: g.b.variant, score: g.score })),
  )
}

/** The leaderboard: every variant, best first; variants with no usable build come last. */
export const leaderboard = (t: Tournament): Row[] => {
  const s = strengthsOf(t)
  const elo = eloScale(s)
  const rows = Object.values(t.variants).map((v): Row => {
    const games = scoredGames(t).filter((g) => g.a.variant === v.id || g.b.variant === v.id)
    const mine = (g: Game) => (g.a.variant === v.id ? g.score! : 1 - g.score!)
    const sums: Record<string, [number, number]> = {}
    const reasons: string[] = []
    for (const g of games) {
      const side = g.a.variant === v.id ? "A" : "B"
      for (const vote of g.votes) {
        for (const sc of vote.scores)
          for (const [k, n] of Object.entries(sc[side] ?? {}))
            if (typeof n === "number") sums[k] = [(sums[k]?.[0] ?? 0) + n, (sums[k]?.[1] ?? 0) + 1]
        reasons.push(...vote.reasons.slice(0, 1).map((r) => `${vote.judge}: ${r}`))
      }
    }
    return {
      id: v.id,
      label: v.label,
      kind: v.kind,
      generation: v.generation,
      rating: s.has(v.id) ? Math.round(elo.get(v.id)!) : 0,
      vsBaseline: s.has(v.id) && s.has(BASELINE) ? winProbability(s, v.id, BASELINE) : 0,
      games: games.length,
      wins: games.filter((g) => mine(g) > 0.5).length,
      losses: games.filter((g) => mine(g) < 0.5).length,
      ties: games.filter((g) => mine(g) === 0.5).length,
      rubric: Object.fromEntries(Object.entries(sums).map(([k, [a, n]]) => [k, Math.round((a / n) * 10) / 10])),
      builds: v.builds.map(({ n, status, error, checks, shots }) => ({
        n,
        status,
        ...(error ? { error } : {}),
        ...(checks ? { checks } : {}),
        shots,
      })),
      skills: v.skills.map((k) => k.name),
      sources: v.sources,
      reasons: reasons.slice(-6),
    }
  })
  return rows.sort((x, y) => (s.has(y.id) ? 1 : 0) - (s.has(x.id) ? 1 : 0) || y.rating - x.rating)
}

const played = (t: Tournament, a: string, b: string) =>
  t.rounds.some((r) => r.pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a)))

/**
 * Swiss pairing: players sorted by rating; each unpaired player meets the nearest one below it it has not met yet.
 * A player with no new opponent left sits the round out.
 */
export const swissPairs = (t: Tournament): [string, string][] => {
  const s = strengthsOf(t)
  let order = [...s.keys()].sort((x, y) => s.get(y)! - s.get(x)! || x.localeCompare(y))
  // Odd field: one player sits out. Give the bye to the lowest-rated player with the fewest byes so far, never twice
  // while another has had none.
  if (order.length % 2 === 1) {
    const byes = (x: string) => t.rounds.filter((r) => !r.pairs.some((p) => p.includes(x))).length
    const bye = [...order].reverse().sort((x, y) => byes(x) - byes(y))[0]!
    order = order.filter((x) => x !== bye)
  }
  // Pair by rating, no rematches, as many pairs as possible: a depth-first search that tries the nearest-rated
  // unplayed opponent first and backtracks when a choice strands players (a greedy pass can leave several unpaired).
  let best: [string, string][] = []
  let steps = 0
  const search = (rest: string[], acc: [string, string][]) => {
    if (acc.length + Math.floor(rest.length / 2) <= best.length || ++steps > 20_000) return
    if (rest.length < 2) {
      best = [...acc]
      return
    }
    const [x, ...others] = rest
    for (const y of others.filter((o) => !played(t, x!, o)))
      search(
        others.filter((o) => o !== y),
        [...acc, [x!, y]],
      )
    // x sits out this round (only when nothing better pairs everyone else)
    search(others, acc)
  }
  search(order, [])
  return best
}

/** Every variant in the field that has not met the baseline yet, paired with it. */
export const baselinePairs = (t: Tournament): [string, string][] =>
  Object.values(t.variants)
    .filter((v) => v.id !== BASELINE && inField(v) && !played(t, v.id, BASELINE))
    .map((v): [string, string] => [v.id, BASELINE])

/**
 * Builds paired for a match: build k of A against build k of B, cycling the usable builds, so every usable build of
 * both sides plays. `games` caps it (0 = every build).
 */
export const matchBuilds = (a: Variant, b: Variant, games: number): [number, number][] => {
  const ua = usableBuilds(a).map((x) => x.n)
  const ub = usableBuilds(b).map((x) => x.n)
  if (!ua.length || !ub.length) return []
  const all = Math.max(ua.length, ub.length)
  const n = games > 0 ? Math.min(games, all) : all
  return Array.from({ length: n }, (_, k) => [ua[k % ua.length]!, ub[k % ub.length]!])
}

/** Combination candidates: pairs among the top variants where both beat the baseline with at least `margin`. */
export const comboCandidates = (t: Tournament, topK: number, margin: number): [string, string][] => {
  const s = strengthsOf(t)
  const top = leaderboard(t)
    .filter((r) => r.kind !== "baseline" && s.has(r.id) && r.vsBaseline >= margin)
    .slice(0, topK)
    .map((r) => r.id)
  const out: [string, string][] = []
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) if (!t.variants[comboId(top[i]!, top[j]!)]) out.push([top[i]!, top[j]!])
  return out
}

/** Join two variants: skills and plugins once each, both instruction texts. */
export const combine = (a: Variant, b: Variant, generation: number, runs: number): Variant => {
  const byDir = new Map([...a.skills, ...b.skills].map((k) => [k.dir, k]))
  return {
    id: comboId(a.id, b.id),
    label: `${a.label} + ${b.label}`,
    kind: "combo",
    parents: [a.id, b.id],
    sources: [...new Set([...a.sources, ...b.sources])],
    skills: [...byDir.values()],
    plugins: [...new Set([...a.plugins, ...b.plugins])],
    instructions: [a.instructions, b.instructions].filter(Boolean).join("\n\n"),
    generation,
    builds: newBuilds(runs),
  }
}

export const newBuilds = (runs: number): Build[] =>
  Array.from({ length: runs }, (_, i) => ({ n: i + 1, status: "pending" as const, shots: [] }))

export type GalleryShot = {
  variant: string
  label: string
  build: number
  file: string
  page: string
  viewport: string
}

/** Desktop home and phone shots of one build (the first page of the preset). */
const homeShots = (t: Tournament, variant: string, n: number): GalleryShot[] => {
  const v = t.variants[variant]
  const b = v?.builds.find((x) => x.n === n)
  if (!v || !b) return []
  const first = b.shots[0]?.page
  return b.shots
    .filter((s) => s.page === first)
    .filter((s, i, all) => all.findIndex((x) => x.viewport === s.viewport) === i)
    .map((s) => ({ variant: v.id, label: v.label, build: n, file: s.file, page: s.page, viewport: s.viewport }))
}

/**
 * What the leaderboard pin shows beside the table: the newest judged game (both sides, A's score) and the best
 * build of each of the top `top` variants (its build that scored best in its games).
 */
export const gallery = (t: Tournament, top = 3) => {
  const last = t.games.findLast((g) => g.score !== null)
  const buildScore = (variant: string, n: number) => {
    const mine = t.games.filter(
      (g) =>
        g.score !== null &&
        ((g.a.variant === variant && g.a.build === n) || (g.b.variant === variant && g.b.build === n)),
    )
    return mine.length
      ? mine.reduce((s, g) => s + (g.a.variant === variant ? g.score! : 1 - g.score!), 0) / mine.length
      : -1
  }
  const best = leaderboard(t)
    .filter((r) => r.games > 0)
    .slice(0, top)
    .flatMap((r) => {
      const ok = r.builds.filter((b) => b.status === "ok")
      const n = ok.sort((x, y) => buildScore(r.id, y.n) - buildScore(r.id, x.n))[0]?.n
      return n === undefined ? [] : [{ rank: 0, rating: r.rating, shots: homeShots(t, r.id, n) }]
    })
    .map((x, i) => ({ ...x, rank: i + 1 }))
  return {
    latest: last
      ? {
          round: last.round,
          scoreA: last.score!,
          reason: last.votes.flatMap((v) => v.reasons.slice(0, 1).map((r) => `${v.judge}: ${r}`))[0] ?? null,
          a: homeShots(t, last.a.variant, last.a.build),
          b: homeShots(t, last.b.variant, last.b.build),
        }
      : null,
    best,
  }
}

/** The leader and its rating, or nulls before any game. */
export const leader = (t: Tournament): { id: string | null; rating: number | null } => {
  const top = leaderboard(t).find((r) => r.games > 0)
  return top ? { id: top.id, rating: top.rating } : { id: null, rating: null }
}

/** A file of build `n` of `variant` (its pages, CSS, JS), or null when it is missing or outside the build folder. */
export const buildFile = (dir: string, variant: string, n: string, file: string): string | null => {
  const root = path.join(dir, "builds", variant, n)
  let full: string
  try {
    full = path.resolve(root, decodeURIComponent(file))
  } catch {
    return null
  }
  return full.startsWith(`${root}${path.sep}`) && existsSync(full) && statSync(full).isFile() ? full : null
}

/** A state file of an older version: fields it lacks get their defaults; its old phases count as running. */
export const normalize = (raw: Record<string, unknown>): Tournament => {
  const t = raw as Tournament & { status: string }
  const old = String(t.status)
  const status = ["running", "paused", "stopped", "done"].includes(old) ? old : old === "failed" ? "stopped" : "running"
  return {
    ...t,
    preset: t.preset ?? "ui-skills",
    title: t.title ?? t.id,
    jobs: t.jobs ?? [],
    status: status as Status,
  }
}

/** Tournament files: $SF_STATE_DIR/tournaments/<id>/state.json, with builds/ and shots/ beside it. */
export class TournamentStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
  }
  dir(id: string): string {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`bad tournament id ${id}`)
    return path.join(this.root, id)
  }
  get(id: string): Tournament | null {
    const f = path.join(this.dir(id), "state.json")
    return existsSync(f) ? normalize(JSON.parse(readFileSync(f, "utf8"))) : null
  }
  save(t: Tournament): void {
    const d = this.dir(t.id)
    mkdirSync(d, { recursive: true })
    const tmp = path.join(d, "state.json.tmp")
    writeFileSync(tmp, JSON.stringify(t, null, 2))
    renameSync(tmp, path.join(d, "state.json"))
  }
  list(): Tournament[] {
    return readdirSync(this.root)
      .flatMap((id) => {
        try {
          const t = this.get(id)
          return t ? [t] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }
}
