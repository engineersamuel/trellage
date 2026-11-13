// Independent acceptance evaluator (docs/adr/0006-factory-acceptance-evaluator.md). A worker from a model family
// other than the builder's, in a fresh context:
// 1. Contract, at sdlc_plan: one check and expected output per criterion, or a problem and a testable rewrite.
// 2. Evaluation, when the sub-coordinator first asks to ship: it runs every check itself and writes verdicts outside
//    the worktree. A failed criterion gets a fix and a verify worker, then a new evaluation, at most
//    [evaluate].max_rounds evaluations. It never blocks shipping: the verdicts go to the PR body and the grade (g2).
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { approveAll, type PermissionHandler } from "@github/copilot-sdk"
import type { FactoryConfig } from "./config.ts"
import { now, type Auth, type Factory, type Worker } from "./factory.ts"
import { forbiddenCommand } from "./guard.ts"
import { awaitGateWorker } from "./gateWorker.ts"
import { loadPrompt } from "./prompt.ts"
import { geminiReachable, reviewModelFor, reviewerRoute } from "./review.ts"
import {
  contractFor,
  criteriaWithChecks,
  diffFiles,
  implementAddendum,
  verifyAddendum,
  type ContractItem,
  type ContractProblem,
  type Sdlc,
} from "./sdlc.ts"
import type { Scope } from "./tools.ts"

export type AcVerdict = { id: string; verdict: "pass" | "fail"; command: string; output: string; note: string }
export type EvaluationStatus = "evaluating" | "fixing" | "verifying" | "done" | "failed"
export type Evaluation = {
  id: string
  scopeId: string
  threadId: string | null
  workdir: string
  status: EvaluationStatus
  /** Evaluation round, from 1. */
  round: number
  model: string
  /** Verdicts of the last finished evaluation round. */
  verdicts: AcVerdict[]
  /** The verdicts file outside the worktree, with its sha256, for the grade's evidence. */
  file?: { path: string; sha256: string }
  /** Worker the evaluation waits on; review and resume code treat it as the gate's. */
  workerId?: string
  workerIds: string[]
  /** Things the human should know (the evaluator changed files, a check had no verdict). */
  notes: string[]
  error?: string
  at: number
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const parseArray = (text: string): unknown[] => {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** contract.json: one item per criterion AC-1..AC-n; a missing or malformed item gets no check. */
export const parseContract = (text: string, n: number): ContractItem[] => {
  const byId = new Map<string, ContractItem>()
  for (const r of parseArray(text)) {
    const o = (r ?? {}) as Record<string, unknown>
    const id = str(o.id)
    if (!/^AC-\d+$/.test(id)) continue
    if (str(o.check)) byId.set(id, { id, check: str(o.check), expect: str(o.expect) })
    else if (str(o.problem)) byId.set(id, { id, problem: str(o.problem), rewrite: str(o.rewrite) })
  }
  return Array.from({ length: n }, (_, i) => `AC-${i + 1}`).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
}

/** verdicts.json for criteria AC-1..AC-n. A criterion with no valid verdict fails: the evaluator did not prove it. */
export const parseVerdicts = (text: string, n: number): AcVerdict[] => {
  const byId = new Map<string, AcVerdict>()
  for (const r of parseArray(text)) {
    const o = (r ?? {}) as Record<string, unknown>
    const id = str(o.id)
    if (!/^AC-\d+$/.test(id) || (o.verdict !== "pass" && o.verdict !== "fail")) continue
    byId.set(id, {
      id,
      verdict: o.verdict,
      command: str(o.command),
      output: str(o.output).slice(0, 2000),
      note: str(o.note),
    })
  }
  return Array.from({ length: n }, (_, i) => `AC-${i + 1}`).map(
    (id) => byId.get(id) ?? { id, verdict: "fail", command: "", output: "", note: "no verdict from the evaluator" },
  )
}

/** How many criteria the goal page locked: its launch prompt says "AC-1..AC-<n> word for word". */
export const lockedCount = (request: string): number =>
  Number(request.match(/AC-1\.\.AC-(\d+) word for word/)?.[1] ?? 0)

/** Problems on locked criteria are not sent back (the human owns them); they stay as notes. */
export const contractProblems = (items: ContractItem[], locked: number) => {
  const problems = items.filter((x): x is ContractProblem => "problem" in x)
  const isLocked = (id: string) => Number(id.slice(3)) <= locked
  return { open: problems.filter((p) => !isLocked(p.id)), locked: problems.filter((p) => isLocked(p.id)) }
}

export const contractMarkdown = (criteria: string[], contract: ContractItem[]): string =>
  `# Acceptance contract\n\n${criteria
    .map((c, i) => {
      const k = contract.find((x) => x.id === `AC-${i + 1}`)
      const how = !k
        ? "- no check agreed"
        : "check" in k
          ? `- check: \`${k.check}\`\n- expect: ${k.expect || "(not given)"}`
          : `- problem: ${k.problem}\n- rewrite: ${k.rewrite}`
      return `## AC-${i + 1}: ${c}\n${how}`
    })
    .join("\n\n")}\n`

const MUTATING_GIT =
  /(^|[\s;&|(])git\s+(-C\s+\S+\s+)?(commit|add|rm|mv|reset|checkout|switch|restore|stash|apply|am|rebase|merge|cherry-pick|revert|clean|tag|push)\b/

/** The evaluator may read, build, run and call the deliverable; it writes only under `out`, never changes git state. */
export const evaluatorPermissions =
  (out: string): PermissionHandler =>
  (request, invocation) => {
    if (request.kind === "write") {
      const file = path.resolve(String((request as { fileName?: unknown }).fileName ?? ""))
      if (!file.startsWith(path.resolve(out) + path.sep))
        return { kind: "reject", feedback: `The evaluator never edits the worktree. Write only under ${out}.` }
    }
    if (
      request.kind === "shell" &&
      (forbiddenCommand(request.fullCommandText) || MUTATING_GIT.test(request.fullCommandText))
    )
      return { kind: "reject", feedback: "The evaluator never changes git state. Report what you found instead." }
    return approveAll(request, invocation)
  }

const status = (workdir: string): string => {
  try {
    return execFileSync("git", ["-C", workdir, "status", "--porcelain"], { encoding: "utf8" })
  } catch {
    return ""
  }
}

type Run = { f: Factory; scope: Scope; workdir: string; auth: Auth | undefined; c: FactoryConfig }

const work = async (
  r: Run,
  p: { name: string; step: string; task: string; model?: string; evaluator?: string; id?: string },
  started?: (w: Worker) => void,
): Promise<Worker> => {
  const route = p.model ? reviewerRoute(p.model, r.f.settings.workers.harness) : {}
  let n = 0
  const start = async () => {
    const w = await spawnOne(r, p, route, n++ ? undefined : p.id)
    started?.(w)
    return w
  }
  const w = await awaitGateWorker(start, p.name, (id) => r.f.stop(id), r.c)
  if (p.evaluator) await r.f.stop(w.id).catch(() => {})
  return w
}

const spawnOne = (
  r: Run,
  p: { name: string; step: string; task: string; model?: string; evaluator?: string },
  route: ReturnType<typeof reviewerRoute>,
  id: string | undefined,
): Promise<Worker> =>
  r.f.spawn({
    ...(id ? { id } : {}),
    name: p.name,
    role: "worker",
    ...(r.auth ? { auth: r.auth } : {}),
    step: p.step,
    task: p.task,
    owner: r.scope.id,
    workdir: r.workdir,
    ...(p.model ? { model: p.model } : {}),
    ...(p.evaluator ? { permissions: evaluatorPermissions(p.evaluator) } : {}),
    ...route,
  })

const outDir = (f: Factory) => {
  const id = `w-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
  const out = path.join(f.root, id, "evaluate")
  mkdirSync(out, { recursive: true })
  return { id, out }
}

/** The evaluator model: a frontier model of a family other than `builder`'s. */
const evaluatorModel = (f: Factory, builder: string | null | undefined, c: FactoryConfig) =>
  reviewModelFor(builder, process.env.SF_REVIEW_MODEL, geminiReachable(f.settings.workers.harness), c)

/**
 * The contract for `criteria`. The builder is the sub-coordinator, whose model wrote the criteria. Null when the
 * evaluator could not run; the plan then goes on without a contract (logged).
 */
export const agreeContract = async (
  f: Factory,
  scope: Scope,
  p: { request: string; plan: string; criteria: string[]; c: FactoryConfig },
): Promise<ContractItem[] | null> => {
  if (!scope.workdir) return null
  const { id, out } = outDir(f)
  const model = evaluatorModel(f, f.workers.get(scope.id)?.model ?? f.settings.subAgent.model, p.c)
  const r: Run = { f, scope, workdir: scope.workdir, auth: f.workers.get(scope.id)?.auth, c: p.c }
  try {
    const locked = lockedCount(p.request)
    await work(r, {
      id,
      name: "evaluate-contract",
      step: "evaluate",
      model,
      evaluator: out,
      task: loadPrompt("tasks/evaluate-contract", {
        request: p.request,
        plan: p.plan,
        criteria: p.criteria.map((c, i) => `AC-${i + 1}: ${c}`).join("\n"),
        locked: locked ? String(locked) : "",
        out,
      }),
    })
    return parseContract(readFileSync(path.join(out, "contract.json"), "utf8"), p.criteria.length)
  } catch (e) {
    console.error(`evaluator contract for ${scope.id}: ${e instanceof Error ? e.message : e}`)
    return null
  }
}

const unfinished = (e: Evaluation) => e.status !== "done" && e.status !== "failed"

export const pendingEvaluation = (all: Iterable<Evaluation>, scopeId: string): Evaluation | undefined =>
  [...all].find((e) => e.scopeId === scopeId && unfinished(e))

export const evaluationIn = (all: Iterable<Evaluation>, workdir: string): Evaluation | undefined =>
  [...all].find((e) => path.resolve(e.workdir) === path.resolve(workdir) && unfinished(e))

/** The scope's newest evaluation. */
export const lastEvaluation = (all: Iterable<Evaluation>, scopeId: string): Evaluation | undefined =>
  [...all]
    .filter((e) => e.scopeId === scopeId)
    .sort((a, b) => a.at - b.at)
    .at(-1)

/** Verdicts as grade results: AC id → pass or fail. */
export const verdictResults = (e: Evaluation): Record<string, "pass" | "fail"> =>
  Object.fromEntries(e.verdicts.map((v) => [v.id, v.verdict]))

/** Lines for the PR body. */
export const evaluationMarkdown = (e: Evaluation): string =>
  [
    `Independent evaluator (${e.model}), ${e.round} round${e.round === 1 ? "" : "s"}${e.status === "failed" ? `, stopped: ${e.error}` : ""}.`,
    ...e.verdicts.map(
      (v) =>
        `- [${v.verdict === "pass" ? "x" : " "}] ${v.id}: ${v.verdict.toUpperCase()} — ${v.note}${v.command ? ` (\`${v.command.slice(0, 200)}\`)` : ""}`,
    ),
    ...e.notes.map((n) => `- note: ${n}`),
  ].join("\n")

/** Run the evaluation rounds. Never throws: an error ends it as `failed`, which does not block shipping. */
export const evaluate = async (f: Factory, scope: Scope, s: Sdlc, c: FactoryConfig): Promise<Evaluation> => {
  const workdir = scope.workdir!
  const e: Evaluation = {
    id: `ev-${crypto.randomUUID().slice(0, 8)}`,
    scopeId: scope.id,
    threadId: scope.threadId,
    workdir,
    status: "evaluating",
    round: 1,
    model: evaluatorModel(f, s.implementerModel, c),
    verdicts: [],
    workerIds: [],
    notes: [],
    at: Date.now(),
  }
  const set = (patch: Partial<Evaluation>) => {
    Object.assign(e, patch, { at: Date.now() })
    f.evaluations.set(e.id, e)
    f.publish(scope.id, "factory.evaluation", null, now(), { ...e })
  }
  // Synchronous first transition: ship and spawn gates see it before any await.
  set({})
  const r: Run = { f, scope, workdir, auth: f.workers.get(scope.id)?.auth, c }
  const track = (w: Worker) => set({ workerId: w.id, workerIds: [...e.workerIds, w.id] })
  const contract = criteriaWithChecks(s.criteria, contractFor(s))
  try {
    for (let round = 1; ; round++) {
      set({ status: "evaluating", round })
      const { id, out } = outDir(f)
      const before = status(workdir)
      await work(
        r,
        {
          id,
          name: "evaluate",
          step: "evaluate",
          model: e.model,
          evaluator: out,
          task: loadPrompt("tasks/evaluate", {
            contract,
            checks: s.checks.map((x) => `- \`${x}\``).join("\n") || "- (none found; use the repo's own)",
            diff: scope.base
              ? diffFiles(workdir, scope.base)
                  .map((x) => `- ${x.path} +${x.added} -${x.removed}`)
                  .join("\n")
                  .slice(0, 3000)
              : "(see git diff)",
            out,
            round: String(round),
          }),
        },
        track,
      )
      const file = path.join(out, "verdicts.json")
      const text = (() => {
        try {
          return readFileSync(file, "utf8")
        } catch {
          return ""
        }
      })()
      const verdicts = parseVerdicts(text, s.criteria.length)
      const notes = [...e.notes]
      if (status(workdir) !== before)
        notes.push(`evaluator round ${round} changed files in the worktree; check git status`)
      set({ verdicts, notes, file: { path: file, sha256: createHash("sha256").update(text).digest("hex") } })
      const failed = verdicts.filter((v) => v.verdict === "fail")
      if (!failed.length || round >= c.evaluate.max_rounds) break
      set({ status: "fixing" })
      const list = failed
        .map(
          (v) =>
            `- ${v.id}: ${v.note}${v.command ? ` (ran \`${v.command}\`)` : ""}${v.output ? `\n  output: ${v.output.split("\n").slice(0, 5).join(" | ")}` : ""}`,
        )
        .join("\n")
      await work(
        r,
        {
          name: "evaluate-fix",
          step: "implement",
          ...(s.implementerModel ? { model: s.implementerModel } : {}),
          task: loadPrompt("tasks/evaluate-fix", { failed: list, contract }) + implementAddendum(s),
        },
        track,
      )
      set({ status: "verifying" })
      await work(
        r,
        {
          name: "evaluate-verify",
          step: "verify",
          task: `Run the repo checks after the evaluator fixes.${verifyAddendum(s)}`,
        },
        track,
      )
    }
    set({ status: "done", workerId: undefined })
  } catch (err) {
    set({ status: "failed", workerId: undefined, error: err instanceof Error ? err.message : String(err) })
  } finally {
    await Promise.all(e.workerIds.map((id) => f.stop(id).catch(() => {})))
  }
  return e
}
