// Automatic security review after every implement step: audit the diff, triage with Jev, fix what is kept.
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { choice } from "@typesafe-ai/sdk"
import { decisionsAvailable, systemOne } from "./decide.ts"
import { now, type Auth, type Factory, type Worker } from "./factory.ts"
import type { Scope } from "./tools.ts"
import { loadPrompt } from "./prompt.ts"
import { factoryConfig } from "./config.ts"
import { awaitGateWorker } from "./gateWorker.ts"

/** A security-audit findings.json record worth acting on (rejected records are dropped). */
export type Finding = {
  id: string
  title: string
  severity: string
  file: string
  summary: string
  verdict: "confirmed" | "needs_validation"
}
export type Verdict = { verdict: "keep" | "discard"; reason: string; confidence: number }
/** A finding after Jev triage. `audit` is the skill's own verdict. */
export type TriagedFinding = Omit<Finding, "verdict"> & { audit: Finding["verdict"] } & Verdict

export type ReviewStatus = "started" | "findings" | "triaged" | "fixing" | "verifying" | "done" | "failed"
export type SecurityReview = {
  id: string
  scopeId: string
  threadId: string | null
  implementWorkerId: string
  /** Worktree the review diffs and fixes in. */
  workdir?: string
  /** Auth every review worker runs with, captured when the review starts. */
  auth?: Auth
  /** Worker the review is currently waiting on (reviewer, fix, or verify). */
  workerId?: string
  status: ReviewStatus
  model: string
  findings: TriagedFinding[]
  error?: string
  at: number
}

const KEPT = new Set(["confirmed", "needs_validation"])

/** One untrusted findings.json item of the security-audit skill. */
type RawFinding = {
  verdict: Finding["verdict"]
  fingerprint: string
  title: string
  severity?: { overall_severity?: unknown }
  description?: unknown
  evidence?: { file?: unknown; line?: unknown }[]
  trace?: { file?: unknown; line?: unknown }[]
}

const where = (r: RawFinding): string => {
  const loc = r.evidence?.[0] ?? r.trace?.[0]
  return typeof loc?.file === "string" ? `${loc.file}${typeof loc.line === "number" ? `:${loc.line}` : ""}` : "unknown"
}

/** Parse the skill's findings.json. Malformed input yields []. */
export const parseFindings = (text: string): Finding[] => {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(doc)) return []
  return doc
    .filter(
      (r): r is RawFinding => KEPT.has(r?.verdict) && typeof r.fingerprint === "string" && typeof r.title === "string",
    )
    .map((r) => ({
      id: r.fingerprint,
      title: r.title,
      severity: typeof r.severity?.overall_severity === "string" ? r.severity.overall_severity : "unknown",
      file: where(r),
      summary: typeof r.description === "string" ? r.description : "",
      verdict: r.verdict,
    }))
}

/** Triage answers and the verdict code acts on. What Jev reads per answer is prompts/jev/security/<key>.md. */
const CHOICES: Record<string, { verdict: Verdict["verdict"]; reason: string }> = {
  keep: {
    verdict: "keep",
    reason: "real, in-scope risk",
  },
  discard_false_positive: {
    verdict: "discard",
    reason: "false positive",
  },
  discard_out_of_scope: {
    verdict: "discard",
    reason: "out of scope of this diff",
  },
  discard_low_risk: {
    verdict: "discard",
    reason: "low risk",
  },
}

/** Map a Jev choice key to a verdict. Unknown keys are kept (fail safe). */
export const toVerdict = (choiceKey: string, confidence: number): Verdict => {
  const c = CHOICES[choiceKey]
  return c
    ? { verdict: c.verdict, reason: c.reason, confidence }
    : { verdict: "keep", reason: `unknown triage answer '${choiceKey}'; kept (fail safe)`, confidence }
}

const withVerdict = ({ verdict: audit, ...f }: Finding, v: Verdict): TriagedFinding => ({ ...f, audit, ...v })

/** Turn Jev's per-finding answers (keyed f0, f1, ...) into verdicts. A missing answer keeps the finding. */
export const fromAnswers = (
  findings: Finding[],
  answers: Record<string, { choice?: string; confidence?: number } | undefined>,
): TriagedFinding[] =>
  findings.map((f, i) => withVerdict(f, toVerdict(String(answers[`f${i}`]?.choice), answers[`f${i}`]?.confidence ?? 0)))

const askJev = async (findings: Finding[]) => {
  const criteria = Object.fromEntries(Object.keys(CHOICES).map((k) => [k, loadPrompt(`jev/security/${k}`)]))
  const res = await systemOne({
    state: JSON.stringify(findings),
    questions: Object.fromEntries(
      findings.map((f, i) => [
        `f${i}`,
        choice(loadPrompt("jev/security-triage", { id: f.id, title: f.title }), criteria),
      ]),
    ),
  })
  return res.answers
}

/** Ask Jev which findings to keep. No key or any error keeps all of them. */
export const triage = async (findings: Finding[]): Promise<TriagedFinding[]> => {
  const keepAll = (why: string) =>
    findings.map((f) => withVerdict(f, { verdict: "keep", reason: `${why}; kept (fail safe)`, confidence: 0 }))
  if (!decisionsAvailable()) return keepAll("Jev unavailable")
  if (findings.length === 0) return []
  return askJev(findings).then(
    (answers) => fromAnswers(findings, answers),
    (e) => keepAll(`Jev error: ${e instanceof Error ? e.message : e}`),
  )
}

const unfinished = (r: SecurityReview) => r.status !== "done" && r.status !== "failed"

/** The scope's unfinished review, if any. The coordinator waits for it before the next step. */
export const pendingReview = (reviews: Iterable<SecurityReview>, scopeId: string): SecurityReview | undefined =>
  [...reviews].find((r) => r.scopeId === scopeId && unfinished(r))

/** The unfinished review in this worktree: no worker may start there until it is done. */
export const reviewIn = (reviews: Iterable<SecurityReview>, workdir: string): SecurityReview | undefined =>
  [...reviews].find(
    (r) => r.workdir !== undefined && path.resolve(r.workdir) === path.resolve(workdir) && unfinished(r),
  )

/** SF_SECURITY_MODEL, unless blank; then Jev's pick; then the default. */
export const pickModel = (env: string | undefined, routed: string | undefined, fallback: string): string =>
  env?.trim() || routed || fallback

/** Stop every worker; a worker that is already gone is fine. */
export const stopAll = async (ids: Iterable<string>, stop: (id: string) => Promise<void>): Promise<void> => {
  await Promise.all([...ids].map((id) => stop(id).catch(() => {})))
}

/** Start a gate worker and wait for it; a stuck one is replaced (gateWorker.ts). */
type Wait = (start: () => Promise<Worker>, what: string) => Promise<Worker>

const list = (fs: TriagedFinding[]) =>
  fs.map((x) => `- [${x.severity}] ${x.title} (${x.file}, ${x.id}): ${x.summary}`).join("\n")

type Set = (patch: Partial<SecurityReview>) => void
type Spawn = (name: string, step: string, task: string, id?: string) => Promise<Worker>

/** One log line per discarded finding, with Jev's reason. */
export const discardLines = (reviewId: string, findings: TriagedFinding[]): string[] =>
  findings
    .filter((x) => x.verdict === "discard")
    .map((x) => `[security] ${reviewId} discarded ${x.id} "${x.title}": ${x.reason} (${x.confidence})`)

/** Where to review: the scope's worktree and base, else the run's. */
const target = (f: Factory, scope: Scope) => {
  const workdir = scope.workdir ?? f.run?.worktree
  const base = scope.workdir ? scope.base : f.run?.base
  if (!workdir || !base) throw new Error("no worktree and base commit to diff")
  return { workdir, base }
}

/** Reviewer worker: audit the diff, read its findings.json, stop it. */
const audit = async (f: Factory, spawn: Spawn, set: Set, base: string, wait: Wait): Promise<Finding[]> => {
  const id = `w-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
  const out = path.join(f.root, id, "security-audit")
  mkdirSync(out, { recursive: true })
  let n = 0
  const reviewer = await wait(async () => {
    // A fresh worker after a stuck one gets its own id; it writes to the same output folder.
    const w = await spawn(
      "security-review",
      "security",
      loadPrompt("tasks/security-audit", { base, out }),
      n++ ? undefined : id,
    )
    set({ workerId: w.id })
    return w
  }, "security review")
  const found = parseFindings(readFileSync(path.join(out, "findings.json"), "utf8"))
  await f.stop(reviewer.id).catch(() => {})
  return found
}

/** Fix worker (implement) for the kept findings, then a verify worker. */
const fixAndVerify = async (spawn: Spawn, set: Set, kept: TriagedFinding[], base: string, wait: Wait) => {
  await wait(async () => {
    const w = await spawn("security-fix", "implement", loadPrompt("tasks/security-fix", { base, findings: list(kept) }))
    set({ status: "fixing", workerId: w.id })
    return w
  }, "security fix")
  await wait(async () => {
    const w = await spawn("security-verify", "verify", loadPrompt("tasks/security-verify", { findings: list(kept) }))
    set({ status: "verifying", workerId: w.id })
    return w
  }, "security verify")
}

/** Review workers run with the picked model. */
const pickReviewModel = async (f: Factory) => {
  const env = process.env.SF_SECURITY_MODEL
  const routed = env?.trim()
    ? undefined
    : (await f.routeModel("security audit / vulnerability review of a code diff"))?.id
  return pickModel(env, routed, f.defaultModel)
}

const run = async (f: Factory, scope: Scope, r: SecurityReview, set: Set, pinned?: string) => {
  const { workdir, base } = target(f, scope)
  const auth = r.auth
  if (!auth)
    throw new Error(
      `no auth for the review: implement worker ${r.implementWorkerId} and coordinator ${scope.id} are gone`,
    )
  const model = pinned ?? (await pickReviewModel(f))
  set({ model })
  const started: string[] = []
  const spawn: Spawn = async (name, step, task, id) => {
    const w = await f.spawn({
      ...(id ? { id } : {}),
      name,
      role: "worker",
      auth,
      model,
      step,
      task,
      owner: scope.id,
      workdir,
    })
    started.push(w.id)
    return w
  }
  try {
    const wait: Wait = (start, what) => awaitGateWorker(start, what, (id) => f.stop(id), factoryConfig())
    const found = await audit(f, spawn, set, base, wait)
    set({
      status: "findings",
      findings: found.map((x) => withVerdict(x, { verdict: "keep", reason: "awaiting triage", confidence: 0 })),
    })
    const triaged = await triage(found)
    set({ status: "triaged", findings: triaged })
    for (const line of discardLines(r.id, triaged)) console.log(line)
    const kept = triaged.filter((t) => t.verdict === "keep")
    if (kept.length) await fixAndVerify(spawn, set, kept, base, wait)
  } finally {
    await stopAll(started, (id) => f.stop(id))
  }
}

/**
 * Review the diff an implement worker left in the scope's worktree. Never throws: failures land in the review.
 * Review workers use the implement worker's auth (its account wrote the diff), else the coordinator's, else `scopeAuth`
 * (the coordinator's auth captured when the implement worker was spawned).
 */
export const securityReview = async (
  f: Factory,
  scope: Scope,
  implementWorkerId: string,
  scopeAuth?: Auth,
  model?: string,
): Promise<SecurityReview> => {
  const r: SecurityReview = {
    id: `sr-${crypto.randomUUID().slice(0, 8)}`,
    scopeId: scope.id,
    threadId: scope.threadId,
    implementWorkerId,
    status: "started",
    model: "",
    findings: [],
    at: Date.now(),
  }
  const set: Set = (patch) => {
    Object.assign(r, patch, { at: Date.now() })
    f.securityReviews.set(r.id, r)
    f.publish(scope.id, "factory.security_review", null, now(), { ...r })
  }
  // Synchronous first transition: the next_step and spawn_worker gates see the review before any await.
  const workdir = scope.workdir ?? f.run?.worktree
  const auth = f.workers.get(implementWorkerId)?.auth ?? f.workers.get(scope.id)?.auth ?? scopeAuth
  set({ ...(workdir ? { workdir } : {}), ...(auth ? { auth } : {}) })
  try {
    await run(f, scope, r, set, model)
    set({ status: "done" })
  } catch (e) {
    set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
  }
  return r
}
