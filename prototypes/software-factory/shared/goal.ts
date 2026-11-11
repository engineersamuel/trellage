// Factory goal specs: one test case of the self-improve loop (a prompt for a repo and what the run must show).
// The UI form, the coordinator's /api/goals and `sf goal` all decode with this one Schema, and `sf goal run`
// scores a run with `goalUnmet`, so the three never disagree.
import { Effect, Exit, Schema } from "effect"

const withDefault = <S extends Schema.Top>(value: S["Encoded"]) =>
  Schema.withDecodingDefaultKey<S>(Effect.succeed(value))

export const ChecksState = Schema.Literals(["SUCCESS", "PENDING", "FAILURE", "NONE"])
export type ChecksState = typeof ChecksState.Type

/** How often a step must run: at least `min` (default 1), at most `max` when set. */
export const StepCount = Schema.Struct({
  min: Schema.Number.pipe(withDefault(1)),
  max: Schema.optionalKey(Schema.Number),
})
export type StepCount = typeof StepCount.Type

export const PrExpect = Schema.Struct({
  state: Schema.String.pipe(withDefault("OPEN")),
  /** Omit when the repo has no CI. */
  checks: Schema.optionalKey(ChecksState),
  /** Branch the PR must target; defaults to the goal's base. */
  base: Schema.optionalKey(Schema.String),
  /** Text the PR body must contain, e.g. proof output. */
  bodyIncludes: Schema.Array(Schema.String).pipe(withDefault([])),
  /** Files the PR must not change. */
  untouched: Schema.Array(Schema.String).pipe(withDefault([])),
})
export type PrExpect = typeof PrExpect.Type

/** What the SDLC record must show: every criterion proven, gates that must have run, gates that must have been skipped. */
export const SdlcExpect = Schema.Struct({
  criteriaProven: Schema.Boolean.pipe(withDefault(true)),
  gatesRun: Schema.Array(Schema.String).pipe(withDefault([])),
  gatesSkipped: Schema.Array(Schema.String).pipe(withDefault([])),
  /** Highest risk tier allowed (T0 < T1 < T2); omit for any. */
  maxTier: Schema.optionalKey(Schema.Literals(["T0", "T1", "T2"])),
})
export type SdlcExpect = typeof SdlcExpect.Type

/** One fixed benchmark: its id in `.factory/benchmarks.json` and the baseline a run must not regress past. */
export const Benchmark = Schema.Struct({
  id: Schema.String,
  baseline: Schema.Number,
  higherIsBetter: Schema.Boolean.pipe(withDefault(true)),
  tolerance: Schema.Number.pipe(withDefault(0)),
})
export type Benchmark = typeof Benchmark.Type

export const Expect = Schema.Struct({
  /** Step id (from /api/steps) → how often it must run. */
  steps: Schema.Record(Schema.String, StepCount).pipe(withDefault({})),
  /** Skills some worker of the run must have invoked (a `skill.invoked` event). */
  skills: Schema.Array(Schema.String).pipe(withDefault([])),
  pr: Schema.optionalKey(PrExpect),
  sdlc: Schema.optionalKey(SdlcExpect),
  /** Fixed benchmarks a grade compares against their baselines. */
  benchmarks: Schema.Array(Benchmark).pipe(withDefault([])),
})
export type Expect = typeof Expect.Type

export const Policy = Schema.Literals(["auto", "human"])
export type Policy = typeof Policy.Type
export const APPROVAL_TOPICS = ["plan", "findings", "ship", "other"] as const
export type ApprovalTopic = (typeof APPROVAL_TOPICS)[number]

/** Who answers each kind of decision during a goal run: the runner (first option) or the human. */
export const Approvals = Schema.Struct({
  plan: Policy.pipe(withDefault("auto")),
  findings: Policy.pipe(withDefault("auto")),
  ship: Policy.pipe(withDefault("auto")),
  other: Policy.pipe(withDefault("human")),
})
export type Approvals = typeof Approvals.Type

/** Who may launch Factory improvement work after a failed grade: only a human, and at most 1 + maxRetries launches. */
export const ImprovePolicy = Schema.Struct({
  approval: Schema.Literal("human").pipe(withDefault("human")),
  maxRetries: Schema.Number.pipe(withDefault(1)),
})
export type ImprovePolicy = typeof ImprovePolicy.Type
export const DEFAULT_IMPROVE: ImprovePolicy = Schema.decodeUnknownSync(ImprovePolicy)({})

export const Limits = Schema.Struct({
  runs: Schema.Number.pipe(withDefault(5)),
  minutesPerRun: Schema.Number.pipe(withDefault(720)),
})

/** Optional gates a goal can require to run or to be skipped (coordinator/src/sdlc.ts GATES). */
export const SDLC_GATES = ["design", "testFirst", "codeReview", "supplyChain", "docs", "postMerge"] as const

export const GoalSpec = Schema.Struct({
  /** Slug; also the file name docs/goals/factory/<id>.json. */
  id: Schema.String,
  title: Schema.String.pipe(withDefault("")),
  /** Absolute path of the repo that gets the change. */
  repo: Schema.String,
  /** Branch the worktree starts from and the PR targets. */
  base: Schema.String.pipe(withDefault("main")),
  prompt: Schema.String,
  expect: Expect.pipe(withDefault({})),
  approvals: Approvals.pipe(withDefault({})),
  limits: Limits.pipe(withDefault({})),
  improve: ImprovePolicy.pipe(withDefault({})),
  /** Why the goal was launched while Jev scored it below the readiness bar (guided goal page). */
  readinessOverride: Schema.optionalKey(Schema.String),
})
export type GoalSpec = typeof GoalSpec.Type

export const decodeGoal = Schema.decodeUnknownExit(GoalSpec)

/** Problems a spec has beyond its shape: bad id, empty prompt, a relative repo path, bad counts. */
export const goalProblems = (g: GoalSpec, knownSteps?: readonly string[]): string[] => {
  const out: string[] = []
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(g.id)) out.push("id: lowercase letters, digits and dashes, 2-64 chars")
  if (!g.prompt.trim()) out.push("prompt is empty")
  if (!g.repo.startsWith("/")) out.push("repo must be an absolute path")
  for (const [s, c] of Object.entries(g.expect.steps)) {
    if (knownSteps && !knownSteps.includes(s)) out.push(`unknown step ${s}`)
    if (c.min < 0 || (c.max !== undefined && c.max < c.min)) out.push(`step ${s}: need 0 <= min <= max`)
  }
  if (g.limits.runs < 1 || g.limits.minutesPerRun < 1) out.push("limits must be at least 1")
  if (!Number.isInteger(g.improve.maxRetries) || g.improve.maxRetries < 0)
    out.push("improve.maxRetries must be a whole number >= 0")
  return out
}

// ---- Grades: one evidence-backed verdict per completed report (README "Grading") ----

/** Bump when the rubric changes; grades of different versions are never compared. */
export const GRADING_VERSION = "g1"
export const Verdict = Schema.Literals(["pass", "fail", "missing"])
export type Verdict = typeof Verdict.Type
export const GradeStatus = Schema.Literals(["pass", "fail", "unknown", "error"])
export type GradeStatus = typeof GradeStatus.Type

/** A model-judged score and who judged it. */
export const QualityScore = Schema.Struct({
  score: Schema.Number,
  scale: Schema.String,
  judge: Schema.Struct({ model: Schema.String, harness: Schema.String }),
  evidence: Schema.String,
})

export const Grade = Schema.Struct({
  /** threadId|reportCommit|reportStatus|gradingVersion: a replayed report has the same key. */
  key: Schema.String,
  at: Schema.Number,
  /** A saved goal (its id) or a plain prompt (sha256 of the prompt, 12 hex chars). */
  subject: Schema.Struct({ kind: Schema.Literals(["goal", "prompt"]), id: Schema.String }),
  threadId: Schema.String,
  factoryCommit: Schema.String,
  gradingVersion: Schema.String,
  report: Schema.Struct({ status: Schema.String, commit: Schema.String }),
  status: GradeStatus,
  /** rate = passed / evaluated; missing criteria are not evaluated. */
  criteria: Schema.Struct({
    results: Schema.Record(Schema.String, Verdict),
    passed: Schema.Number,
    evaluated: Schema.Number,
    total: Schema.Number,
    rate: Schema.NullOr(Schema.Number),
  }),
  prChecks: Schema.Struct({
    required: Schema.Boolean,
    state: Schema.Literals([...ChecksState.literals, "missing"]),
    url: Schema.NullOr(Schema.String),
  }),
  benchmarks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      baseline: Schema.Number,
      value: Schema.NullOr(Schema.Number),
      regressed: Schema.NullOr(Schema.Boolean),
    }),
  ),
  evidence: Schema.Array(
    Schema.Struct({ kind: Schema.String, ref: Schema.String, sha256: Schema.optionalKey(Schema.String) }),
  ),
  /** Model-judged scores with the judge's identity. Never part of `status`. */
  quality: Schema.Array(QualityScore),
  /** Grader execution errors (gh failure, unreadable evidence): status error, not fail. */
  errors: Schema.Array(Schema.String).pipe(withDefault([])),
  /** Approval id of the improvement proposal a failed grade opened. */
  proposalId: Schema.NullOr(Schema.String).pipe(withDefault(null)),
})
export type Grade = typeof Grade.Type

/** A human-only proposal to improve the Factory after a failed grade, kept on the source thread. */
export const ImprovementProposal = Schema.Struct({
  sourceKey: Schema.String,
  sourceThreadId: Schema.String,
  approvalId: Schema.String,
  status: Schema.Literals(["proposed", "approved", "rejected", "launched", "launch-failed", "exhausted"]),
  approvedBy: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  launchedThreadId: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
})
export type ImprovementProposal = typeof ImprovementProposal.Type

/** One appended line of docs/goals/factory/<id>.runs.jsonl: what one run of the goal showed. Grade lines carry `grade`. */
export const GoalRun = Schema.Struct({
  at: Schema.Number,
  /** Factory commit the run ran on, with "+dirty" when the factory code had uncommitted changes. */
  factoryCommit: Schema.String,
  threadId: Schema.String,
  outcome: Schema.Literals(["pass", "fail", "blocked", "timeout", "unknown", "error"]),
  unmet: Schema.Array(Schema.String).pipe(withDefault([])),
  prUrl: Schema.NullOr(Schema.String).pipe(withDefault(null)),
  grade: Schema.optionalKey(Grade),
})
export type GoalRun = typeof GoalRun.Type
export const decodeGoalRun = Schema.decodeUnknownExit(GoalRun)

// ---- Run record (GET /api/runs/<thread>) and scoring ----

export type RunWorker = {
  id: string
  name: string
  step: string | null
  skills: string[]
  harness: string
  owner: string
  status: string
}
export type RunPr = {
  number: number
  url: string
  state: string
  head: string
  base: string
  body: string
  files: string[]
  checks: ChecksState
}
export type RunApproval = {
  id: string
  title: string
  topic: ApprovalTopic
  status: string
  answer: string | null
  options: string[]
}
/** Who answered is null for the human; a goal runner always names itself. */
export type AnsweredApproval = {
  status: string
  answer: string | null
  options: readonly string[]
  answeredBy: string | null
}
export type Run = {
  threadId: string
  status: string
  branch: string | null
  base: string | null
  workers: RunWorker[]
  steps: string[]
  approvals: RunApproval[]
  securityReviews: { id: string; status: string }[]
  /** Newest report_up of the conversation: done, blocked or needs-decision. */
  report: { status: string; summary: string; gaps: string[] } | null
  pr: RunPr | null
  /** Why the PR lookup failed (gh error, timeout, bad JSON); `pr` is then null but unknown, not absent. */
  prError?: string
  /** SDLC gates of the conversation; null when sdlc_plan never ran. */
  sdlc: RunSdlc | null
  grades?: Grade[]
  improvement?: ImprovementProposal | null
  /** Source thread when this conversation is a Factory improvement run. */
  improvementOf?: string
}

export type RunGate = {
  id: string
  chosen: boolean
  probability: number | null
  threshold: number
  reason: string
  status: string
  detail?: string
}
export type RunSdlc = {
  tier: string | null
  criteria: string[]
  unproven: string[]
  gates: RunGate[]
  codeReviews: { id: string; status: string; lenses: string[]; kept: number; dropped: number }[]
  metrics: { minutes: number; workers: number; findingsKept: number; findingsDropped: number }
}

/** Each unmet expectation as one line; empty when the run meets them all. `base` is the goal's base branch. */
export const goalUnmet = (run: Run, expect: Omit<Expect, "benchmarks">, base?: string): string[] => {
  const out: string[] = []
  for (const [step, c] of Object.entries(expect.steps)) {
    const n = run.workers.filter((w) => w.step === step).length
    if (n < c.min) out.push(n === 0 ? `step ${step} never ran` : `step ${step} ran ${n}x, expected at least ${c.min}`)
    if (c.max !== undefined && n > c.max) out.push(`step ${step} ran ${n}x, expected at most ${c.max}`)
  }
  const loaded = new Set(run.workers.flatMap((w) => w.skills))
  for (const s of expect.skills) if (!loaded.has(s)) out.push(`skill ${s} never invoked`)
  const sd = expect.sdlc
  if (sd) {
    const s = run.sdlc
    if (!s) out.push("no SDLC record (sdlc_plan never ran)")
    else {
      if (sd.criteriaProven && !s.criteria.length) out.push("no acceptance criteria")
      if (sd.criteriaProven && s.unproven.length) out.push(`criteria without PASS evidence: ${s.unproven.join(", ")}`)
      for (const id of sd.gatesRun) {
        const g = s.gates.find((x) => x.id === id)
        if (!g?.chosen) out.push(`gate ${id} was skipped${g ? ` (${g.reason})` : ""}, expected to run`)
        else if (g.status !== "done" && id !== "design" && id !== "testFirst" && id !== "docs" && id !== "postMerge")
          out.push(`gate ${id} is ${g.status}, expected done`)
      }
      for (const id of sd.gatesSkipped)
        if (s.gates.find((x) => x.id === id)?.chosen) out.push(`gate ${id} ran, expected skipped`)
      const rank = { T0: 0, T1: 1, T2: 2 } as Record<string, number>
      if (sd.maxTier && s.tier && rank[s.tier]! > rank[sd.maxTier]!)
        out.push(`tier ${s.tier}, expected at most ${sd.maxTier}`)
    }
  }
  const want = expect.pr
  if (want) {
    const pr = run.pr
    if (!pr) out.push(run.prError ? `PR lookup failed: ${run.prError}` : "no PR for the branch")
    else {
      const tag = `PR #${pr.number}`
      if (pr.state !== want.state) out.push(`${tag} is ${pr.state}, expected ${want.state}`)
      if (want.checks && pr.checks !== want.checks) out.push(`${tag} checks ${pr.checks}, expected ${want.checks}`)
      const wantBase = want.base ?? base
      if (wantBase && pr.base !== wantBase) out.push(`${tag} targets ${pr.base}, expected ${wantBase}`)
      for (const t of want.bodyIncludes) if (!pr.body.includes(t)) out.push(`${tag} body lacks ${JSON.stringify(t)}`)
      for (const f of want.untouched)
        if (pr.files.some((p) => (f.endsWith("/") ? p.startsWith(f) : p === f)))
          out.push(`${tag} changes ${f}, expected untouched`)
    }
  }
  return out
}

type StatusInputs = {
  criteria: Readonly<Record<string, Verdict>>
  prChecks: { required: boolean; state: Grade["prChecks"]["state"] }
  benchmarks: readonly { value: number | null; regressed: boolean | null }[]
  errors: readonly string[]
  prRequired: boolean
  prFound: boolean
}

const anyFailed = (o: StatusInputs, verdicts: readonly Verdict[]) =>
  verdicts.includes("fail") || o.prChecks.state === "FAILURE" || o.benchmarks.some((b) => b.regressed === true)

const anyMissing = (o: StatusInputs, verdicts: readonly Verdict[]) =>
  !verdicts.length ||
  verdicts.includes("missing") ||
  (o.prChecks.required && o.prChecks.state !== "SUCCESS") ||
  (o.prRequired && !o.prFound) ||
  o.benchmarks.some((b) => b.value === null)

/** The rubric (README "Grading"), applied in order: fail, error, unknown, pass. Model-judged quality is not an input. */
export const gradeStatus = (o: StatusInputs): GradeStatus => {
  const verdicts = Object.values(o.criteria)
  if (anyFailed(o, verdicts)) return "fail"
  if (o.errors.length) return "error"
  return anyMissing(o, verdicts) ? "unknown" : "pass"
}

/** What the coordinator read for one report; `buildGrade` turns it into a Grade without I/O. */
export type GradeInputs = {
  at: number
  factoryCommit: string
  subject: Grade["subject"]
  report: Grade["report"]
  criteria: Record<string, Verdict>
  /** Values from `.factory/benchmarks.json`; null when the file is absent. */
  benchmarks: Record<string, number> | null
  evidence: Grade["evidence"]
  quality: Grade["quality"]
  errors: string[]
}

const regressed = (b: Benchmark, value: number | null): boolean | null =>
  value === null ? null : b.higherIsBetter ? value < b.baseline - b.tolerance : value > b.baseline + b.tolerance

type GradedRun = Pick<Run, "threadId" | "pr" | "prError">

const criteriaSummary = (results: Record<string, Verdict>): Grade["criteria"] => {
  const verdicts = Object.values(results)
  const passed = verdicts.filter((v) => v === "pass").length
  const evaluated = passed + verdicts.filter((v) => v === "fail").length
  return { results, passed, evaluated, total: verdicts.length, rate: evaluated ? passed / evaluated : null }
}

const prChecksOf = (pr: Run["pr"], spec: GoalSpec | null | undefined): Grade["prChecks"] => ({
  required: spec ? !!spec.expect.pr?.checks : !!pr && pr.checks !== "NONE",
  state: pr?.checks ?? "missing",
  url: pr?.url ?? null,
})

const benchmarkResults = (spec: GoalSpec | null | undefined, values: GradeInputs["benchmarks"]): Grade["benchmarks"] =>
  (spec?.expect.benchmarks ?? []).map((b) => {
    const value = values?.[b.id] ?? null
    return { id: b.id, baseline: b.baseline, value, regressed: regressed(b, value) }
  })

/** A grade for one report. Goals require what their spec expects; prompts require a PR when done, and green checks when CI reported. */
export const buildGrade = (run: GradedRun, i: GradeInputs, spec?: GoalSpec | null): Grade => {
  const prRequired = spec ? !!spec.expect.pr : i.report.status === "done"
  const prChecks = prChecksOf(run.pr, spec)
  const benchmarks = benchmarkResults(spec, i.benchmarks)
  const errors = [...i.errors, ...(run.prError ? [`PR lookup failed: ${run.prError}`] : [])]
  return {
    key: `${run.threadId}|${i.report.commit}|${i.report.status}|${GRADING_VERSION}`,
    at: i.at,
    subject: i.subject,
    threadId: run.threadId,
    factoryCommit: i.factoryCommit,
    gradingVersion: GRADING_VERSION,
    report: i.report,
    status: gradeStatus({ criteria: i.criteria, prChecks, benchmarks, errors, prRequired, prFound: !!run.pr }),
    criteria: criteriaSummary(i.criteria),
    prChecks,
    benchmarks,
    evidence: [
      ...i.evidence,
      ...(run.pr ? [{ kind: "pr", ref: run.pr.url }] : []),
      { kind: "commit", ref: i.report.commit },
    ],
    quality: i.quality,
    errors,
    proposalId: null,
  }
}

const BenchmarkValues = Schema.Record(Schema.String, Schema.Number)
const decodeQualityScore = Schema.decodeUnknownExit(QualityScore)

const parseJson = (text: string): { value: unknown } | { error: string } => {
  try {
    return { value: JSON.parse(text) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** `.factory/benchmarks.json` (`{id: number}`): null values when absent; an error (a grading error) when it is not that shape. */
export const parseBenchmarks = (text: string | null): { values: Record<string, number> | null } | { error: string } => {
  if (text === null) return { values: null }
  const parsed = parseJson(text)
  const exit = "value" in parsed ? Schema.decodeUnknownExit(BenchmarkValues)(parsed.value) : null
  return exit && Exit.isSuccess(exit)
    ? { values: exit.value }
    : { error: `benchmarks.json is not {id: number}: ${"error" in parsed ? parsed.error : "bad shape"}` }
}

/** `.factory/quality.json`: judged scores; entries without a judge are dropped. A malformed file is a note, never an error. */
export const parseQuality = (text: string | null): { entries: Grade["quality"]; note?: string } => {
  if (text === null) return { entries: [] }
  const parsed = parseJson(text)
  if (!("value" in parsed) || !Array.isArray(parsed.value))
    return { entries: [], note: "quality.json is not a list; ignored" }
  return {
    entries: parsed.value.flatMap((x) => {
      const exit = decodeQualityScore(x)
      return Exit.isSuccess(exit) ? [exit.value] : []
    }),
  }
}

/** A failed grade opens one proposal; improvement runs never do (no recursion). */
export const proposeImprovement = (
  g: Grade,
  approvalId: string,
  sourceIsImprovement: boolean,
): ImprovementProposal | null =>
  g.status !== "fail" || sourceIsImprovement
    ? null
    : {
        sourceKey: g.key,
        sourceThreadId: g.threadId,
        approvalId,
        status: "proposed",
        approvedBy: null,
        attempts: 0,
        launchedThreadId: null,
        lastError: null,
      }

/** Why no launch can happen whatever the answer, or null. */
const closedReason = (
  p: ImprovementProposal | null,
  policy: ImprovePolicy,
  sourceIsImprovement: boolean,
): string | null => {
  if (sourceIsImprovement) return "improvement runs never propose more work"
  if (!p) return "no proposal"
  if (p.status === "launched" || p.status === "rejected" || p.status === "exhausted") return `proposal is ${p.status}`
  return p.attempts >= 1 + Math.floor(policy.maxRetries) ? `exhausted: ${p.attempts} launch attempts` : null
}

/** Whether to launch improvement work now. Only a recorded human answer of the first option launches, at most 1 + maxRetries times. */
export const nextImprovementAction = (
  p: ImprovementProposal | null,
  policy: ImprovePolicy,
  approval: AnsweredApproval | undefined,
  sourceIsImprovement: boolean,
): { kind: "wait" | "launch" | "refuse"; reason: string } => {
  const closed = closedReason(p, policy, sourceIsImprovement)
  if (closed) return { kind: "refuse", reason: closed }
  if (!approval || approval.status === "pending") return { kind: "wait", reason: "waiting for a human answer" }
  if (approval.answeredBy !== null) return { kind: "refuse", reason: `answered by ${approval.answeredBy}, not a human` }
  if (approval.answer !== approval.options[0]) return { kind: "refuse", reason: `rejected: ${approval.answer}` }
  return { kind: "launch", reason: "approved by a human" }
}

/** Pending decisions of the run that the policy leaves to the runner, and those it leaves to the human. */
export const splitPending = (run: Run, policy: Approvals): { auto: RunApproval[]; human: RunApproval[] } => {
  const pending = run.approvals.filter((a) => a.status === "pending")
  return {
    auto: pending.filter((a) => policy[a.topic] === "auto" && a.options.length > 0),
    human: pending.filter((a) => policy[a.topic] !== "auto" || a.options.length === 0),
  }
}

/** Why polling should stop before the expectation is met: a decision waits for the human, or the run reported blocked. */
/** `staleBlock`: summary of a blocked report that predates this watch; it does not stop the watch. A running thread is never blocked. */
export const stopReason = (
  run: Run,
  policy?: Approvals,
  staleBlock?: string | null,
): { code: 2 | 3; reason: string } | null => {
  const waiting = policy ? splitPending(run, policy).human : run.approvals.filter((a) => a.status === "pending")
  if (waiting.length)
    return {
      code: 2,
      reason: `waiting for an answer: ${waiting.map((a) => `${a.id} [${a.topic}] ${a.title}`).join("; ")}`,
    }
  if (run.report?.status === "blocked" && run.status !== "running" && run.report.summary !== staleBlock)
    return { code: 3, reason: `reported blocked: ${run.report.summary}` }
  return null
}

// ---- Form draft (UI): plain strings and flags, turned into a spec by `draftToSpec` ----

export type StepRow = { readonly on: boolean; readonly min: string; readonly max: string }
export type GoalDraft = {
  id: string
  title: string
  repo: string
  base: string
  prompt: string
  steps: { readonly [step: string]: StepRow }
  skills: readonly string[]
  expectPr: boolean
  greenChecks: boolean
  bodyIncludes: string
  untouched: string
  /** Require the SDLC record: criteria proven, these gates run, these gates skipped. */
  expectSdlc: boolean
  gatesRun: readonly string[]
  gatesSkipped: readonly string[]
  approvals: Approvals
  runs: string
  minutesPerRun: string
  benchmarks: readonly Benchmark[]
  improve: ImprovePolicy
}

const DEFAULT_STEPS: Record<string, StepRow> = {
  implement: { on: true, min: "1", max: "" },
  verify: { on: true, min: "1", max: "" },
  security: { on: true, min: "1", max: "" },
  finish: { on: true, min: "1", max: "1" },
}

export const emptyDraft = (): GoalDraft => ({
  id: "",
  title: "",
  repo: "",
  base: "main",
  prompt: "",
  steps: DEFAULT_STEPS,
  skills: [],
  expectPr: true,
  greenChecks: true,
  bodyIncludes: "",
  untouched: "",
  expectSdlc: true,
  gatesRun: [],
  gatesSkipped: [],
  approvals: { plan: "auto", findings: "auto", ship: "auto", other: "human" },
  runs: "5",
  minutesPerRun: "720",
  benchmarks: [],
  improve: DEFAULT_IMPROVE,
})

const csv = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
const int = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined)

/** The draft as a spec, or the reasons it is not one. Uses the same checks as the server. */
export const draftToSpec = (
  d: GoalDraft,
  knownSteps?: readonly string[],
): { ok: true; spec: GoalSpec } | { ok: false; problems: string[] } => {
  const problems: string[] = []
  const steps: Record<string, { min: number; max?: number }> = {}
  for (const [id, row] of Object.entries(d.steps)) {
    if (!row.on) continue
    const min = int(row.min || "1")
    const max = row.max.trim() ? int(row.max) : undefined
    if (min === undefined || (row.max.trim() && max === undefined))
      problems.push(`step ${id}: counts must be whole numbers`)
    else steps[id] = max === undefined ? { min } : { min, max }
  }
  const runs = int(d.runs)
  const minutesPerRun = int(d.minutesPerRun)
  if (runs === undefined || minutesPerRun === undefined) problems.push("limits must be whole numbers")
  const raw = {
    id: d.id.trim(),
    title: d.title.trim(),
    repo: d.repo.trim(),
    base: d.base.trim() || "main",
    prompt: d.prompt.trim(),
    expect: {
      steps,
      skills: d.skills,
      benchmarks: d.benchmarks,
      ...(d.expectPr
        ? {
            pr: {
              state: "OPEN",
              ...(d.greenChecks ? { checks: "SUCCESS" } : {}),
              bodyIncludes: csv(d.bodyIncludes),
              untouched: csv(d.untouched),
            },
          }
        : {}),
      ...(d.expectSdlc ? { sdlc: { criteriaProven: true, gatesRun: d.gatesRun, gatesSkipped: d.gatesSkipped } } : {}),
    },
    approvals: d.approvals,
    improve: d.improve,
    limits: { runs: runs ?? 5, minutesPerRun: minutesPerRun ?? 720 },
  }
  const exit = decodeGoal(raw)
  if (!Exit.isSuccess(exit)) return { ok: false, problems: [...problems, "the form does not make a valid goal"] }
  problems.push(...goalProblems(exit.value, knownSteps))
  return problems.length ? { ok: false, problems } : { ok: true, spec: exit.value }
}

/** A saved spec back into the form, to edit it or use it as a template. */
export const specToDraft = (s: GoalSpec): GoalDraft => ({
  id: s.id,
  title: s.title,
  repo: s.repo,
  base: s.base,
  prompt: s.prompt,
  steps: Object.fromEntries(
    Object.entries(s.expect.steps).map(([id, c]) => [
      id,
      { on: true, min: String(c.min), max: c.max === undefined ? "" : String(c.max) },
    ]),
  ),
  skills: [...s.expect.skills],
  expectPr: !!s.expect.pr,
  greenChecks: s.expect.pr?.checks === "SUCCESS",
  bodyIncludes: (s.expect.pr?.bodyIncludes ?? []).join(", "),
  untouched: (s.expect.pr?.untouched ?? []).join(", "),
  expectSdlc: !!s.expect.sdlc,
  gatesRun: [...(s.expect.sdlc?.gatesRun ?? [])],
  gatesSkipped: [...(s.expect.sdlc?.gatesSkipped ?? [])],
  approvals: s.approvals,
  runs: String(s.limits.runs),
  minutesPerRun: String(s.limits.minutesPerRun),
  benchmarks: s.expect.benchmarks,
  improve: s.improve,
})
