// Tournament evidence: screenshots (Playwright CLI), Jev image checks, and pairwise frontier judges.
// Jev answers fast yes/no checks on a screenshot and filters broken builds; it is near chance when two good designs
// meet, so frontier models through copilot-proxy-rs score every design aspect (both orders, see tournament.ts voteValue).
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { catalogNames, loadPrompt, promptFile } from "./prompt.ts"
import { jevKey } from "./steps.ts"
import type { chatUsage } from "./costs.ts"
import type { BuildAudit, Rubric, Shot, Vote } from "./tournament.ts"
import type { ShotSpec } from "./tournamentPresets.ts"

const run = promisify(execFile)

/** The pages the preset asks for that a build did not write. */
export const missingPages = (site: string, pages: string[]): string[] =>
  pages.filter((p) => !existsSync(path.join(site, p)))

/** Serve a build folder over http on a free port while `f` runs (ES modules and fetch fail on file://). */
export const serveBuild = async <A>(site: string, f: (base: string) => Promise<A>): Promise<A> => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "") || "index.html"
      const full = path.resolve(site, rel)
      if (full !== site && !full.startsWith(`${site}${path.sep}`)) return new Response("no", { status: 403 })
      return existsSync(full) ? new Response(Bun.file(full)) : new Response("not found", { status: 404 })
    },
  })
  try {
    return await f(`http://127.0.0.1:${server.port}`)
  } finally {
    server.stop(true)
  }
}

export type AuditOptions = {
  /** Folder of the Playwright library (node_modules/playwright). */
  playwrightLib: string
  /** axe-core's axe.min.js. */
  axe: string
  sizes: Record<ShotSpec["size"], [number, number]>
}

/**
 * Screenshots and an objective audit of one build (scripts/buildAudit.cjs, Node + Playwright): every page after it
 * settled (network idle, fonts, animations done, reveal-on-scroll content scrolled through), JPEG; a spec with
 * `full` shoots the whole page. Plus axe WCAG AA, JS errors, overflow at 320 px and hover/press/focus feedback.
 */
export const captureAndAudit = (
  site: string,
  outDir: string,
  prefix: string,
  specs: ShotSpec[],
  pages: string[],
  o: AuditOptions,
) =>
  serveBuild(site, async (base) => {
    mkdirSync(outDir, { recursive: true })
    const shots = specs.map((s) => ({
      page: s.page,
      size: o.sizes[s.size],
      full: !!s.full,
      file: path.join(outDir, `${prefix}-${s.page.replace(/\.html$/, "")}-${s.size}${s.full ? "-full" : ""}.jpg`),
      viewport: s.viewport,
    }))
    const { stdout } = await run(
      "node",
      [
        path.join(import.meta.dir, "..", "scripts", "buildAudit.cjs"),
        o.playwrightLib,
        o.axe,
        base,
        JSON.stringify(pages),
        JSON.stringify(shots),
      ],
      { timeout: 600_000, maxBuffer: 16 << 20 },
    )
    const out = JSON.parse(stdout) as { pages: BuildAudit["pages"]; shots: { page: string; file: string }[] }
    const viewportOf = (page: string, file: string) =>
      shots.find((s) => s.page === page && file.startsWith(s.file.replace(/\.jpg$/, "")))?.viewport ?? "desktop"
    return {
      // A whole-page spec comes back as several tiles (-1, -2, ...).
      shots: out.shots.map((s): Shot => ({ page: s.page, viewport: viewportOf(s.page, s.file), file: s.file })),
      audit: { pages: out.pages } satisfies BuildAudit,
    }
  })

const JEV_URL = "https://api.typesafe.ai/v1/systemone"

/**
 * Jev pass probability per check (`<checks>/<id>.md`, e.g. tournament/ui-skills/checks) on the first desktop and the
 * first phone shot of the first page, with the brief in the state. Images go as multipart parts; the danger-zone
 * header turns image input on (docs.typesafe.ai/images).
 */
export const jevChecks = async (
  shots: Shot[],
  checks: string,
  brief: string,
  timeoutMs = 60_000,
): Promise<Record<string, number>> => {
  const key = jevKey()
  if (!key) throw new Error("Jev unavailable: no TYPESAFE_API_KEY")
  const first = shots[0]?.page
  const desktop = shots.find((s) => s.page === first && s.viewport === "desktop")
  const mobile = shots.find((s) => s.page === first && s.viewport === "mobile")
  if (!desktop || !mobile) throw new Error("no desktop and phone screenshots of the first page")
  const ref = { desktop: `img-desktop-${crypto.randomUUID()}`, mobile: `img-mobile-${crypto.randomUUID()}` }
  const questions = Object.fromEntries(
    catalogNames(checks).map((id) => [id, { type: "noul", instructions: loadPrompt(`${checks}/${id}`) }]),
  )
  const body = new FormData()
  body.append(
    "request",
    new Blob(
      [
        JSON.stringify({
          model: "jev-latest",
          state: { brief: brief.slice(0, 6000), desktop: ref.desktop, mobile: ref.mobile },
          assets: {
            [ref.desktop]: { type: "image", part: "desktop" },
            [ref.mobile]: { type: "image", part: "mobile" },
          },
          questions,
        }),
      ],
      { type: "application/json" },
    ),
  )
  const part = (f: string) => {
    const jpg = /\.jpe?g$/i.test(f)
    return [
      new Blob([readFileSync(f)], { type: jpg ? "image/jpeg" : "image/png" }),
      jpg ? "shot.jpg" : "shot.png",
    ] as const
  }
  body.append("desktop", ...part(desktop.file))
  body.append("mobile", ...part(mobile.file))
  const r = await fetch(JEV_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "TypeSafe-Danger-Zone-Images": "true" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Jev ${r.status}: ${text.slice(0, 300)}`)
  const answers = (JSON.parse(text) as { answers: Record<string, { noul: number }> }).answers
  return Object.fromEntries(Object.keys(questions).map((id) => [id, answers[id]?.noul ?? 0]))
}

/** The checks' names, so the UI can label them. */
export const checkNames = (checks: string): Record<string, string> =>
  Object.fromEntries(catalogNames(checks).map((id) => [id, String(promptFile(`${checks}/${id}`).meta.label ?? id)]))

type ChatReply = { choices?: { message?: { content?: string | null } }[] } & Parameters<typeof chatUsage>[1]
type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }

const dataUrl = (file: string) =>
  `data:image/${/\.jpe?g$/i.test(file) ? "jpeg" : "png"};base64,${readFileSync(file).toString("base64")}`
const label = (s: Shot) =>
  `${s.page.replace(/\.html$/, "")} page, ${s.viewport}${/-full-\d+\.jpe?g$/.test(s.file) ? ` (whole page, part ${s.file.match(/-full-(\d+)\./)![1]})` : /-home\.(png|jpe?g)$/.test(s.file) ? " (tall)" : ""}`

/** The judge's JSON: the first `{` from which the text up to the last `}` parses with scores for A and B. */
export const parseJudge = (text: string, aspects: readonly string[]): { reason: string; A: Rubric; B: Rubric } => {
  const end = text.lastIndexOf("}") + 1
  for (let i = text.indexOf("{"); i >= 0 && i < end; i = text.indexOf("{", i + 1)) {
    try {
      const j = JSON.parse(text.slice(i, end)) as {
        reason?: string
        scores?: Record<string, Record<string, number>>
      }
      if (typeof j.scores?.A !== "object" || typeof j.scores?.B !== "object") continue
      const rubric = (side: string): Rubric =>
        Object.fromEntries(
          aspects.flatMap((k) => {
            const n = Number(j.scores?.[side]?.[k])
            return Number.isFinite(n) && n >= 1 && n <= 10 ? [[k, n]] : []
          }),
        )
      const scored = { reason: String(j.reason ?? "").slice(0, 600), A: rubric("A"), B: rubric("B") }
      if (!Object.keys(scored.A).length || !Object.keys(scored.B).length) continue
      return scored
    } catch {}
  }
  throw new Error(`no judge JSON in: ${text.slice(-300)}`)
}

export type JudgeDeps = {
  /** Most images per request, by model (e.g. Gemini accepts 10); unlisted models get all shots. */
  maxImages?: Record<string, number>
  /** Measured facts per side (auditSummary), shown after its screenshots. */
  facts?: { A: string; B: string }
  proxyUrl: string
  /** The rendered judge prompt (tournament/<preset>/judge). */
  prompt: string
  aspects: readonly string[]
  maxTokens: number
  timeoutMs: number
  recordUsage: (model: string, reply: ChatReply) => void
}

/**
 * At most `max` shots, the same choice for every build: the first shot of each page (in order) comes first, then the
 * extra tiles of whole pages, so a model with an image limit still sees every page.
 */
export const fitShots = (shots: readonly Shot[], max: number): Shot[] => {
  if (shots.length <= max) return [...shots]
  const seen = new Set<string>()
  const primary = shots.filter((s) => !seen.has(s.page) && seen.add(s.page))
  const extra = shots.filter((s) => !primary.includes(s))
  const keep = new Set([...primary, ...extra].slice(0, max))
  return shots.filter((s) => keep.has(s))
}

/** Images per request a model accepts when no limit is configured and it refuses a request as too big. */
const FALLBACK_MAX_IMAGES = 10

/** One judge, one order: left is "A", right is "B"; `facts` are the measured facts of left and right. */
const judgeOnce = async (model: string, left: Shot[], right: Shot[], d: JudgeDeps, facts?: [string, string]) => {
  const limit = d.maxImages?.[model]
  try {
    return await judgeRequest(model, left, right, d, facts, limit)
  } catch (e) {
    // A model that refuses the request as too big (400 or 413) gets one retry with fewer images on both sides.
    if (limit === undefined && e instanceof JudgeHttpError && (e.status === 400 || e.status === 413))
      return judgeRequest(model, left, right, d, facts, FALLBACK_MAX_IMAGES)
    throw e
  }
}

class JudgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const judgeRequest = async (
  model: string,
  allLeft: Shot[],
  allRight: Shot[],
  d: JudgeDeps,
  facts: [string, string] | undefined,
  maxImages: number | undefined,
) => {
  // Both sides get the same number of images.
  const perSide = maxImages === undefined ? Infinity : Math.floor(maxImages / 2)
  const left = fitShots(allLeft, perSide)
  const right = fitShots(allRight, perSide)
  const side = (name: string, shots: Shot[], fact?: string): Part[] => [
    ...shots.flatMap((s) => [
      { type: "text" as const, text: `Design ${name}: ${label(s)}` },
      { type: "image_url" as const, image_url: { url: dataUrl(s.file) } },
    ]),
    ...(fact ? [{ type: "text" as const, text: `Design ${name}, measured in a browser:\n${fact}` }] : []),
  ]
  const r = await fetch(`${d.proxyUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(d.timeoutMs),
    body: JSON.stringify({
      model,
      max_tokens: d.maxTokens,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: d.prompt }, ...side("A", left, facts?.[0]), ...side("B", right, facts?.[1])],
        },
      ],
    }),
  })
  const text = await r.text()
  if (!r.ok) throw new JudgeHttpError(r.status, `${model} ${r.status}: ${text.slice(0, 300)}`)
  const reply = JSON.parse(text) as ChatReply
  d.recordUsage(model, reply)
  return parseJudge(reply.choices?.[0]?.message?.content ?? "", d.aspects)
}

/** A reason written for the swapped order, with "A" and "B" swapped back. */
export const swapSides = (text: string): string => text.replace(/\b[AB]\b/g, (m) => (m === "A" ? "B" : "A"))

/** One judge's vote on A vs B: both orders, scores mapped back to A and B. */
export const judgePair = async (model: string, a: Shot[], b: Shot[], d: JudgeDeps): Promise<Vote> => {
  try {
    const f = d.facts
    const [ab, swapped] = await Promise.all([
      judgeOnce(model, a, b, d, f && [f.A, f.B]),
      judgeOnce(model, b, a, d, f && [f.B, f.A]),
    ])
    return {
      judge: model,
      scores: [
        { A: ab.A, B: ab.B },
        { A: swapped.B, B: swapped.A },
      ],
      reasons: [ab.reason, swapSides(swapped.reason)],
    }
  } catch (e) {
    return { judge: model, scores: [], reasons: [], error: e instanceof Error ? e.message : String(e) }
  }
}
