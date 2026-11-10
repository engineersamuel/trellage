// Code review gate: Jev picks the review lenses for the diff, one read-only reviewer per lens writes findings,
// a synthesis worker merges them, Jev scores each merged finding, and only the high-value ones go to a fix worker
// and a verify worker. Same shape as security.ts; review workers are started here, so a fix never re-triggers it.
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { noul } from "@typesafe-ai/sdk"
import { decisionsAvailable, systemOne } from "./decide.ts"
import { now, type Auth, type Factory, type Worker } from "./factory.ts"
import { stopAll } from "./security.ts"
import type { Scope } from "./tools.ts"
import { loadPrompt } from "./prompt.ts"
import { factoryConfig, type FactoryConfig } from "./config.ts"

/** Review lenses from the config: id and the focus a reviewer reads the diff through. */
export const lenses = (c: FactoryConfig = factoryConfig()) =>
  Object.entries(c.review.lenses).map(([id, l]) => ({ id, focus: l.focus }))
export type Lens = ReturnType<typeof lenses>[number]
export type LensId = string

/** Reviewer model family. Models per family come from [models.review]; Gemini is reached through copilot-proxy-rs. */
type Family = "claude" | "gpt" | "gemini"

export const familyOf = (model: string | null | undefined): Family | null =>
  /^claude/i.test(model ?? "")
    ? "claude"
    : /^(gpt|o\d)/i.test(model ?? "")
      ? "gpt"
      : /^gemini/i.test(model ?? "")
        ? "gemini"
        : null

/**
 * Frontier reviewer models from the families other than the implementer's (a rubber-duck read), in a fixed order.
 * `gemini: false` when no reviewer can reach Gemini (Copilot or Pi forced for every worker).
 */
export const reviewModels = (
  implementerModel: string | null | undefined,
  gemini = true,
  c: FactoryConfig = factoryConfig(),
): string[] => {
  const own = familyOf(implementerModel)
  return (["gpt", "claude", "gemini"] as Family[])
    .filter((f) => f !== own && (gemini || f !== "gemini"))
    .map((f) => c.models.review[f])
}

/** One reviewer model (synthesis, security): the first other family. SF_REVIEW_MODEL pins one model for every review. */
export const reviewModelFor = (
  implementerModel: string | null | undefined,
  env = process.env.SF_REVIEW_MODEL,
  gemini = true,
  c: FactoryConfig = factoryConfig(),
): string => env?.trim() || reviewModels(implementerModel, gemini, c)[0]!

/** Reviewer i of a round: spread over the other families, so two lenses read with two different frontier models. */
export const lensModel = (
  implementerModel: string | null | undefined,
  i: number,
  gemini = true,
  env = process.env.SF_REVIEW_MODEL,
  c: FactoryConfig = factoryConfig(),
): string => {
  if (env?.trim()) return env.trim()
  const models = reviewModels(implementerModel, gemini, c)
  return models[i % models.length]!
}

/** Gemini reviewers reach copilot-proxy-rs in every SDK: Copilot (proxy auth), Claude and Pi (proxy base URL). */
export const geminiReachable = (_workerHarness: string): boolean => true

/**
 * How a reviewer reaches its model. Gemini goes through copilot-proxy-rs: in the Copilot SDK as BYOK (`auth: proxy`;
 * native Copilot answers "model not available"); Claude and Pi workers already use the proxy, so no change there.
 */
export const reviewerRoute = (
  model: string,
  workerHarness: string,
): { auth?: "proxy"; harness?: { kind: "claude"; profiles: string[] } } =>
  familyOf(model) !== "gemini" || workerHarness === "pi"
    ? {}
    : workerHarness === "claude"
      ? { harness: { kind: "claude", profiles: ["default"] } }
      : { auth: "proxy" }

/** Jev probability per lens; at or above review.lens_threshold the lens runs. At most review.max_lenses, the most
 *  probable first; at least one (review.min_lenses_t2 for tier T2). Without Jev: the first two lenses. */
export const pickLenses = (
  p: Record<string, number> | null,
  tier?: string,
  c: FactoryConfig = factoryConfig(),
): LensId[] => {
  const ids = lenses(c).map((l) => l.id)
  if (!p) return ids.slice(0, 2)
  const ranked = ids.sort((a, b) => (p[b] ?? 0) - (p[a] ?? 0))
  const chosen = ranked.filter((id) => (p[id] ?? 0) >= c.review.lens_threshold).slice(0, c.review.max_lenses)
  const min = tier === "T2" ? c.review.min_lenses_t2 : 1
  return chosen.length >= min ? chosen : ranked.slice(0, min)
}

export type ReviewFinding = {
  id: string
  title: string
  file: string
  severity: string
  problem: string
  fix: string
  lenses: string[]
}
export type ScoredFinding = ReviewFinding & { real: number | null; worth: number | null; keep: boolean; reason: string }

/** One untrusted findings.json item after the title/problem check. */
type Raw = { title: string; problem: string; file?: unknown; severity?: unknown; fix?: unknown; lenses?: unknown }

/** findings.json: an array of {title, file, severity, problem, fix, lenses?}. Malformed input yields []. */
export const parseReviewFindings = (text: string): ReviewFinding[] => {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  return doc
    .filter((r): r is Raw => typeof r?.title === "string" && typeof r?.problem === "string")
    .map((r, i) => ({
      id: `cr${i + 1}`,
      title: r.title,
      file: typeof r.file === "string" ? r.file : "unknown",
      severity: typeof r.severity === "string" ? r.severity : "unknown",
      problem: r.problem,
      fix: typeof r.fix === "string" ? r.fix : "",
      lenses: Array.isArray(r.lenses) ? r.lenses.map(String) : [],
    }))
}

/** Keep a finding only when both scores clear their thresholds; no score (Jev down) keeps high and critical only. */
export const score = (
  f: ReviewFinding,
  real: number | undefined,
  worth: number | undefined,
  c: FactoryConfig = factoryConfig(),
): ScoredFinding => {
  const { real_threshold: REAL, worth_threshold: WORTH, min_severity } = c.review
  if (real === undefined || worth === undefined) {
    const keep = /^(high|critical)$/i.test(f.severity)
    return {
      ...f,
      real: null,
      worth: null,
      keep,
      reason: `Jev unavailable; ${keep ? "kept: high severity" : "dropped: not high severity"}`,
    }
  }
  const severe = (min_severity as readonly string[]).includes(f.severity.toLowerCase())
  const keep = severe && real >= REAL && worth >= WORTH
  return {
    ...f,
    real,
    worth,
    keep,
    reason: `real ${real.toFixed(2)} (>= ${REAL}), worth ${worth.toFixed(2)} (>= ${WORTH}), severity ${f.severity}${severe ? "" : " (< medium)"}: ${keep ? "kept" : "dropped"}`,
  }
}

const askLenses = async (state: Record<string, unknown>, c: FactoryConfig): Promise<Record<string, number> | null> => {
  if (!decisionsAvailable()) return null
  try {
    const res = await systemOne({
      state: JSON.stringify(state),
      questions: Object.fromEntries(lenses(c).map((l) => [l.id, noul(loadPrompt("jev/lens", { focus: l.focus }))])),
    })
    return Object.fromEntries(
      lenses(c).flatMap((l) => {
        const p = res.answers[l.id]?.noul
        return typeof p === "number" ? [[l.id, p]] : []
      }),
    )
  } catch {
    return null
  }
}

export const scoreFindings = async (
  findings: ReviewFinding[],
  request: string,
  c: FactoryConfig = factoryConfig(),
): Promise<ScoredFinding[]> => {
  if (!decisionsAvailable() || !findings.length) return findings.map((f) => score(f, undefined, undefined, c))
  try {
    const res = await systemOne({
      state: JSON.stringify({ request, findings }),
      questions: Object.fromEntries(
        findings.flatMap((f) => [
          [`${f.id}_real`, noul(loadPrompt("jev/finding-real", { id: f.id, title: f.title }))],
          [`${f.id}_worth`, noul(loadPrompt("jev/finding-worth", { id: f.id, title: f.title }))],
        ]),
      ),
    })
    return findings.map((f) => score(f, res.answers?.[`${f.id}_real`]?.noul, res.answers?.[`${f.id}_worth`]?.noul, c))
  } catch {
    return findings.map((f) => score(f, undefined, undefined))
  }
}

export type CodeReviewStatus =
  | "started"
  | "reviewing"
  | "synthesizing"
  | "scored"
  | "fixing"
  | "verifying"
  | "done"
  | "failed"
export type CodeReview = {
  id: string
  scopeId: string
  threadId: string | null
  workdir: string
  status: CodeReviewStatus
  lenses: LensId[]
  lensProbabilities: Record<string, number> | null
  findings: ScoredFinding[]
  workerIds: string[]
  workerId?: string
  error?: string
  at: number
}

const unfinished = (r: CodeReview) => r.status !== "done" && r.status !== "failed"
export const pendingCodeReview = (reviews: Iterable<CodeReview>, scopeId: string): CodeReview | undefined =>
  [...reviews].find((r) => r.scopeId === scopeId && unfinished(r))
export const codeReviewIn = (reviews: Iterable<CodeReview>, workdir: string): CodeReview | undefined =>
  [...reviews].find((r) => path.resolve(r.workdir) === path.resolve(workdir) && unfinished(r))
/** The newest review of the scope, finished after `since` (the last implement). */
export const codeReviewDoneSince = (reviews: Iterable<CodeReview>, scopeId: string, since: number): boolean =>
  [...reviews].some((r) => r.scopeId === scopeId && r.status === "done" && r.at >= since)

const timeoutMs = () => Number(process.env.SF_SECURITY_TIMEOUT_MS) || 20 * 60_000
const idleOrThrow = async (w: Worker, what: string) => {
  if (!(await w.waitIdle(timeoutMs()))) throw new Error(`${what} worker ${w.id} timed out`)
  if (w.status === "error") throw new Error(`${what} worker ${w.id} failed: ${w.lastError}`)
}

const FINDING_SCHEMA = `a JSON array; each item {"title","file":"path:line","severity":"low|medium|high|critical","problem","fix"}; [] when there is nothing material`

export const lensTask = (lens: Lens, base: string, criteria: string[], out: string) =>
  loadPrompt("tasks/lens", {
    base,
    focus: lens.focus,
    criteria: criteria.map((c, i) => `AC-${i + 1}: ${c}`).join("\n"),
    out,
    schema: FINDING_SCHEMA,
  })

export const synthesisTask = (inputs: string[], out: string) =>
  loadPrompt("tasks/synthesis", {
    inputs: inputs.join(", "),
    out,
    schema: FINDING_SCHEMA.replace("}", ',"lenses":[...]}'),
  })

const list = (fs: ScoredFinding[]) =>
  fs.map((x) => `- [${x.severity}] ${x.title} (${x.file}): ${x.problem}${x.fix ? ` Fix: ${x.fix}` : ""}`).join("\n")

/**
 * Run the code review of the scope's worktree diff against `base`. Never throws: failures land in the review.
 * `fixWith` lets the caller reuse the idle implement worker; otherwise a new implement worker fixes.
 */
export const codeReview = async (
  f: Factory,
  scope: Scope,
  opts: {
    workdir: string
    base: string
    auth: Auth
    request: string
    criteria: string[]
    diffStat: string
    tier?: string
    lenses?: LensId[]
    implementerModel?: string | null
    config?: FactoryConfig
    onFindings?: (kept: number, dropped: number) => void
  },
): Promise<CodeReview> => {
  const c = opts.config ?? factoryConfig()
  const r: CodeReview = {
    id: `cr-${crypto.randomUUID().slice(0, 8)}`,
    scopeId: scope.id,
    threadId: scope.threadId,
    workdir: opts.workdir,
    status: "started",
    lenses: [],
    lensProbabilities: null,
    findings: [],
    workerIds: [],
    at: Date.now(),
  }
  const set = (patch: Partial<CodeReview>) => {
    Object.assign(r, patch, { at: Date.now() })
    f.codeReviews.set(r.id, r)
    f.publish(scope.id, "factory.code_review", null, now(), { ...r })
  }
  set({})
  const started: string[] = []
  const gemini = geminiReachable(f.settings.workers.harness)
  const spawn = async (name: string, step: string, task: string, model?: string) => {
    const route = model ? reviewerRoute(model, f.settings.workers.harness) : {}
    const w = await f.spawn({
      name,
      role: "worker",
      auth: opts.auth,
      step,
      task,
      owner: scope.id,
      workdir: opts.workdir,
      ...(model ? { model } : {}),
      ...route,
    })
    started.push(w.id)
    set({ workerIds: [...r.workerIds, w.id], workerId: w.id })
    return w
  }
  try {
    const probabilities = await askLenses({ request: opts.request, criteria: opts.criteria, diff: opts.diffStat }, c)
    const chosen = opts.lenses ?? pickLenses(probabilities, opts.tier, c)
    set({ status: "reviewing", lenses: chosen, lensProbabilities: probabilities })
    const dir = path.join(f.root, r.id)
    mkdirSync(dir, { recursive: true })
    const reviewers = await Promise.all(
      chosen.map((id, i) => {
        const lens = lenses(c).find((l) => l.id === id)!
        return spawn(
          `review-${id}`,
          "review",
          lensTask(lens, opts.base, opts.criteria, path.join(dir, `${id}.json`)),
          lensModel(opts.implementerModel, i, gemini, undefined, c),
        )
      }),
    )
    await Promise.all(reviewers.map((w) => idleOrThrow(w, "code review")))
    const inputs = chosen.map((id) => path.join(dir, `${id}.json`))
    let merged: ReviewFinding[]
    if (inputs.length > 1) {
      set({ status: "synthesizing" })
      const synth = await spawn(
        "review-synthesis",
        "synthesis",
        synthesisTask(inputs, path.join(dir, "merged.json")),
        reviewModelFor(opts.implementerModel, undefined, gemini, c),
      )
      await idleOrThrow(synth, "review synthesis")
      merged = parseReviewFindings(readFileSync(path.join(dir, "merged.json"), "utf8"))
    } else merged = parseReviewFindings(readFileSync(inputs[0]!, "utf8")).map((x) => ({ ...x, lenses: chosen }))
    const scored = await scoreFindings(merged, opts.request, c)
    set({ status: "scored", findings: scored })
    const kept = scored.filter((x) => x.keep)
    opts.onFindings?.(kept.length, scored.length - kept.length)
    for (const x of scored.filter((y) => !y.keep))
      console.log(`[code-review] ${r.id} dropped ${x.id} "${x.title}": ${x.reason}`)
    if (kept.length) {
      const fixer = await spawn(
        "review-fix",
        "implement",
        loadPrompt("tasks/review-fix", { base: opts.base, findings: list(kept) }),
      )
      set({ status: "fixing" })
      await idleOrThrow(fixer, "review fix")
      const verifier = await spawn(
        "review-verify",
        "verify",
        loadPrompt("tasks/review-verify", { findings: list(kept) }),
      )
      set({ status: "verifying" })
      await idleOrThrow(verifier, "review verify")
    }
    set({ status: "done" })
  } catch (e) {
    set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
  } finally {
    await stopAll(started, (id) => f.stop(id))
  }
  return r
}
