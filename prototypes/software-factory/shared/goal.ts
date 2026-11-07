// Factory goal specs: one test case of the self-improve loop (a prompt for a repo and what the run must show).
// The UI form, the coordinator's /api/goals and `sf goal` all decode with this one Schema, and `sf goal run`
// scores a run with `goalUnmet`, so the three never disagree.
import { Effect, Schema } from "effect"

const withDefault = <S extends Schema.Top>(value: S["Encoded"]) => Schema.withDecodingDefaultKey<S>(Effect.succeed(value))

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

export const Expect = Schema.Struct({
  /** Step id (from /api/steps) → how often it must run. */
  steps: Schema.Record(Schema.String, StepCount).pipe(withDefault({})),
  /** Skills some worker of the run must have invoked (a `skill.invoked` event). */
  skills: Schema.Array(Schema.String).pipe(withDefault([])),
  pr: Schema.optionalKey(PrExpect),
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

export const Limits = Schema.Struct({
  runs: Schema.Number.pipe(withDefault(5)),
  minutesPerRun: Schema.Number.pipe(withDefault(90)),
})

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
  return out
}

/** One appended line of docs/goals/factory/<id>.runs.jsonl: what one run of the goal showed. */
export const GoalRun = Schema.Struct({
  at: Schema.Number,
  /** Factory commit the run ran on, with "+dirty" when the factory code had uncommitted changes. */
  factoryCommit: Schema.String,
  threadId: Schema.String,
  outcome: Schema.Literals(["pass", "fail", "blocked", "timeout"]),
  unmet: Schema.Array(Schema.String).pipe(withDefault([])),
  prUrl: Schema.NullOr(Schema.String).pipe(withDefault(null)),
})
export type GoalRun = typeof GoalRun.Type
export const decodeGoalRun = Schema.decodeUnknownExit(GoalRun)

// ---- Run record (GET /api/runs/<thread>) and scoring ----

export type RunWorker = { id: string; name: string; step: string | null; skills: string[]; harness: string; owner: string; status: string }
export type RunPr = { number: number; url: string; state: string; head: string; base: string; body: string; files: string[]; checks: ChecksState }
export type RunApproval = { id: string; title: string; topic: ApprovalTopic; status: string; answer: string | null; options: string[] }
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
}

/** Each unmet expectation as one line; empty when the run meets them all. `base` is the goal's base branch. */
export const goalUnmet = (run: Run, expect: Expect, base?: string): string[] => {
  const out: string[] = []
  for (const [step, c] of Object.entries(expect.steps)) {
    const n = run.workers.filter((w) => w.step === step).length
    if (n < c.min) out.push(n === 0 ? `step ${step} never ran` : `step ${step} ran ${n}x, expected at least ${c.min}`)
    if (c.max !== undefined && n > c.max) out.push(`step ${step} ran ${n}x, expected at most ${c.max}`)
  }
  const loaded = new Set(run.workers.flatMap((w) => w.skills))
  for (const s of expect.skills) if (!loaded.has(s)) out.push(`skill ${s} never invoked`)
  const want = expect.pr
  if (want) {
    const pr = run.pr
    if (!pr) out.push("no PR for the branch")
    else {
      const tag = `PR #${pr.number}`
      if (pr.state !== want.state) out.push(`${tag} is ${pr.state}, expected ${want.state}`)
      if (want.checks && pr.checks !== want.checks) out.push(`${tag} checks ${pr.checks}, expected ${want.checks}`)
      const wantBase = want.base ?? base
      if (wantBase && pr.base !== wantBase) out.push(`${tag} targets ${pr.base}, expected ${wantBase}`)
      for (const t of want.bodyIncludes) if (!pr.body.includes(t)) out.push(`${tag} body lacks ${JSON.stringify(t)}`)
      for (const f of want.untouched) if (pr.files.includes(f)) out.push(`${tag} changes ${f}, expected untouched`)
    }
  }
  return out
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
export const stopReason = (run: Run, policy?: Approvals): { code: 2 | 3; reason: string } | null => {
  const waiting = policy ? splitPending(run, policy).human : run.approvals.filter((a) => a.status === "pending")
  if (waiting.length) return { code: 2, reason: `waiting for an answer: ${waiting.map((a) => `${a.id} [${a.topic}] ${a.title}`).join("; ")}` }
  if (run.report?.status === "blocked") return { code: 3, reason: `reported blocked: ${run.report.summary}` }
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
  approvals: Approvals
  runs: string
  minutesPerRun: string
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
  approvals: { plan: "auto", findings: "auto", ship: "auto", other: "human" },
  runs: "5",
  minutesPerRun: "90",
})

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean)
const int = (s: string): number | undefined => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : undefined)

/** The draft as a spec, or the reasons it is not one. Uses the same checks as the server. */
export const draftToSpec = (d: GoalDraft, knownSteps?: readonly string[]): { ok: true; spec: GoalSpec } | { ok: false; problems: string[] } => {
  const problems: string[] = []
  const steps: Record<string, { min: number; max?: number }> = {}
  for (const [id, row] of Object.entries(d.steps)) {
    if (!row.on) continue
    const min = int(row.min || "1")
    const max = row.max.trim() ? int(row.max) : undefined
    if (min === undefined || (row.max.trim() && max === undefined)) problems.push(`step ${id}: counts must be whole numbers`)
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
      ...(d.expectPr
        ? { pr: { state: "OPEN", ...(d.greenChecks ? { checks: "SUCCESS" } : {}), bodyIncludes: csv(d.bodyIncludes), untouched: csv(d.untouched) } }
        : {}),
    },
    approvals: d.approvals,
    limits: { runs: runs ?? 5, minutesPerRun: minutesPerRun ?? 90 },
  }
  const exit = decodeGoal(raw)
  if (exit._tag !== "Success") return { ok: false, problems: [...problems, "the form does not make a valid goal"] }
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
  steps: Object.fromEntries(Object.entries(s.expect.steps).map(([id, c]) => [id, { on: true, min: String(c.min), max: c.max === undefined ? "" : String(c.max) }])),
  skills: [...s.expect.skills],
  expectPr: !!s.expect.pr,
  greenChecks: s.expect.pr?.checks === "SUCCESS",
  bodyIncludes: (s.expect.pr?.bodyIncludes ?? []).join(", "),
  untouched: (s.expect.pr?.untouched ?? []).join(", "),
  approvals: s.approvals,
  runs: String(s.limits.runs),
  minutesPerRun: String(s.limits.minutesPerRun),
})
