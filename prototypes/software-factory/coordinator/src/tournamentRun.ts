// Tournament jobs. A tournament sub-coordinator (tournamentTools.ts) decides what runs next; code runs each job:
//
//   scout     one scout per source: paid sources out, then clone or fetch it and pick its skills -> one variant each
//   build     each variant `runs` times with the same brief, model and harness (Claude Agent SDK, clean profile);
//             Playwright screenshots, Jev image checks drop broken builds
//   round     pairwise games; every judge scores every aspect in both orders (tournament.ts voteValue)
//   combine   (no job) pairs of top variants become combo variants for the next build
// One job runs at a time. A tool starts it and returns; when it ends, the sub-coordinator gets a message. A job stops
// at the cost limit (the human decides, a `budget` decision) or when the human stops the tournament.
import { noul } from "@typesafe-ai/sdk"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"
import { factoryConfig, type FactoryConfig } from "./config.ts"
import { chatUsage } from "./costs.ts"
import { decisionsAvailable, systemOne } from "./decide.ts"
import type { Factory, Worker } from "./factory.ts"
import { nextLimits, raiseOption } from "./budget.ts"
import { awaitGateWorker } from "./gateWorker.ts"
import { loadPrompt, promptFile } from "./prompt.ts"
import {
  auditSummary,
  BASELINE,
  baselinePairs,
  combine,
  comboCandidates,
  comboId,
  gameScore,
  inField,
  leader,
  matchBuilds,
  newBuilds,
  sourceId,
  swissPairs,
  uniqueSources,
  type Build,
  type Game,
  type Job,
  type Tournament,
  type TournamentStore,
  type Variant,
} from "./tournament.ts"
import { presetOf, presetPrompt } from "./tournamentPresets.ts"
import { captureAndAudit, jevChecks, judgePair, missingPages } from "./uiJudge.ts"

/** The answer that stops a tournament at its cost limit. */
export const STOP_TOURNAMENT = "Stop the tournament"

export type TournamentDeps = {
  factory: Pick<Factory, "spawn" | "stop" | "proxyUrl" | "publish" | "workers">
  store: TournamentStore
  /** The sub-coordinator that runs tournament `id`: its workers hang under it, so its cost is one subtree. */
  ownerOf: (t: Tournament) => string
  /** USD spent so far by the sub-coordinator, every agent under it, and its judge calls. */
  spent: (t: Tournament) => number
  recordUsage: (agent: string, data: Record<string, unknown>) => void
  /** Tell the sub-coordinator (its conversation) that a job ended. */
  notify: (t: Tournament, text: string) => void
  /** Open a decision in the tournament's conversation; returns its id. */
  ask: (t: Tournament, a: { title: string; summary: string; options: string[]; optionDetails: string[] }) => string
}

const now = () => Date.now()

/** Pause or stop: the loop ends and keeps its state; finished work stays. */
class Halt extends Error {}

/** Run `f` over `items`, at most `n` at once. After a Halt no new item starts; it is thrown once all have ended. */
const pool = async <T>(items: T[], n: number, f: (x: T) => Promise<void>) => {
  const queue = [...items]
  const state: { halt: Halt | null } = { halt: null }
  const worker = async () => {
    while (queue.length && !state.halt)
      await f(queue.shift()!).catch((e) => {
        if (e instanceof Halt) state.halt = e
        else throw e
      })
  }
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, worker))
  if (state.halt) throw state.halt
}

/** Work a restart or halt cut off goes back to pending: a scout or build runs again; finished work stays. */
export const settleInterrupted = (t: Tournament): void => {
  for (const v of Object.values(t.variants)) for (const b of v.builds) if (b.status === "building") b.status = "pending"
  for (const j of t.jobs)
    if (j.status === "running") {
      j.status = "interrupted"
      j.endedAt = Date.now()
    }
}

/** Plain text of a web page, for a scout: no scripts or styles, the GitHub repos it links listed first. */
const htmlText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()

const getHtml = async (url: string) =>
  (await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "follow" })).text()

/** Same-site links whose path says how a skill is installed or sold: install steps often hide a token there. */
export const subpageLinks = (html: string, base: string, max = 4): string[] => {
  const origin = new URL(base).origin
  const urls = [...html.matchAll(/href="([^"#]+)"/g)].flatMap(([, href]) => {
    try {
      const u = new URL(href!, base)
      return u.origin === origin && /^\/(skills?|install|docs?|pricing|get-started)(\/[^.]*)?$/i.test(u.pathname)
        ? [u.href]
        : []
    } catch {
      return []
    }
  })
  return [...new Set(urls)].filter((u) => u !== base).slice(0, max)
}

/** Plain text of a web page, for a scout: the GitHub repos it links first, then the page and a few install pages. */
export const pageText = async (url: string): Promise<string> => {
  const html = await getHtml(url)
  const repos = [...new Set(html.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g) ?? [])]
  const subpages = await Promise.all(
    subpageLinks(html, url).map(
      async (u) => `\n\n--- ${u}\n${htmlText(await getHtml(u).catch(() => "")).slice(0, 6_000)}`,
    ),
  )
  return `GitHub repositories linked: ${repos.join(", ") || "none"}\n\n${htmlText(html).slice(0, 30_000)}${subpages.join("")}`
}

const isRepo = (s: string) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(s.replace(/\.git$/, ""))

type Card = {
  /** The skills need a paid token, licence, subscription or paywall: the source is excluded. */
  paid: boolean
  usable: boolean
  reason: string
  title: string
  summary: string
  skills: string[]
  plugins: string[]
  files: string[]
  instructions: string
}

/** Read and check a scout's card.json; paths must stay inside its folder and name existing skills. */
/** The scout's card: at the top of its folder, else the one it wrote in a subfolder (it may `cd` before writing). */
export const findCard = (folder: string): string => {
  const top = path.join(folder, "card.json")
  if (existsSync(top)) return top
  const found = (readdirSync(folder, { recursive: true }) as string[])
    .filter((f) => path.basename(f) === "card.json" && !f.split(path.sep).includes("node_modules"))
    .map((f) => path.join(folder, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (!found[0]) throw new Error("the scout wrote no card.json")
  return found[0]
}

/**
 * Read and check a scout's card.json. A path may be relative to the folder, to `repo/`, or to the card's own folder
 * (scouts mix them); the first that exists wins. Every path must stay inside the folder; skills need a SKILL.md.
 */
export const readCard = (folder: string): Card => {
  const file = findCard(folder)
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Card>
  const root = path.resolve(folder)
  const bases = [...new Set([root, path.join(root, "repo"), path.dirname(file)])]
  const resolve = (p: string, ok: (full: string) => boolean) => {
    const fulls = bases.map((b) => path.resolve(b, p))
    for (const full of fulls)
      if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error(`card path outside the folder: ${p}`)
    return fulls.find(ok) ?? fulls[0]!
  }
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  const skills = strs(raw.skills).map((p) => resolve(p, (f) => existsSync(path.join(f, "SKILL.md"))))
  for (const s of skills) if (!existsSync(path.join(s, "SKILL.md"))) throw new Error(`no SKILL.md in ${s}`)
  return {
    paid: raw.paid === true,
    usable: raw.usable === true,
    reason: String(raw.reason ?? ""),
    title: String(raw.title ?? path.basename(folder)),
    summary: String(raw.summary ?? ""),
    skills,
    plugins: strs(raw.plugins)
      .map((p) => resolve(p, existsSync))
      .filter((p) => existsSync(p)),
    files: strs(raw.files)
      .map((p) => resolve(p, existsSync))
      .filter((p) => existsSync(p)),
    instructions: String(raw.instructions ?? ""),
  }
}

/** A skill's name: its SKILL.md `name`, else its folder name. */
const skillName = (dir: string): string => {
  const front = readFileSync(path.join(dir, "SKILL.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""
  const name = front.match(/^name:\s*["']?([\w.-]+)/m)?.[1]
  return name ?? path.basename(dir)
}

/** Skills under their own names; two skills with one name get a suffix, so both load. */
export const skillNames = (dirs: string[]): { name: string; dir: string }[] => {
  const seen = new Map<string, number>()
  return dirs.map((dir) => {
    const base = skillName(dir)
    const k = (seen.get(base) ?? 0) + 1
    seen.set(base, k)
    return { name: k === 1 ? base : `${base}-${k}`, dir }
  })
}

const AXE_VERSION = "4.14.0"
const expand = (p: string) => p.replace(/^~(?=\/)/, homedir())

/**
 * The audit's tools: the configured paths, else the global npm Playwright and axe-core installed once into the
 * state folder's tools/axe (next to the tournaments folder). Throws with the fix when one is missing.
 */
export const auditTools = (
  c: Pick<FactoryConfig["tournament"], "playwright_lib" | "axe">,
  tournamentsRoot: string,
  sh: (cmd: string, args: string[], cwd?: string) => string = (cmd, args, cwd) =>
    execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) }),
) => {
  const playwrightLib = c.playwright_lib
    ? expand(c.playwright_lib)
    : path.join(sh("npm", ["root", "-g"]).trim(), "playwright")
  if (!existsSync(path.join(playwrightLib, "package.json")))
    throw new Error(
      `Playwright library not found at ${playwrightLib}: npm i -g playwright, or set [tournament] playwright_lib`,
    )
  let axe = c.axe ? expand(c.axe) : ""
  if (!axe) {
    const dir = path.join(path.dirname(tournamentsRoot), "tools", "axe")
    axe = path.join(dir, "node_modules", "axe-core", "axe.min.js")
    if (!existsSync(axe)) {
      mkdirSync(dir, { recursive: true })
      sh("npm", ["install", "--prefix", dir, "--no-save", "--silent", `axe-core@${AXE_VERSION}`])
    }
  }
  if (!existsSync(axe)) throw new Error(`axe-core not found at ${axe}: set [tournament] axe`)
  return { playwrightLib, axe }
}

export const makeTournaments = (d: TournamentDeps) => {
  /** A halt per running job: stop or cost limit. Workers race it, so a job never waits on a stopped worker. */
  const halts = new Map<string, { promise: Promise<never>; fire: (why: string) => void; fired: boolean }>()
  const cfg = (): FactoryConfig["tournament"] => factoryConfig().tournament
  const save = (t: Tournament) => {
    d.store.save(t)
    d.factory.publish(d.ownerOf(t), "factory.tournament", null, String(now()), {
      id: t.id,
      threadId: t.threadId ?? null,
      status: t.status,
      reason: t.reason,
      spentUsd: t.spentUsd,
    })
  }
  const log = (t: Tournament, text: string) => {
    t.log.push({ at: now(), text })
    save(t)
  }
  const get = (id: string): Tournament => {
    const t = d.store.get(id)
    if (!t) throw new Error(`no tournament ${id}`)
    return t
  }

  // ---------- cost limit ----------

  /** At the cost limit: pause and ask the human (once) for a new limit or a stop. */
  const pause = (t: Tournament) => {
    t.status = "paused"
    t.reason = `cost limit reached: $${t.spentUsd.toFixed(2)} of $${t.limitUsd}`
    if (!t.approvalId) {
      const limits = nextLimits(t.limitUsd, t.spentUsd)
      t.approvalId = d.ask(t, {
        title: `Cost limit reached: tournament ${t.title}`.slice(0, 120),
        summary: `Tournament **${t.title}** (${t.id}) has spent $${t.spentUsd.toFixed(2)} of its $${t.limitUsd} limit. Its job is stopped; finished builds and games are kept.\n\nPick a new limit to go on (or type an amount in dollars), or stop the tournament.`,
        options: [...limits.map(raiseOption), STOP_TOURNAMENT],
        optionDetails: [
          ...limits.map((n) => `The sub-coordinator goes on; pause again at $${n}`),
          "Keep the leaderboard as it is",
        ],
      })
    }
    save(t)
  }

  /** Before each paid step: halt when the human stopped the tournament or the spend reached the limit. */
  const checkBudget = (t: Tournament) => {
    const h = halts.get(t.id)
    if (h?.fired) throw new Halt("stopped")
    t.spentUsd = d.spent(t)
    if (t.spentUsd < t.limitUsd) return
    pause(t)
    halts.get(t.id)?.fire(t.reason!)
    throw new Halt(t.reason!)
  }
  const dir = (t: Tournament, ...p: string[]) => path.join(d.store.dir(t.id), ...p)

  /** Start a worker under the sub-coordinator and wait for it; a stuck one is replaced, a halt stops the wait. */
  const work = async (t: Tournament, name: string, task: string, model: string, workdir: string, extra = {}) => {
    const c = factoryConfig()
    const started: Worker[] = []
    const waiting = awaitGateWorker(
      async () => {
        const w = await d.factory.spawn({
          name,
          role: "worker",
          auth: "proxy",
          model,
          task,
          workdir,
          owner: d.ownerOf(t),
          harness: { kind: "claude", profiles: ["clean"] },
          // Only the variant's skills: no CLAUDE.md, no user or built-in skills from the host.
          isolated: true,
          ...extra,
        })
        started.push(w)
        return w
      },
      `tournament ${name}`,
      (id) => d.factory.stop(id),
      c,
    )
    try {
      const halt = halts.get(t.id)?.promise
      const w = await (halt ? Promise.race([waiting, halt]) : waiting)
      return { id: w.id, lastMessage: w.lastMessage }
    } finally {
      for (const w of started) await d.factory.stop(w.id).catch(() => {})
    }
  }

  // ---------- scout ----------

  /** Jev's probability that getting the source's skills needs payment, from its page or README. 0 without Jev. */
  const paidProbability = async (source: string, text: string): Promise<number> => {
    if (!decisionsAvailable() || !text.trim()) return 0
    const { answers } = await systemOne({
      state: JSON.stringify({ source, text: text.slice(0, 30_000) }),
      questions: { paid: noul(loadPrompt("tournament/paid")) },
      timeoutMs: 30_000,
    })
    return answers.paid?.noul ?? 0
  }

  const readme = (repo: string): string => {
    const f = ["README.md", "readme.md", "README", "SKILL.md"].map((n) => path.join(repo, n)).find((p) => existsSync(p))
    return f ? readFileSync(f, "utf8") : ""
  }

  const scout = async (t: Tournament, source: string) => {
    const id = sourceId(source)
    const card = t.cards[source]!
    if (card.status !== "pending") return
    checkBudget(t)
    const folder = dir(t, "sources", id)
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { recursive: true })
    let page = ""
    try {
      if (isRepo(source)) {
        const url = source.replace(/\/$/, "").replace(/(\.git)?$/, ".git")
        execFileSync("git", ["clone", "-q", "--depth", "1", url, path.join(folder, "repo")], {
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 300_000,
        })
      } else page = await pageText(source)
      const paid = await paidProbability(source, page || readme(path.join(folder, "repo"))).catch((e) => {
        log(t, `paid check ${id} failed, the scout decides: ${e instanceof Error ? e.message : e}`)
        return 0
      })
      if (paid >= cfg().paid_threshold) {
        card.status = "excluded"
        card.reason = `needs a paid token, licence, subscription or paywall (Jev ${paid.toFixed(2)})`
      } else {
        const task = loadPrompt(presetPrompt(t.preset, "scout"), {
          source,
          folder,
          page,
          brief: t.brief,
          max_skills: String(cfg().max_skills),
        })
        const w = await work(t, `scout-${id}`.slice(0, 60), task, cfg().scout_model, folder)
        card.workerId = w.id
        const c = readCard(folder)
        if (c.paid) {
          card.status = "excluded"
          card.reason = `needs payment (scout): ${c.reason}`
        } else if (!c.usable || (!c.skills.length && !c.files.length && !c.instructions.trim())) {
          // A source with no skill folder (DESIGN.md files, a method on a web page) still plays with its files.
          card.status = "skipped"
          card.reason = c.reason || "no usable skill"
        } else {
          card.status = "ok"
          card.reason = c.summary
          card.variantId = id
          t.variants[id] = {
            id,
            label: c.title,
            kind: "source",
            sources: [source],
            skills: skillNames(c.skills),
            plugins: c.plugins,
            instructions: [c.instructions, ...c.files.map((f) => `Read and follow ${f}.`)].filter(Boolean).join("\n"),
            generation: 0,
            builds: newBuilds(cfg().runs),
          }
        }
      }
    } catch (e) {
      if (e instanceof Halt) throw e
      card.status = "failed"
      card.reason = e instanceof Error ? e.message.slice(0, 400) : String(e)
    }
    log(t, `scout ${id}: ${card.status}${card.reason ? ` (${card.reason.slice(0, 160)})` : ""}`)
  }

  // ---------- build, capture, check ----------

  const buildOne = async (t: Tournament, v: Variant, b: Build) => {
    if (b.status !== "pending") return
    checkBudget(t)
    const c = cfg()
    const p = presetOf(t.preset)
    const site = dir(t, "builds", v.id, String(b.n))
    rmSync(site, { recursive: true, force: true })
    mkdirSync(site, { recursive: true })
    b.status = "building"
    delete b.error
    save(t)
    try {
      const task = loadPrompt(
        presetPrompt(t.preset, "build"),
        p.variants === "sources"
          ? {
              brief: t.brief,
              site,
              skills: v.skills.map((k) => `- ${k.name} (${k.dir})`).join("\n"),
              instructions: v.instructions,
            }
          : { brief: t.brief, site, approach: v.instructions },
      )
      const w = await work(t, `build-${v.id}-${b.n}`.slice(0, 60), task, c.builder_model, site, {
        ...(v.skills.length ? { skills: v.skills } : {}),
        ...(v.plugins.length ? { plugins: v.plugins } : {}),
      })
      b.workerId = w.id
      const missing = missingPages(site, p.pages)
      if (missing.length) throw new Error(`pages missing: ${missing.join(", ")}`)
      const size = (x: string) => x.split(",").map(Number) as [number, number]
      const captured = await captureAndAudit(site, dir(t, "shots"), `${v.id}-${b.n}`, p.shots, p.pages, {
        ...auditTools(c, d.store.root),
        sizes: { home: size(c.home_viewport), desktop: size(c.desktop_viewport), mobile: size(c.mobile_viewport) },
      })
      b.shots = captured.shots
      b.audit = captured.audit
      b.checks = await jevChecks(b.shots, presetPrompt(t.preset, "checks"), t.brief).catch((e) => {
        log(t, `jev checks ${v.id}#${b.n} failed, build kept: ${e instanceof Error ? e.message : e}`)
        return undefined
      })
      // Only a check marked `drop = true` (a blank or broken page) drops a build: Jev's other checks are notes.
      const low = Object.entries(b.checks ?? {}).filter(
        ([k, x]) => x < c.check_threshold && promptFile(`${presetPrompt(t.preset, "checks")}/${k}`).meta.drop === true,
      )
      b.status = low.length ? "dropped" : "ok"
      if (low.length) b.error = `failed checks: ${low.map(([k, x]) => `${k} ${x.toFixed(2)}`).join(", ")}`
    } catch (e) {
      if (e instanceof Halt) {
        b.status = "pending"
        throw e
      }
      b.status = "failed"
      b.error = e instanceof Error ? e.message.slice(0, 400) : String(e)
    }
    log(t, `build ${v.id}#${b.n}: ${b.status}${b.error ? ` (${b.error})` : ""}`)
  }

  // ---------- judge ----------

  const playGame = async (t: Tournament, g: Game) => {
    checkBudget(t)
    const c = cfg()
    const p = presetOf(t.preset)
    const buildOf = (x: Game["a"]) => t.variants[x.variant]!.builds.find((b) => b.n === x.build)!
    const shotsOf = (x: Game["a"]) => buildOf(x).shots
    const deps = {
      facts: { A: auditSummary(buildOf(g.a).audit), B: auditSummary(buildOf(g.b).audit) },
      proxyUrl: d.factory.proxyUrl,
      prompt: loadPrompt(presetPrompt(t.preset, "judge"), { brief: t.brief, criteria: p.aspects.join(", ") }),
      aspects: p.aspects,
      maxTokens: c.judge_max_tokens,
      maxImages: c.judge_max_images,
      timeoutMs: 300_000,
      recordUsage: (model: string, reply: Parameters<typeof chatUsage>[1]) => {
        const u = chatUsage(model, reply)
        if (u) d.recordUsage(`${d.ownerOf(t)}-judge`, u)
      },
    }
    const halt = halts.get(t.id)?.promise
    const votes = Promise.all(c.judges.map((m) => judgePair(m, shotsOf(g.a), shotsOf(g.b), deps)))
    g.votes = await (halt ? Promise.race([votes, halt]) : votes)
    g.score = gameScore(g.votes)
    const errors = g.votes.filter((v) => v.error).map((v) => `${v.judge}: ${v.error!.slice(0, 120)}`)
    log(
      t,
      `game ${g.a.variant}#${g.a.build} vs ${g.b.variant}#${g.b.build}: ${g.score === null ? "no vote" : g.score.toFixed(2)}${errors.length ? `; errors ${errors.join("; ")}` : ""}`,
    )
  }

  /** Play every unplayed game of round `n`. */
  const playRound = async (t: Tournament, n: number) => {
    await pool(
      t.games.filter((g) => g.round === n && g.votes.length === 0),
      4,
      (g) => playGame(t, g),
    )
    t.rounds.find((r) => r.n === n)!.done = true
    save(t)
  }

  /** A new round of these pairs (default: Swiss pairs), its games added; or the open round, to finish it. */
  const openRound = (t: Tournament, given?: [string, string][]): number | string => {
    const open = t.rounds.find((r) => !r.done)
    if (open) return open.n
    const field = new Set(
      Object.values(t.variants)
        .filter(inField)
        .map((v) => v.id),
    )
    const pairs = given ?? swissPairs(t)
    const bad = pairs.flat().filter((id) => !field.has(id))
    if (bad.length) return `not in the field (no usable build yet): ${[...new Set(bad)].join(", ")}`
    if (!pairs.length) return "no new pairs: every pair in the field has met"
    const round = {
      n: t.rounds.length + 1,
      generation: t.generations.length,
      kind: "swiss" as const,
      pairs,
      done: false,
    }
    t.rounds.push(round)
    for (const [a, b] of pairs)
      for (const [buildA, buildB] of matchBuilds(t.variants[a]!, t.variants[b]!, cfg().games_per_match))
        t.games.push({
          id: `r${round.n}-${a}-${b}-${buildA}`,
          round: round.n,
          a: { variant: a, build: buildA },
          b: { variant: b, build: buildB },
          votes: [],
          score: null,
        })
    save(t)
    return round.n
  }

  // ---------- combine ----------

  /** Jev's probability that each candidate pair complements each other. */
  const askCombos = async (t: Tournament, pairs: [string, string][]): Promise<Record<string, number>> => {
    if (!decisionsAvailable() || !pairs.length) return Object.fromEntries(pairs.map(([a, b]) => [comboId(a, b), 0]))
    const describe = (v: Variant) => ({
      title: v.label,
      skills: v.skills.map((k) => k.name),
      instructions: v.instructions.slice(0, 1500),
    })
    const { answers } = await systemOne({
      state: JSON.stringify(
        Object.fromEntries(
          pairs.map(([a, b]) => [comboId(a, b), [describe(t.variants[a]!), describe(t.variants[b]!)]]),
        ),
      ),
      questions: Object.fromEntries(
        pairs.map(([a, b]) => [
          comboId(a, b),
          noul(`${loadPrompt("tournament/combine")} The pair is the state entry \`${comboId(a, b)}\`.`),
        ]),
      ),
      timeoutMs: 30_000,
    })
    return Object.fromEntries(pairs.map(([a, b]) => [comboId(a, b), answers[comboId(a, b)]?.noul ?? 0]))
  }

  // ---------- jobs ----------

  const running = (t: Tournament) => t.jobs.find((j) => j.status === "running")

  /** Why no job may start now, or null. At the cost limit it pauses the tournament first. */
  const blocked = (t: Tournament): string | null => {
    t.spentUsd = d.spent(t)
    if (t.status === "running" && t.spentUsd >= t.limitUsd) pause(t)
    if (t.status === "paused")
      return `paused at the cost limit ($${t.spentUsd.toFixed(2)} of $${t.limitUsd}); the human decides`
    if (t.status !== "running") return `the tournament is ${t.status}`
    const j = running(t)
    return j ? `job ${j.id} (${j.kind}) is still running; wait for its message` : null
  }

  /**
   * Start a job and return at once. When it ends, the sub-coordinator gets one message with the summary. A halt
   * (stop, cost limit) ends it early; its unfinished items go back to pending.
   */
  const startJob = (
    id: string,
    kind: Job["kind"],
    items: string[],
    run: (t: Tournament) => Promise<string>,
  ): Job | { error: string } => {
    const t = get(id)
    const why = blocked(t)
    if (why) return { error: why }
    const job: Job = { id: `j${t.jobs.length + 1}`, kind, items, status: "running", startedAt: now() }
    t.jobs.push(job)
    save(t)
    const { promise, reject } = Promise.withResolvers<never>()
    promise.catch(() => {})
    const h = { promise, fired: false, fire: (reason: string) => ((h.fired = true), reject(new Halt(reason))) }
    halts.set(t.id, h)
    void (async () => {
      let summary: string
      try {
        summary = await run(t)
        job.status = "done"
      } catch (e) {
        settleInterrupted(t)
        job.status = e instanceof Halt ? "halted" : "failed"
        summary = e instanceof Error ? e.message : String(e)
      }
      halts.delete(t.id)
      job.endedAt = now()
      job.summary = summary.slice(0, 2000)
      t.spentUsd = d.spent(t)
      save(t)
      // A stop or a pause tells the human; the sub-coordinator hears about it when the human decides.
      if (job.status !== "halted")
        d.notify(t, loadPrompt("tournament/job-ended", { job: job.id, kind, status: job.status, summary: job.summary }))
    })()
    return job
  }

  const counts = (xs: string[]) =>
    Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}))
      .map(([k, n]) => `${n} ${k}`)
      .join(", ")

  return {
    get,
    list: () => d.store.list(),
    running: (id: string) => {
      const t = d.store.get(id)
      return !!t && !!running(t)
    },

    /** A new tournament; the caller opens its conversation and sets `threadId`. */
    create: (input: { preset: string; title?: string; sources?: string[]; idea?: string; limitUsd?: number }) => {
      const p = presetOf(input.preset)
      const sources = uniqueSources(input.sources ?? [])
      if (p.variants === "sources" && !sources.length) throw new Error("this preset needs at least one source")
      if (p.variants === "approaches" && !input.idea?.trim()) throw new Error("this preset needs an idea")
      const id = `t-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`
      const t: Tournament = {
        id,
        preset: p.id,
        title: (
          input.title?.trim() ||
          (p.variants === "sources" ? `${p.title}: ${sources.length} sources` : input.idea!.trim())
        ).slice(0, 80),
        createdAt: now(),
        brief: p.variants === "sources" ? loadPrompt(presetPrompt(p.id, "brief")) : input.idea!.trim(),
        sources,
        status: "running",
        jobs: [],
        reason: null,
        limitUsd: input.limitUsd ?? cfg().limit_usd,
        spentUsd: 0,
        cards: Object.fromEntries(sources.map((s) => [s, { source: s, status: "pending" as const }])),
        variants: {
          [BASELINE]: {
            id: BASELINE,
            label: p.baselineLabel,
            kind: "baseline",
            sources: [],
            skills: [],
            plugins: [],
            instructions: "",
            generation: 0,
            builds: newBuilds(cfg().runs),
          },
        },
        rounds: [],
        games: [],
        generations: [],
        log: [],
      }
      save(t)
      return t
    },
    attach: (id: string, threadId: string) => {
      const t = get(id)
      t.threadId = threadId
      save(t)
      return t
    },

    /** Scout pending sources (default all); `retry` gives failed ones another try. */
    scout: (id: string, sources?: string[], retry = false) => {
      const t = get(id)
      const why = blocked(t)
      if (why) return { error: why }
      const pick = (sources?.length ? sources : t.sources).filter((s) => t.cards[s])
      if (retry) for (const s of pick) if (t.cards[s]!.status === "failed") t.cards[s]!.status = "pending"
      const todo = pick.filter((s) => t.cards[s]!.status === "pending")
      if (!todo.length) return { error: "no pending source to scout" }
      save(t)
      return startJob(id, "scout", todo, async (x) => {
        await pool(todo, cfg().max_parallel_builds, (s) => scout(x, s))
        return `sources: ${counts(todo.map((s) => x.cards[s]!.status))}`
      })
    },

    /** Variants the sub-coordinator wrote (the approaches of a prototypes tournament). */
    addVariants: (id: string, list: { id: string; label: string; approach: string }[]) => {
      const t = get(id)
      const added: string[] = []
      for (const v of list) {
        const vid = sourceId(v.id)
        if (!vid || t.variants[vid]) continue
        t.variants[vid] = {
          id: vid,
          label: v.label.slice(0, 80),
          kind: "approach",
          sources: [],
          skills: [],
          plugins: [],
          instructions: v.approach,
          generation: t.generations.length,
          builds: newBuilds(cfg().runs),
        }
        added.push(vid)
      }
      save(t)
      return { added }
    },

    /** Build every pending build of these variants (default all); `retry` rebuilds failed ones. */
    build: (id: string, variants?: string[], retry = false) => {
      const t = get(id)
      const why = blocked(t)
      if (why) return { error: why }
      const vs = Object.values(t.variants).filter((v) => !variants?.length || variants.includes(v.id))
      if (retry)
        for (const v of vs)
          for (const b of v.builds) if (b.status === "failed" || b.status === "dropped") b.status = "pending"
      const jobs = vs.flatMap((v) => v.builds.filter((b) => b.status === "pending").map((b) => ({ v, b })))
      if (!jobs.length) return { error: "no pending build" }
      save(t)
      return startJob(id, "build", [...new Set(jobs.map((j) => j.v.id))], async (x) => {
        const live = jobs.map(({ v, b }) => ({ v: x.variants[v.id]!, b: x.variants[v.id]!.builds[b.n - 1]! }))
        await pool(live, cfg().max_parallel_builds, ({ v, b }) => buildOne(x, v, b))
        return `builds: ${counts(live.map(({ b }) => b.status))}`
      })
    },

    /** Play a round: these pairs, "baseline" (every variant not yet met by the baseline), else Swiss pairs. */
    round: (id: string, pairs?: [string, string][] | "baseline") => {
      const t = get(id)
      const why = blocked(t)
      if (why) return { error: why }
      const n = openRound(t, pairs === "baseline" ? baselinePairs(t) : pairs)
      if (typeof n === "string") return { error: n }
      const r = get(id).rounds.find((x) => x.n === n)!
      return startJob(
        id,
        "round",
        r.pairs.map(([a, b]) => `${a} vs ${b}`),
        async (x) => {
          await playRound(x, n)
          const games = x.games.filter((g) => g.round === n)
          return `round ${n}: ${games.length} games, ${games.filter((g) => g.score === null).length} without a vote`
        },
      )
    },

    /** Without pairs: the candidates (top variants that beat the baseline) and Jev's fit. With pairs: add the combos. */
    combine: async (id: string, pairs?: [string, string][]) => {
      const t = get(id)
      const c = cfg()
      if (!pairs?.length) {
        const candidates = comboCandidates(t, c.top_k, c.combo_margin)
        const fit = await askCombos(t, candidates)
        return {
          candidates: candidates.map(([a, b]) => ({ a, b, fit: fit[comboId(a, b)] })),
          threshold: c.combo_threshold,
        }
      }
      const n = t.generations.length + 1
      if (n > c.max_generations) return { error: `max_generations (${c.max_generations}) reached` }
      const bad = pairs.flat().filter((v) => !t.variants[v])
      if (bad.length) return { error: `unknown variants: ${bad.join(", ")}` }
      const top = leader(t)
      t.generations.push({
        n,
        proposals: {},
        combos: pairs.map(([a, b]) => comboId(a, b)),
        leaderBefore: top.id,
        ratingBefore: top.rating,
      })
      for (const [a, b] of pairs) t.variants[comboId(a, b)] = combine(t.variants[a]!, t.variants[b]!, n, c.runs)
      log(t, `generation ${n}: ${pairs.map(([a, b]) => comboId(a, b)).join(", ")}`)
      return { generation: n, added: pairs.map(([a, b]) => comboId(a, b)) }
    },

    /** End the tournament with the sub-coordinator's conclusion. */
    finish: (id: string, summary: string) => {
      const t = get(id)
      if (running(t)) return { error: "a job is still running" }
      t.status = "done"
      t.reason = summary.slice(0, 2000)
      t.spentUsd = d.spent(t)
      save(t)
      return { done: true }
    },

    /** The human stopped it: halt the job at once and stop its workers; finished work stays. */
    stop: async (id: string, stopWorkers: () => Promise<void>) => {
      const t = get(id)
      halts.get(id)?.fire("stopped by the human")
      await stopWorkers()
      const fresh = get(id)
      settleInterrupted(fresh)
      fresh.status = "stopped"
      fresh.reason = "stopped by the human"
      save(fresh)
      return t
    },

    /** The human raised the limit: go on (the sub-coordinator is told by the caller). */
    raise: (id: string, limitUsd: number) => {
      const t = get(id)
      t.limitUsd = limitUsd
      t.approvalId = undefined
      if (t.status === "paused") t.status = "running"
      t.reason = null
      save(t)
      return t
    },
    /** The human stopped it at the cost limit. */
    stopAtLimit: (id: string) => {
      const t = get(id)
      t.approvalId = undefined
      t.status = "stopped"
      t.reason = "stopped at the cost limit by the human"
      save(t)
      return t
    },
    /** Resume a stopped tournament (the human's call). */
    reopen: (id: string, limitUsd?: number) => {
      const t = get(id)
      if (limitUsd !== undefined) t.limitUsd = limitUsd
      t.spentUsd = d.spent(t)
      if (t.spentUsd >= t.limitUsd) throw new Error(`raise the limit above $${t.spentUsd.toFixed(2)}`)
      t.status = "running"
      t.reason = null
      t.approvalId = undefined
      save(t)
      return t
    },
    byApproval: (approvalId: string) => d.store.list().find((t) => t.approvalId === approvalId),

    /** At start: jobs a restart cut off are marked interrupted; returns the running tournaments that had one. */
    settleAfterRestart: (): Tournament[] =>
      d.store.list().flatMap((t) => {
        if (!t.jobs.some((j) => j.status === "running")) return []
        settleInterrupted(t)
        save(t)
        return t.status === "running" ? [t] : []
      }),
  }
}

export type Tournaments = ReturnType<typeof makeTournaments>
