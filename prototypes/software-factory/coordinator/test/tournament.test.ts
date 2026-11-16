import { expect, test } from "bun:test"
import { parsePromptFile } from "../src/prompt.ts"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  auditSummary,
  BASELINE,
  baselinePairs,
  bradleyTerry,
  buildFile,
  CRITERIA,
  combine,
  comboCandidates,
  eloScale,
  gallery,
  gameScore,
  leaderboard,
  matchBuilds,
  newBuilds,
  sourceId,
  swissPairs,
  TournamentStore,
  uniqueSources,
  voteValue,
  type Game,
  type Tournament,
  type Variant,
  type Vote,
} from "../src/tournament.ts"
import {
  auditTools,
  makeTournaments,
  readCard,
  settleInterrupted,
  skillNames,
  subpageLinks,
} from "../src/tournamentRun.ts"
import { leaderboardTable, statusView } from "../src/tournamentTools.ts"
import { PRESETS } from "../src/tournamentPresets.ts"
import { parseSources } from "../tournament-cli.ts"
import { fitShots, parseJudge, swapSides } from "../src/uiJudge.ts"

const variant = (id: string, kind: Variant["kind"] = "source", ok = 3): Variant => ({
  id,
  label: id,
  kind,
  sources: [],
  skills: [{ name: `${id}-skill`, dir: `/s/${id}` }],
  plugins: [],
  instructions: `use ${id}`,
  generation: 0,
  builds: newBuilds(3).map((b) => ({ ...b, status: b.n <= ok ? ("ok" as const) : ("failed" as const) })),
})

/** A vote whose two orders give A and B these scores on every aspect. */
const vote = (judge: string, ...orders: [number, number][]): Vote => ({
  judge,
  scores: orders.map(([a, b]) => ({
    A: Object.fromEntries(CRITERIA.map((k) => [k, a])),
    B: Object.fromEntries(CRITERIA.map((k) => [k, b])),
  })),
  reasons: [],
})

const tournament = (ids: string[], games: [string, string, number][] = []): Tournament => ({
  id: "t-test",
  preset: "ui-skills",
  title: "test",
  jobs: [],
  createdAt: 0,
  brief: "",
  sources: [],
  status: "running",
  reason: null,
  limitUsd: 100,
  spentUsd: 0,
  cards: {},
  variants: Object.fromEntries(ids.map((id) => [id, variant(id, id === BASELINE ? "baseline" : "source")])),
  rounds: games.length
    ? [{ n: 1, generation: 0, kind: "swiss", pairs: games.map(([a, b]) => [a, b]), done: true }]
    : [],
  games: games.map(([a, b, score], i): Game => ({
    id: `g${i}`,
    round: 1,
    a: { variant: a, build: 1 },
    b: { variant: b, build: 1 },
    votes: [],
    score,
  })),
  generations: [],
  log: [],
})

test("a vote is decided aspect by aspect over both orders, each aspect equal", () => {
  expect(voteValue(vote("j", [8, 6], [7, 6]))).toBe(1)
  expect(voteValue(vote("j", [5, 6], [5, 9]))).toBe(0)
  // A position bias that flips the order cancels out: a tie on every aspect.
  expect(voteValue(vote("j", [8, 6], [6, 8]))).toBe(0.5)
  expect(voteValue(vote("j", [8, 6]))).toBeNull()
  expect(voteValue({ ...vote("j", [8, 6], [8, 6]), error: "timeout" })).toBeNull()
  // A wins typography and colour, loses the rest: its share of the aspects.
  const split = vote("j", [5, 7], [5, 7])
  for (const s of split.scores) Object.assign(s.A, { typography: 9, color: 9 })
  expect(voteValue(split)).toBeCloseTo(2 / CRITERIA.length)
  // Aspects a judge left out of either order do not count.
  const partial: Vote = {
    judge: "j",
    reasons: [],
    scores: [
      { A: { typography: 9 }, B: { typography: 4, color: 9 } },
      { A: { typography: 8, color: 1 }, B: { typography: 3 } },
    ],
  }
  expect(voteValue(partial)).toBe(1)
  expect(gameScore([vote("a", [8, 6], [8, 6]), vote("b", [8, 6], [6, 8]), { ...vote("c"), error: "x" }])).toBe(0.75)
  expect(gameScore([{ ...vote("c"), error: "x" }])).toBeNull()
})

test("Bradley-Terry ranks the player who wins more first and stays finite for unbeaten players", () => {
  const s = bradleyTerry(
    ["x", "y", "z"],
    [
      { a: "x", b: "y", score: 1 },
      { a: "x", b: "z", score: 1 },
      { a: "y", b: "z", score: 1 },
    ],
  )
  expect(s.get("x")!).toBeGreaterThan(s.get("y")!)
  expect(s.get("y")!).toBeGreaterThan(s.get("z")!)
  expect(Number.isFinite(s.get("x")!)).toBe(true)
  const elo = eloScale(
    new Map([
      ["baseline", 1],
      ["x", 10],
    ]),
  )
  expect(elo.get("baseline")).toBe(1000)
  expect(Math.round(elo.get("x")!)).toBe(1400)
})

test("the leaderboard puts winners first, gives P(beat baseline), and lists unplayed variants last", () => {
  const t = tournament(
    [BASELINE, "good", "bad", "unbuilt"],
    [
      ["good", BASELINE, 1],
      ["good", "bad", 1],
      [BASELINE, "bad", 0.5],
    ],
  )
  t.variants.unbuilt!.builds = newBuilds(3)
  const rows = leaderboard(t)
  expect(rows[0]!.id).toBe("good")
  expect(rows[0]!.wins).toBe(2)
  expect(rows[0]!.vsBaseline).toBeGreaterThan(0.6)
  expect(rows.at(-1)!.id).toBe("unbuilt")
  expect(rows.at(-1)!.rating).toBe(0)
})

test("Swiss pairing meets neighbours by rating and never repeats a pairing", () => {
  const first = swissPairs(tournament(["a", "b", "c", "d"]))
  expect(first.length).toBe(2)
  const t = tournament(
    ["a", "b", "c", "d"],
    [
      ["a", "b", 1],
      ["c", "d", 1],
    ],
  )
  const next = swissPairs(t)
  const key = (p: [string, string]) => [...p].sort().join()
  expect(next.map(key)).not.toContain("a,b")
  expect(next.map(key)).not.toContain("c,d")
  expect(next.map(key)).toContain("a,c")
})

test("matches use only usable builds and at most `games` games", () => {
  expect(matchBuilds(variant("a", "source", 3), variant("b", "source", 1), 2)).toEqual([
    [1, 1],
    [2, 1],
  ])
  expect(matchBuilds(variant("a", "source", 0), variant("b"), 2)).toEqual([])
})

test("combinations come from top variants that beat the baseline, and join skills once", () => {
  const t = tournament(
    [BASELINE, "a", "b", "c"],
    [
      ["a", BASELINE, 1],
      ["b", BASELINE, 1],
      ["c", BASELINE, 0],
      ["a", "b", 0.5],
    ],
  )
  expect(comboCandidates(t, 3, 0.6)).toEqual([["a", "b"]])
  const c = combine(
    t.variants.a!,
    { ...t.variants.b!, skills: [...t.variants.b!.skills, ...t.variants.a!.skills] },
    1,
    3,
  )
  expect(c.id).toBe("a+b")
  expect(c.skills.map((k) => k.name).sort()).toEqual(["a-skill", "b-skill"])
  expect(c.instructions).toContain("use a")
  expect(c.instructions).toContain("use b")
  t.variants["a+b"] = c
  expect(comboCandidates(t, 3, 0.6)).toEqual([])
})

test("sources: stable ids, duplicates dropped, list files parsed", () => {
  expect(sourceId("https://github.com/Leonxlnx/taste-skill")).toBe("leonxlnx-taste-skill")
  expect(sourceId("https://github.com/Leonxlnx/taste-skill.git/")).toBe("leonxlnx-taste-skill")
  expect(sourceId("https://www.ui-skills.com/skills/jakubkrehel/make-interfaces-feel-better")).toBe(
    "ui-skills-com-skills-jakubkrehel-make-interfaces-feel-better",
  )
  expect(
    uniqueSources(["https://github.com/Leonxlnx/taste-skill", " https://github.com/Leonxlnx/taste-skill/ ", ""]),
  ).toEqual(["https://github.com/Leonxlnx/taste-skill"])
  expect(parseSources("* https://a.dev/x\n# note\n-  https://github.com/o/r  # why\n\n")).toEqual([
    "https://a.dev/x",
    "https://github.com/o/r",
  ])
})

test("the judge's JSON scores are read; unknown aspects and scores outside 1-10 are refused", () => {
  const j = parseJudge(
    'A has better type {not json}.\n{"reason": "B is calmer", "scores": {"A": {"typography": 6, "color": 11, "vibes": 9}, "B": {"typography": 8}}}',
    CRITERIA,
  )
  expect(j.reason).toBe("B is calmer")
  expect(j.A).toEqual({ typography: 6 })
  expect(j.B).toEqual({ typography: 8 })
  expect(() => parseJudge("I prefer A.", CRITERIA)).toThrow()
  expect(swapSides("Design B wins; Design A is cramped. AB stays.")).toBe(
    "Design A wins; Design B is cramped. AB stays.",
  )
  expect(() => parseJudge('{"winner": "A"}', CRITERIA)).toThrow()
  expect(() => parseJudge('{"scores": {"A": {"color": 0}, "B": {"color": 5}}}', CRITERIA)).toThrow()
})

test("a scout card's paths must stay in its folder and name real skills", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-card-"))
  mkdirSync(path.join(dir, "repo", "skills", "x"), { recursive: true })
  writeFileSync(path.join(dir, "repo", "skills", "x", "SKILL.md"), "---\nname: x\ndescription: y\n---\n")
  const card = (c: object) => writeFileSync(path.join(dir, "card.json"), JSON.stringify(c))
  card({ usable: true, title: "X", skills: ["repo/skills/x"], files: ["nope.md"], instructions: "go" })
  const c = readCard(dir)
  expect(c.skills).toEqual([path.join(dir, "repo", "skills", "x")])
  expect(c.files).toEqual([])
  expect(skillNames(c.skills)).toEqual([{ name: "x", dir: c.skills[0]! }])
  writeFileSync(path.join(dir, "repo", "SKILL.md"), "---\nname: refactoring-ui\ndescription: y\n---\n")
  expect(skillNames([path.join(dir, "repo"), path.join(dir, "repo")]).map((k) => k.name)).toEqual([
    "refactoring-ui",
    "refactoring-ui-2",
  ])
  // A card in a subfolder, with paths relative to repo/ or to the card itself, is found.
  rmSync(path.join(dir, "card.json"))
  writeFileSync(path.join(dir, "repo", "card.json"), JSON.stringify({ usable: true, skills: ["skills/x"] }))
  expect(readCard(dir).skills).toEqual([path.join(dir, "repo", "skills", "x")])
  rmSync(path.join(dir, "repo", "card.json"))
  card({ usable: true, skills: ["skills/x"], files: ["SKILL.md"] })
  expect(readCard(dir).skills).toEqual([path.join(dir, "repo", "skills", "x")])
  expect(readCard(dir).files).toEqual([path.join(dir, "repo", "SKILL.md")])
  card({ usable: true, skills: ["../../etc"] })
  expect(() => readCard(dir)).toThrow(/outside/)
  card({ usable: true, skills: ["repo/skills"] })
  expect(() => readCard(dir)).toThrow(/no SKILL.md/)
})

test("a web source's install and pricing pages on the same site are read too", () => {
  const html =
    '<a href="/skills/design">x</a><a href="/skills/design">dup</a><a href="https://other.dev/pricing">o</a><a href="/blog/a">b</a><img src="/img/skills/a.svg"><a href="/img/skills/a.svg">i</a><a href="pricing">p</a>'
  expect(subpageLinks(html, "https://ui.example/")).toEqual([
    "https://ui.example/skills/design",
    "https://ui.example/pricing",
  ])
})

test("work a restart cut off goes back to pending; finished work stays", () => {
  const t = tournament([BASELINE, "a"])
  t.variants.a!.builds[0]!.status = "building"
  t.jobs = [{ id: "j1", kind: "build", items: ["a"], status: "running", startedAt: 0 }]
  settleInterrupted(t)
  expect(t.variants.a!.builds.map((b) => b.status)).toEqual(["pending", "ok", "ok"])
  expect(t.jobs[0]!.status).toBe("interrupted")
})

/** Tournaments with a fake factory: a worker is a promise the test resolves; spend is a number the test sets. */
const harness = () => {
  const root = mkdtempSync(path.join(tmpdir(), "sf-tjobs-"))
  const store = new TournamentStore(root)
  const told: string[] = []
  const asked: string[] = []
  const stopped: string[] = []
  let spent = 0
  const ts = makeTournaments({
    factory: {
      spawn: async () => {
        throw new Error("no workers in this test")
      },
      stop: async (id: string) => void stopped.push(id),
      proxyUrl: "http://x",
      publish: () => ({}) as never,
      workers: new Map(),
    } as never,
    store,
    ownerOf: (t) => `sub-${t.id}`,
    spent: () => spent,
    recordUsage: () => {},
    notify: (_t, text) => void told.push(text),
    ask: (_t, a) => (asked.push(a.title), "ap1"),
  })
  return { ts, store, told, asked, stopped, setSpent: (n: number) => (spent = n) }
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10))
}

test("a job starts and returns at once; one job at a time; the sub-coordinator is told when it ends", async () => {
  const h = harness()
  const t = h.ts.create({ preset: "prototypes", idea: "A shared grocery list for flatmates", limitUsd: 50 })
  expect(t.title).toBe("A shared grocery list for flatmates")
  expect(t.brief).toBe("A shared grocery list for flatmates")
  expect(h.ts.addVariants(t.id, [{ id: "Chat First", label: "Chat", approach: "Lists live in a chat." }])).toEqual({
    added: ["chat-first"],
  })
  const job = h.ts.build(t.id)
  expect("id" in job && job.kind).toBe("build")
  expect(h.ts.build(t.id)).toEqual({ error: expect.stringContaining("still running") })
  await until(() => h.told.length > 0)
  // The fake spawn fails, so every build failed; the job itself ended.
  expect(h.told[0]).toContain("(build) done")
  expect(h.told[0]).toContain("builds: 6 failed")
  expect(h.ts.get(t.id).jobs[0]!.status).toBe("done")
  expect(h.ts.build(t.id)).toEqual({ error: "no pending build" })
  expect("id" in h.ts.build(t.id, ["chat-first"], true)).toBe(true)
})

test("at the cost limit no job starts: the tournament pauses and asks the human once", () => {
  const h = harness()
  const t = h.ts.create({ preset: "prototypes", idea: "x", limitUsd: 10 })
  h.setSpent(12)
  expect(h.ts.build(t.id)).toEqual({ error: expect.stringContaining("paused at the cost limit") })
  expect(h.ts.build(t.id)).toEqual({ error: expect.stringContaining("paused") })
  expect(h.asked).toEqual(["Cost limit reached: tournament x"])
  expect(h.ts.byApproval("ap1")?.id).toBe(t.id)
  h.ts.raise(t.id, 30)
  expect(h.ts.get(t.id).status).toBe("running")
  expect("id" in h.ts.build(t.id)).toBe(true)
})

test("rounds need variants in the field and new pairs; combine adds combo variants", async () => {
  const h = harness()
  const t = h.ts.create({ preset: "ui-skills", sources: ["https://github.com/o/a"] })
  const full = h.store.get(t.id)!
  Object.assign(full.variants, { a: variant("a"), b: variant("b") })
  full.variants[BASELINE]!.builds = full.variants.a!.builds.map((b) => ({ ...b }))
  h.store.save(full)
  expect(h.ts.round(t.id, [["a", "nope"]])).toEqual({ error: expect.stringContaining("not in the field") })
  expect(await h.ts.combine(t.id, [["a", "b"]])).toEqual({ generation: 1, added: ["a+b"] })
  expect(h.ts.get(t.id).variants["a+b"]!.kind).toBe("combo")
  expect(h.ts.finish(t.id, "a wins")).toEqual({ done: true })
  expect(h.ts.get(t.id).status).toBe("done")
})

test("the status view and leaderboard table show what the sub-coordinator needs", () => {
  const t = tournament([BASELINE, "good"], [["good", BASELINE, 1]])
  t.variants.good!.builds[2] = { n: 3, status: "failed", error: "pages missing: cart.html", shots: [] }
  const v = statusView(t)
  expect(v.failedBuilds).toEqual([{ variant: "good", build: 3, status: "failed", error: "pages missing: cart.html" }])
  expect(v.leaderboard.split("\n")[2]).toMatch(/^\| 1 \| good \| \d+ \| \d+% \| 1-0-0 \| ✓✓✗ \|$/)
  expect(leaderboardTable([])).toContain("| # | Variant |")
})

test("presets name their pages, shots and aspects; the judge prompts list the same aspects", () => {
  for (const p of Object.values(PRESETS)) {
    expect(p.shots.every((s) => p.pages.includes(s.page))).toBe(true)
    expect(p.shots.some((s) => s.viewport === "mobile")).toBe(true)
  }
  expect(PRESETS["ui-skills"]!.aspects).toEqual([...CRITERIA])
})

test("the store saves and lists tournaments and refuses unsafe ids", () => {
  const store = new TournamentStore(mkdtempSync(path.join(tmpdir(), "sf-tour-")))
  const t = tournament([BASELINE])
  store.save(t)
  expect(store.get("t-test")!.variants[BASELINE]!.kind).toBe("baseline")
  expect(store.list().map((x) => x.id)).toEqual(["t-test"])
  expect(() => store.get("../x")).toThrow()
})

test("the gallery shows the newest judged pair and each top variant's best build", () => {
  const t = tournament(
    [BASELINE, "good"],
    [
      ["good", BASELINE, 1],
      ["good", BASELINE, 0.2],
    ],
  )
  t.games[1]!.a.build = 2
  for (const v of Object.values(t.variants))
    for (const b of v.builds)
      b.shots = [
        { page: "index.html", viewport: "desktop", file: `/s/${v.id}-${b.n}-home.png` },
        { page: "index.html", viewport: "desktop", file: `/s/${v.id}-${b.n}-desktop.png` },
        { page: "cart.html", viewport: "desktop", file: `/s/${v.id}-${b.n}-cart.png` },
        { page: "index.html", viewport: "mobile", file: `/s/${v.id}-${b.n}-mobile.png` },
      ]
  const g = gallery(t)
  expect(g.latest!.a.map((s) => s.file)).toEqual(["/s/good-2-home.png", "/s/good-2-mobile.png"])
  expect(g.latest!.scoreA).toBe(0.2)
  expect(g.best[0]!.shots[0]!.file).toBe("/s/good-1-home.png")
  expect(g.best.map((x) => x.rank)).toEqual([1, 2])
})

test("a build's files are served only from inside its folder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-bf-"))
  mkdirSync(path.join(dir, "builds", "a", "1", "css"), { recursive: true })
  writeFileSync(path.join(dir, "builds", "a", "1", "index.html"), "<h1>x</h1>")
  writeFileSync(path.join(dir, "builds", "a", "1", "css", "site.css"), "h1{}")
  writeFileSync(path.join(dir, "state.json"), "{}")
  expect(buildFile(dir, "a", "1", "index.html")).toBe(path.join(dir, "builds", "a", "1", "index.html"))
  expect(buildFile(dir, "a", "1", "css/site.css")).toBe(path.join(dir, "builds", "a", "1", "css", "site.css"))
  expect(buildFile(dir, "a", "1", "../../../state.json")).toBeNull()
  expect(buildFile(dir, "a", "1", "..%2F..%2F..%2Fstate.json")).toBeNull()
  expect(buildFile(dir, "a", "1", "css")).toBeNull()
  expect(buildFile(dir, "a", "1", "missing.html")).toBeNull()
})

test("every build plays, every variant meets the baseline, and an odd one out sits out only once", () => {
  // matchBuilds: games 0 = every build (3 vs 3), a cap still works.
  expect(matchBuilds(variant("a"), variant("b"), 0)).toEqual([
    [1, 1],
    [2, 2],
    [3, 3],
  ])
  expect(matchBuilds(variant("a"), variant("b"), 2)).toHaveLength(2)
  const t = tournament([BASELINE, "a", "b", "c", "d"])
  expect(baselinePairs(t).map(([v]) => v)).toEqual(["a", "b", "c", "d"])
  // Odd field (5): 2 pairs per round; the player who sat out does not sit out again while others have not.
  const sat: string[] = []
  for (let r = 1; r <= 3; r++) {
    const pairs = swissPairs(t)
    expect(pairs).toHaveLength(2)
    const out = Object.keys(t.variants).filter((v) => !pairs.flat().includes(v))
    expect(out).toHaveLength(1)
    expect(sat).not.toContain(out[0])
    sat.push(out[0]!)
    t.rounds.push({ n: r, generation: 0, kind: "swiss", pairs, done: true })
  }
})

test("an empty front matter block does not leak into the prompt body", () => {
  expect(parsePromptFile("+++\n+++\nDesign the shop.\n")).toMatchObject({ meta: {}, body: "Design the shop." })
})

test("the judge reads each build's measured facts: accessibility, errors, phone width, feedback", () => {
  expect(auditSummary(undefined)).toBe("not measured")
  const s = auditSummary({
    pages: {
      "index.html": {
        axe: { critical: 1, serious: 12, moderate: 0, minor: 0, rules: ["color-contrast:12", "label:1"] },
        errors: 0,
        overflow320: 16,
        interactive: { n: 12, hover: 9, press: 2, focus: 11 },
      },
    },
  })
  expect(s).toBe(
    "index.html: 13 serious accessibility (WCAG AA) violations (color-contrast:12, label:1); 0 JS errors; 16 px too wide at 320 px; of 12 controls 9 change on hover, 2 on press, 11 show keyboard focus",
  )
})

test("a judge with an image limit sees every page: extra whole-page tiles are dropped first", () => {
  const s = (page: string, file: string) => ({ page, viewport: "desktop" as const, file })
  const shots = [
    s("index.html", "home.jpg"),
    s("products.html", "products.jpg"),
    s("product.html", "full-1.jpg"),
    s("product.html", "full-2.jpg"),
    s("product.html", "full-3.jpg"),
    s("cart.html", "cart.jpg"),
    { page: "index.html", viewport: "mobile" as const, file: "mobile.jpg" },
  ]
  expect(fitShots(shots, 5).map((x) => x.file)).toEqual([
    "home.jpg",
    "products.jpg",
    "full-1.jpg",
    "full-2.jpg",
    "cart.jpg",
  ])
  expect(fitShots(shots, 7)).toHaveLength(7)
  expect(new Set(fitShots(shots, 5).map((x) => x.page))).toEqual(
    new Set(["index.html", "products.html", "product.html", "cart.html"]),
  )
})

test("the audit finds the global Playwright and installs axe-core once into the state folder's tools", () => {
  const state = mkdtempSync(path.join(tmpdir(), "sf-tools-"))
  const npmRoot = path.join(state, "npm-global")
  mkdirSync(path.join(npmRoot, "playwright"), { recursive: true })
  writeFileSync(path.join(npmRoot, "playwright", "package.json"), "{}")
  const calls: string[] = []
  const sh = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "))
    if (args[0] === "root") return `${npmRoot}\n`
    const dir = args[args.indexOf("--prefix") + 1]!
    mkdirSync(path.join(dir, "node_modules", "axe-core"), { recursive: true })
    writeFileSync(path.join(dir, "node_modules", "axe-core", "axe.min.js"), "")
    return ""
  }
  const tools = auditTools({ playwright_lib: "", axe: "" }, path.join(state, "tournaments"), sh)
  expect(tools.playwrightLib).toBe(path.join(npmRoot, "playwright"))
  expect(tools.axe).toBe(path.join(state, "tools", "axe", "node_modules", "axe-core", "axe.min.js"))
  expect(calls.filter((c) => c.includes("install"))).toHaveLength(1)
  auditTools({ playwright_lib: "", axe: "" }, path.join(state, "tournaments"), sh)
  expect(calls.filter((c) => c.includes("install"))).toHaveLength(1)
  expect(() => auditTools({ playwright_lib: "/nope", axe: "" }, path.join(state, "tournaments"), sh)).toThrow(
    /npm i -g playwright/,
  )
})
