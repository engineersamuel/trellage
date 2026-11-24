import { createHash } from "node:crypto"
import path from "node:path"
import { Database } from "bun:sqlite"
import { noul } from "@typesafe-ai/sdk"
import { Effect, Semaphore } from "effect"
import { sanitizeConversationText } from "@trellage/guide-core"
import { CONTROLS, type ControlId, type ControlResult, type Grade, type Result } from "../../shared/accountability.ts"
import { loadPrompt } from "./prompt.ts"
import { type FactoryConfig, factoryConfig } from "./config.ts"
import { decisionsAvailable, systemOne, type DecideRequest } from "./decide.ts"
import { KEEP_PER_WORKER, EventStore } from "./events.ts"
import type { FeedEvent, Worker } from "./factory.ts"
import { add, totalsOf, zero } from "./costs.ts"
import { cardBudget } from "./roleCard.ts"

const DECISION_KEYS = {
  purpose: "3.1",
  content: "4.6",
  intent: "4.7",
  report: "5.2/6.3",
} as const satisfies Record<string, ControlId>
const DECISION_IDS = Object.values(DECISION_KEYS)

const clean = (value: unknown): string => sanitizeConversationText(String(value ?? "")).text
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {}
const permissionResult = (data: unknown): Record<string, unknown> => object(object(data).result)
const denied = (data: unknown): boolean => permissionResult(data).kind === "denied-interactively-by-user"
const eventAt = (event: FeedEvent): number => {
  const iso = Date.parse(event.timestamp)
  return Number.isFinite(iso) ? iso : Number(event.timestamp)
}

const clipped = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const toolEventsOf = (log: readonly FeedEvent[]): FeedEvent[] =>
  log.filter((e) => e.agentId === null && e.type === "tool.execution_start")

const toolLine = (event: FeedEvent, argsChars: number): string => {
  const data = object(event.data)
  const raw = typeof data.arguments === "string" ? data.arguments : JSON.stringify(data.arguments ?? {})
  return `TOOL ${clean(data.toolName)} ${clipped(clean(raw), argsChars)}`
}

const refusalLine = (event: FeedEvent, toolEvents: readonly FeedEvent[]): string => {
  const data = object(event.data)
  const matching = toolEvents.find((tool) => object(tool.data).toolCallId === data.toolCallId)
  const name = matching ? ` ${clean(object(matching.data).toolName)}` : ""
  const feedback = clean(data.feedback ?? permissionResult(data).feedback ?? "refused")
  return `REFUSED${name} ${feedback}`
}

const fixedExtract = (
  log: readonly FeedEvent[],
  tools: readonly FeedEvent[],
  card: string | null,
  task: string | null,
  costUsd: number,
): string => {
  const refusals = log
    .filter((e) => e.agentId === null && e.type === "permission.completed" && denied(e.data))
    .map((event) => refusalLine(event, tools))
  const final = [...log].reverse().find((e) => e.agentId === null && e.type === "assistant.message")
  return [
    card ? `ROLE CARD\n${clean(card)}` : "ROLE CARD\n(none)",
    `TASK\n${clean(clipped(task ?? "(not recorded)", 2000))}`,
    ...refusals,
    final ? `FINAL ${clipped(clean(object(final.data).content), 2000)}` : "FINAL (none)",
    `COST $${costUsd}`,
  ].join("\n")
}

const appendTools = (fixed: string, tools: readonly string[], max: number): string => {
  if (!tools.length) return fixed
  const separator = "\nTOOLS\n"
  const all = tools.join("\n")
  if (fixed.length + separator.length + all.length <= max) return `${fixed}${separator}${all}`
  const marker = `\n… ${tools.length} tool calls omitted …\n`
  const room = Math.max(0, max - fixed.length - separator.length - marker.length)
  const half = Math.floor(room / 2)
  return `${fixed}${separator}${all.slice(0, half)}${marker}${all.slice(-Math.max(0, room - half))}`
}

/** Action-only state sent to the decision engine. It deliberately never reads assistant.reasoning or delta events. */
export const extract = (
  log: readonly FeedEvent[],
  card: string | null,
  task: string | null,
  costUsd: number,
  c: Pick<FactoryConfig["accountability"], "extract_max_chars" | "args_chars"> = factoryConfig().accountability,
): string => {
  const events = toolEventsOf(log)
  const fixed = fixedExtract(log, events, card, task, costUsd)
  const max = c.extract_max_chars
  if (fixed.length > max) return fixed.slice(0, max)
  return appendTools(
    fixed,
    events.map((event) => toolLine(event, c.args_chars)),
    max,
  )
}

const cardTools = (card: string | null): Set<string> => {
  const tools = card?.match(/^Tools: (.*)$/m)?.[1] ?? ""
  return new Set(
    tools
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  )
}

export const codeChecks = (
  log: readonly FeedEvent[],
  costUsd: number,
  budget: number,
  evaluation: readonly { verdict: "pass" | "fail" }[] | null,
  card: string | null,
): Record<"3.5" | "4.2" | "4.8/4.9" | "5.5", ControlResult> => {
  const deniedCount = log.filter((e) => e.type === "permission.completed" && denied(e.data)).length
  const granted = cardTools(card)
  const used = new Set(toolEventsOf(log).map((e) => clean(object(e.data).toolName)))
  const usedGranted = [...used].filter((name) => granted.has(name)).length
  const performance = evaluationResult(evaluation)
  return {
    "3.5": { result: costUsd <= budget ? "pass" : "fail", value: costUsd },
    "4.8/4.9": { result: deniedCount === 0 ? "pass" : "fail", value: deniedCount },
    "5.5": { result: performance, value: evaluation?.length ?? 0 },
    "4.2": { result: "n/a", value: granted.size === 0 ? 0 : usedGranted / granted.size },
  }
}

const evaluationResult = (evaluation: readonly { verdict: "pass" | "fail" }[] | null): Result => {
  if (evaluation === null) return "n/a"
  return evaluation.every((x) => x.verdict === "pass") ? "pass" : "fail"
}

export type DecisionAsk = (request: DecideRequest) => ReturnType<typeof systemOne>

export const decisionChecks = async (
  state: string,
  threshold: number,
  ask: DecisionAsk = systemOne,
  available: () => boolean = decisionsAvailable,
): Promise<{
  controls: Record<"3.1" | "4.6" | "4.7" | "5.2/6.3", ControlResult>
  engine: string
}> => {
  const controls = Object.fromEntries(DECISION_IDS.map((id) => [id, { result: "unknown" }])) as Record<
    (typeof DECISION_IDS)[number],
    ControlResult
  >
  if (!available()) return { controls, engine: "none" }
  try {
    const response = await ask({
      state,
      questions: {
        purpose: noul(loadPrompt("jev/accountability/purpose")),
        content: noul(loadPrompt("jev/accountability/content")),
        intent: noul(loadPrompt("jev/accountability/intent")),
        report: noul(loadPrompt("jev/accountability/report")),
      },
    })
    for (const [key, id] of Object.entries(DECISION_KEYS) as [keyof typeof DECISION_KEYS, ControlId][]) {
      const p = response.answers[key]?.noul
      if (typeof p === "number")
        controls[id as (typeof DECISION_IDS)[number]] = {
          result: p >= threshold ? "pass" : "fail",
          p,
        }
    }
    return { controls, engine: response.engine }
  } catch {
    return { controls, engine: "unknown" }
  }
}

export const score = (controls: Record<ControlId, ControlResult>): number | null => {
  const counted = Object.entries(controls).filter(
    ([id, x]) => id !== "4.2" && (x.result === "pass" || x.result === "fail"),
  )
  if (!counted.length) return null
  return counted.filter(([, x]) => x.result === "pass").length / counted.length
}

const promptHash = () =>
  createHash("sha256")
    .update(
      [
        loadPrompt("role-card", { step: "", purpose: "", exclusions: "", budget: 0, tools: "" }),
        loadPrompt("jev/accountability/purpose"),
        loadPrompt("jev/accountability/content"),
        loadPrompt("jev/accountability/intent"),
        loadPrompt("jev/accountability/report"),
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 8)

export const GRADER_VERSION = `a1:${promptHash()}`

type GradeDimensions = {
  owner: string
  thread: string | null
  goal: string | null
  folderId: string | null
  repo: string | null
}

export type GradeDeps = {
  store: EventStore
  db: AccountabilityDb
  config: FactoryConfig
  ask?: DecisionAsk
  available?: () => boolean
  publish: (worker: string, type: string, data: unknown) => void
  dimensions: (owner: string) => GradeDimensions
}

type GradeRow = {
  controls: string
  role_card_sha256: string | null
  model_source: string
  folder_id: string | null
  started_at: number
  stopped_at: number
  cost_usd: number
  budget_usd: number
  graded_at: number
  score: number | null
  [key: string]: unknown
}

export class AccountabilityDb {
  private readonly db: Database

  constructor(file: string) {
    this.db = new Database(file, { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run(`CREATE TABLE IF NOT EXISTS grades (
      worker TEXT PRIMARY KEY, owner TEXT NOT NULL, thread TEXT, goal TEXT, folder_id TEXT, repo TEXT,
      step TEXT, model TEXT NOT NULL, harness TEXT NOT NULL, model_source TEXT NOT NULL,
      role_card_sha256 TEXT, started_at INTEGER NOT NULL, stopped_at INTEGER NOT NULL,
      cost_usd REAL NOT NULL, budget_usd REAL NOT NULL, controls TEXT NOT NULL, score REAL,
      engine TEXT NOT NULL, grader_version TEXT NOT NULL, graded_at INTEGER NOT NULL, extract TEXT NOT NULL)`)
    this.db.run("CREATE INDEX IF NOT EXISTS grades_stopped ON grades(stopped_at)")
    this.db.run("CREATE INDEX IF NOT EXISTS grades_version ON grades(grader_version)")
    this.db.run(`CREATE TABLE IF NOT EXISTS labels (
      worker TEXT NOT NULL, control TEXT NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (worker, control))`)
  }

  put(grade: Grade): void {
    this.db.run(
      `INSERT OR REPLACE INTO grades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        grade.worker,
        grade.owner,
        grade.thread,
        grade.goal,
        grade.folderId,
        grade.repo,
        grade.step,
        grade.model,
        grade.harness,
        grade.modelSource,
        grade.roleCardSha256,
        grade.startedAt,
        grade.stoppedAt,
        grade.costUsd,
        grade.budgetUsd,
        JSON.stringify(grade.controls),
        grade.score,
        grade.engine,
        grade.graderVersion,
        grade.gradedAt,
        grade.extract,
      ],
    )
  }

  private decode(row: GradeRow | null): Grade | null {
    if (!row) return null
    return {
      worker: String(row.worker),
      owner: String(row.owner),
      thread: row.thread === null ? null : String(row.thread),
      goal: row.goal === null ? null : String(row.goal),
      folderId: row.folder_id === null ? null : String(row.folder_id),
      repo: row.repo === null ? null : String(row.repo),
      step: row.step === null ? null : String(row.step),
      model: String(row.model),
      harness: String(row.harness),
      modelSource: String(row.model_source),
      roleCardSha256: row.role_card_sha256,
      startedAt: Number(row.started_at),
      stoppedAt: Number(row.stopped_at),
      costUsd: Number(row.cost_usd),
      budgetUsd: Number(row.budget_usd),
      controls: JSON.parse(row.controls),
      score: row.score === null ? null : Number(row.score),
      engine: String(row.engine),
      graderVersion: String(row.grader_version),
      gradedAt: Number(row.graded_at),
      extract: String(row.extract),
    }
  }

  get(worker: string): Grade | null {
    return this.decode(this.db.query("SELECT * FROM grades WHERE worker = ?").get(worker) as GradeRow | null)
  }

  rows(): Grade[] {
    return (this.db.query("SELECT * FROM grades ORDER BY stopped_at, worker").all() as GradeRow[]).map((row) =>
      this.decode(row)!,
    )
  }

  has(worker: string, version: string): boolean {
    return !!this.db.query("SELECT 1 FROM grades WHERE worker = ? AND grader_version = ?").get(worker, version)
  }

  forOwner(owner: string): Grade[] {
    return (this.db.query("SELECT * FROM grades WHERE owner = ?").all(owner) as GradeRow[]).map((row) =>
      this.decode(row)!,
    )
  }

  label(worker: string, control: ControlId, label: "pass" | "fail", at = Date.now()): void {
    this.db.run("INSERT OR REPLACE INTO labels (worker, control, label, at) VALUES (?, ?, ?, ?)", [
      worker,
      control,
      label,
      at,
    ])
  }

  labels(): { worker: string; control: ControlId; label: "pass" | "fail"; at: number }[] {
    return this.db.query("SELECT worker, control, label, at FROM labels ORDER BY at, worker, control").all() as {
      worker: string
      control: ControlId
      label: "pass" | "fail"
      at: number
    }[]
  }

  close(): void {
    this.db.close()
  }
}

const evaluationOf = (store: EventStore, scopeId: string): { verdicts: { verdict: "pass" | "fail" }[] } | null => {
  const events = store
    .latest("factory.evaluation", 2000)
    .map(object)
    .filter((x) => x.scopeId === scopeId && x.status === "done")
    .sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0))
  const newest = events.at(-1)
  if (!newest || !Array.isArray(newest.verdicts)) return null
  return { verdicts: newest.verdicts as { verdict: "pass" | "fail" }[] }
}

const startedWorker = (log: readonly FeedEvent[], workerId: string) => {
  const event = log.find((entry) => entry.type === "factory.worker_started")
  if (!event) throw new Error(`worker ${workerId} has no factory.worker_started event`)
  const data = object(event.data)
  if (data.role !== "worker") throw new Error(`worker ${workerId} is not role=worker`)
  return { event, data }
}

const endedWorker = (log: readonly FeedEvent[], workerId: string): FeedEvent => {
  const ended =
    [...log].reverse().find((e) => e.type === "factory.worker_stopped") ??
    [...log].reverse().find((e) => e.type === "session.idle")
  if (!ended) throw new Error(`worker ${workerId} has not ended`)
  return ended
}

const ownCost = (deps: GradeDeps, workerId: string): number => {
  const rates = deps.store.rates()
  return deps.store
    .usageRowsOf(workerId)
    .reduce((total, row) => add(total, totalsOf(row, rates[row.model], deps.config.costs.usd_per_ai_credit)), zero())
    .usd
}

const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null)
const startedAtOf = (started: Record<string, unknown>, event: FeedEvent): number =>
  typeof started.startedAt === "number" ? started.startedAt : eventAt(event)

const buildGrade = (input: {
  workerId: string
  startedEvent: FeedEvent
  started: Record<string, unknown>
  ended: FeedEvent
  dimensions: GradeDimensions
  costUsd: number
  budget: number
  roleCard: string | null
  controls: Record<ControlId, ControlResult>
  engine: string
  state: string
}): Grade => {
  const { started, startedEvent, dimensions, controls } = input
  return {
    worker: input.workerId,
    owner: dimensions.owner,
    thread: dimensions.thread,
    goal: dimensions.goal,
    folderId: dimensions.folderId,
    repo: dimensions.repo,
    step: optionalText(started.step),
    model: String(started.model ?? "unknown"),
    harness: String(started.harness ?? "unknown"),
    modelSource: String(object(started.modelSource).kind ?? "unknown"),
    roleCardSha256: input.roleCard ? createHash("sha256").update(input.roleCard).digest("hex") : null,
    startedAt: startedAtOf(started, startedEvent),
    stoppedAt: eventAt(input.ended),
    costUsd: input.costUsd,
    budgetUsd: input.budget,
    controls,
    score: score(controls),
    engine: input.engine,
    graderVersion: GRADER_VERSION,
    gradedAt: Date.now(),
    extract: input.state,
  }
}

export const gradeWorker = async (deps: GradeDeps, workerId: string): Promise<Grade> => {
  const log = deps.store.load(workerId, KEEP_PER_WORKER)
  const { event: startedEvent, data: started } = startedWorker(log, workerId)
  const ended = endedWorker(log, workerId)
  const costUsd = ownCost(deps, workerId)
  const step = optionalText(started.step)
  const roleCard = optionalText(started.roleCard)
  const dimensions = deps.dimensions(String(started.owner ?? "coordinator"))
  const state = extract(log, roleCard, optionalText(started.task), costUsd, deps.config.accountability)
  const budget = cardBudget(step, deps.config)
  const decisions = await decisionChecks(state, deps.config.accountability.pass_threshold, deps.ask, deps.available)
  const evaluation = evaluationOf(deps.store, dimensions.owner)
  const controls = {
    ...decisions.controls,
    ...codeChecks(log, costUsd, budget, evaluation?.verdicts ?? null, roleCard),
  } as Record<ControlId, ControlResult>
  const grade = buildGrade({
    workerId,
    startedEvent,
    started,
    ended,
    dimensions,
    costUsd,
    budget,
    roleCard,
    controls,
    engine: decisions.engine,
    state,
  })
  deps.db.put(grade)
  const failed = CONTROLS.filter((x) => controls[x.id].result === "fail").map((x) => x.id)
  deps.publish(workerId, "factory.accountability_graded", {
    worker: workerId,
    score: grade.score,
    failed,
    graderVersion: grade.graderVersion,
  })
  return grade
}

type EvaluationVerdict = { id?: string; verdict: "pass" | "fail" }
type GradePublisher = GradeDeps["publish"]

export const patchEvaluation = (
  db: AccountabilityDb,
  scopeId: string,
  verdicts: readonly EvaluationVerdict[],
  publish: GradePublisher,
): number => {
  let changed = 0
  for (const grade of db.forOwner(scopeId)) {
    const next = { ...grade.controls, "5.5": codeChecks([], 0, 1, verdicts, null)["5.5"] }
    const patched: Grade = { ...grade, controls: next, score: score(next), gradedAt: Date.now() }
    db.put(patched)
    publish(grade.worker, "factory.accountability_graded", {
      worker: grade.worker,
      score: patched.score,
      failed: CONTROLS.filter((x) => next[x.id].result === "fail").map((x) => x.id),
      graderVersion: grade.graderVersion,
    })
    changed++
  }
  return changed
}

export class AccountabilityGrades {
  private readonly semaphore: Semaphore.Semaphore

  constructor(
    private readonly deps: GradeDeps,
    maxParallel = deps.config.accountability.max_parallel,
  ) {
    this.semaphore = Effect.runSync(Semaphore.make(maxParallel))
  }

  queue(worker: Pick<Worker, "id">, why: "idle" | "stopped" | "runtime"): Promise<Grade> {
    void why
    return Effect.runPromise(
      this.semaphore
        .withPermits(1)(Effect.promise(() => gradeWorker(this.deps, worker.id)))
        .pipe(
          Effect.tapError((error) => Effect.sync(() => console.error(`accountability ${worker.id}: ${String(error)}`))),
        ),
    )
  }
}

export type WorkerBudgetRow = { worker: string; costUsd: number }
export type WorkerStart = { worker: string; role: string; step: string | null; timestamp: string }
export type WorkerStop = { worker: string; timestamp: string }

const BUDGET_START = Date.parse("2026-11-04T00:00:00.000Z")
const BUDGET_END = Date.parse("2026-11-25T00:00:00.000Z")

const p90Budget = (values: readonly number[]): number => {
  if (!values.length) return 0.5
  const sorted = [...values].sort((a, b) => a - b)
  const p90 = sorted[Math.ceil(0.9 * sorted.length) - 1]!
  return Math.max(0.5, Math.ceil(p90 / 0.5) * 0.5)
}

const inBudgetWindow = (timestamp: string): boolean => {
  const at = Date.parse(timestamp)
  return at >= BUDGET_START && at < BUDGET_END
}

const ownCosts = (rows: readonly WorkerBudgetRow[]): Map<string, number> => {
  const cost = new Map<string, number>()
  for (const row of rows) cost.set(row.worker, (cost.get(row.worker) ?? 0) + row.costUsd)
  return cost
}

const completedStarts = (started: readonly WorkerStart[], stopped: readonly WorkerStop[]): WorkerStart[] => {
  const completed = new Set(stopped.filter((x) => inBudgetWindow(x.timestamp)).map((x) => x.worker))
  const eligible = started.filter((x) => x.role === "worker" && completed.has(x.worker) && inBudgetWindow(x.timestamp))
  return [...new Map(eligible.map((x) => [x.worker, x])).values()]
}

const groupWorkers = (workers: readonly WorkerStart[]): Map<string, string[]> => {
  const steps = new Map<string, string[]>()
  for (const worker of workers) {
    if (!worker.step) continue
    const ids = steps.get(worker.step) ?? []
    ids.push(worker.worker)
    steps.set(worker.step, ids)
  }
  return steps
}

/** Nearest-rank p90 of own-cost rows for completed worker starts in the fixed ADR window. */
export const workerBudgets = (
  rows: readonly WorkerBudgetRow[],
  started: readonly WorkerStart[],
  stopped: readonly WorkerStop[],
): Record<string, number> => {
  const cost = ownCosts(rows)
  const perWorker = completedStarts(started, stopped)
  const all = perWorker.map((x) => cost.get(x.worker) ?? 0)
  const out: Record<string, number> = { default: p90Budget(all) }
  for (const [step, workers] of groupWorkers(perWorker))
    out[step] = workers.length >= 10 ? p90Budget(workers.map((worker) => cost.get(worker) ?? 0)) : out.default!
  return out
}

export const accountabilityDbPath = (root: string): string => path.join(root, "accountability.db")
