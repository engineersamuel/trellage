// Wiring of the SDLC gates into a repo conversation: plan (criteria, plan-phase gates), the hooks after implement
// and verify (risk tier, diff-phase gates, code review, supply chain), and the ship check.
import { rmSync, writeFileSync } from "node:fs"
import { now, type Auth, type Factory } from "./factory.ts"
import { codeReview, codeReviewDoneSince, lenses, reviewModelFor } from "./review.ts"
import { pinnedConfig, snapshotConfig } from "./config.ts"
import { loadPrompt, snapshotPrompts, withPinned } from "./prompt.ts"
import {
  artifact,
  askGates,
  classify,
  criteriaMarkdown,
  decide,
  diffFiles,
  ensureFactoryDir,
  floorReason,
  gateDefs,
  gate,
  implementAddendum,
  rereviewLines,
  maxReviewRounds,
  isTestPath,
  settleGates,
  newSdlc,
  repoChecks,
  shipBlockers,
  supplyChainScan,
  verifyAddendum,
  withGates,
  type GateId,
  type GateStatus,
  type Sdlc,
} from "./sdlc.ts"
import { securityReview } from "./security.ts"
import { execFileSync } from "node:child_process"
import { noul } from "@typesafe-ai/sdk"
import { decisionLabel, decisionsAvailable, systemOne } from "./decide.ts"
import type { Scope } from "./tools.ts"
import { recordCase } from "./promptEval.ts"
import { PAUSE_REASON } from "./budget.ts"
import {
  agreeContract,
  contractMarkdown,
  contractProblems,
  evaluate,
  lastEvaluation,
  lockedCount,
  pendingEvaluation,
} from "./evaluate.ts"

const publish = (f: Factory, s: Sdlc) => {
  f.sdlc.set(s.scopeId, s)
  f.publish(s.scopeId, "factory.sdlc", null, now(), s)
}

const setGate = (f: Factory, scopeId: string, id: GateId, status: GateStatus, detail?: string) => {
  const s = f.sdlc.get(scopeId)
  if (!s) return
  publish(f, { ...s, gates: s.gates.map((g) => (g.id === id ? { ...g, status, ...(detail ? { detail } : {}) } : g)) })
}

/**
 * sdlc_plan: save the criteria, read the repo's CI checks, ask Jev which plan-phase gates this change needs, and (when
 * [evaluate] is on, for at most contract_rounds calls) start the independent evaluator's contract in the background.
 * A contract applies only to the criteria it was agreed for: new criteria drop it. `job` settles when the contract does.
 */
export const planSdlc = async (
  f: Factory,
  scope: Scope,
  request: string,
  criteria: string[],
  plan: string,
  contract: typeof agreeContract = agreeContract,
): Promise<Sdlc & { job?: Promise<void> }> => {
  const workdir = scope.workdir!
  ensureFactoryDir(workdir)
  writeFileSync(artifact(workdir, "acceptance.md"), criteriaMarkdown(criteria))
  const prev = f.sdlc.get(scope.id) ?? newSdlc(scope.id, scope.threadId)
  // The run pins the factory config and the prompt files at its first plan; later edits apply to new runs only.
  const configId = prev.configId ?? snapshotConfig(f.root)
  const promptsId = prev.promptsId ?? snapshotPrompts(f.root)
  const pinned = { ...prev, configId, promptsId }
  return inRun(f, pinned, async () => {
    const c = pinnedConfig(f.root, configId)
    const { probabilities, error } = await askGates("plan", { request, plan, criteria }, c)
    const s: Sdlc = withGates(
      { ...pinned, request, criteria, checks: repoChecks(workdir) },
      decide("plan", probabilities, null, error, c),
    )
    const same = JSON.stringify(s.contractState?.criteria) === JSON.stringify(criteria)
    // Changed criteria drop the old contract and its file: a check is matched by AC number and would test the wrong thing.
    const fresh: Sdlc = same ? s : { ...s, contract: undefined, contractState: undefined }
    if (!same) rmSync(artifact(workdir, "contract.md"), { force: true })
    publish(f, fresh)
    const rounds = fresh.contractRounds ?? 0
    if (!c.evaluate.enabled || rounds >= c.evaluate.contract_rounds || fresh.contractState?.status === "running")
      return fresh
    const round = rounds + 1
    const state = { criteria, round, open: [], locked: [], final: round >= c.evaluate.contract_rounds }
    const started: Sdlc = { ...fresh, contractRounds: round, contractState: { ...state, status: "running" } }
    publish(f, started)
    // Settles into the newest state only while it is still for these criteria; a later sdlc_plan wins.
    const settle = (patch: Partial<Sdlc>) => {
      const current = f.sdlc.get(scope.id)
      if (current?.contractState?.status === "running" && current.contractState.round === round)
        publish(f, { ...current, ...patch })
    }
    const job = contract(f, scope, { request, plan, criteria, c }).then(
      (items) => {
        if (!items)
          return settle({ contractState: { ...state, status: "failed", error: "the evaluator gave no contract" } })
        writeFileSync(artifact(workdir, "contract.md"), contractMarkdown(criteria, items))
        settle({
          contract: items,
          contractState: { ...state, status: "done", ...contractProblems(items, lockedCount(request)) },
        })
      },
      (e) =>
        settle({ contractState: { ...state, status: "failed", error: e instanceof Error ? e.message : String(e) } }),
    )
    return { ...started, job }
  })
}

/**
 * Why the plan approval must wait for the contract; null when it may go on. `notes` are untestable criteria the
 * approval summary must name (the last round's open problems, and problems on locked criteria).
 */
export const planApprovalCheck = (f: Factory, scopeId: string): { wait: string | null; notes: string[] } => {
  const k = f.sdlc.get(scopeId)?.contractState
  const line = (x: { id: string; problem: string; rewrite: string }) => `${x.id}: ${x.problem} Suggested: ${x.rewrite}`
  if (!k || k.status === "failed") return { wait: null, notes: [] }
  if (k.status === "running")
    return {
      wait: "the independent evaluator is still agreeing a check per criterion; wait with next_step, then ask again.",
      notes: [],
    }
  if (k.open.length && !k.final)
    return {
      wait: `the independent evaluator cannot test these criteria as written. Rewrite them (or use the suggestion) and call sdlc_plan again:\n- ${k.open.map(line).join("\n- ")}`,
      notes: [],
    }
  return { wait: null, notes: [...k.open, ...k.locked].map(line) }
}

/** Run `fn` with the delivery run's pinned config and prompts (no run yet: the live ones). */
export const inRun = <T>(f: Factory, s: Pick<Sdlc, "configId" | "promptsId"> | undefined, fn: () => T): T =>
  withPinned(f.root, { promptsId: s?.promptsId, configId: s?.configId }, pinnedConfig(f.root, s?.configId), fn)

/** `fn` in the pinned run of `scope`'s conversation. */
const inScopeRun = <T>(f: Factory, scope: Scope, fn: () => T): T => inRun(f, f.sdlc.get(scope.id), fn)

/** The implement or verify task with the factory's rules appended; other steps unchanged. */
export const sdlcTask = (f: Factory, scope: Scope, step: string | undefined, task: string): string =>
  inScopeRun(f, scope, () => sdlcTaskIn(f, scope, step, task))

const sdlcTaskIn = (f: Factory, scope: Scope, step: string | undefined, task: string): string => {
  const s = f.sdlc.get(scope.id)
  if (!s) return task
  if (step === "implement") return task + implementAddendum(s)
  if (step === "verify") return task + verifyAddendum(s)
  return task
}

/** Unfinished gate work in this conversation (code review or supply chain), as a wait note; null when none. */
export const sdlcBusy = (f: Factory, scopeId: string): string | null => {
  const s = f.sdlc.get(scopeId)
  const running = s?.gates.filter((g) => g.chosen && g.status === "running").map((g) => g.id) ?? []
  return running.length ? `SDLC gates still running: ${running.join(", ")}` : null
}

const head = (workdir: string): string | null => {
  try {
    return execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return null
  }
}

/** Jev: is the diff's growth past the first implement needed for the criteria? Null when Jev is unavailable. */
const growthNeeded = async (state: Record<string, unknown>): Promise<number | null> => {
  if (!decisionsAvailable()) return null
  try {
    const res = await systemOne({
      state: JSON.stringify(state),
      questions: { needed: noul(loadPrompt("jev/growth")) },
    })
    const p = res.answers?.needed?.noul
    if (typeof p !== "number") return null
    recordCase({ prompt: "jev/growth", vars: {}, state: JSON.stringify(state), answer: p })
    return p
  } catch {
    return null
  }
}

/**
 * After an implement worker the sub-coordinator spawned (review and security fixes never call this): risk tier,
 * Jev's diff-phase gates (decided once, at the first implement; the tier can still force a floor later), the
 * supply-chain scan, and one code review round. A later implement re-reviews only the lines since the last review,
 * and only when they are rereviewLines() or more. The security review is not here: it runs last, at ship time.
 */
export const afterImplement = (f: Factory, scope: Scope, implementWorkerId: string, scopeAuth: Auth | undefined) =>
  inScopeRun(f, scope, () => afterImplementIn(f, scope, implementWorkerId, scopeAuth))

/** A gate error from a coordinator restart or a cost-limit pause: the work did not fail, it was stopped. */
const interrupted = (detail: string | undefined) =>
  !!detail && (detail === "coordinator restarted" || detail.includes(PAUSE_REASON))

/**
 * After a coordinator restart or a cost-limit pause: run again a code review the restart stopped (restore marked its gate failed with
 * "coordinator restarted"). The stopped round does not count, and the last implement time stays, so no new verify
 * is needed for it. True when a review started.
 */
export const rerunInterruptedReview = (f: Factory, scope: Scope): boolean => {
  const s = f.sdlc.get(scope.id)
  const cr = s && gate(s, "codeReview")
  if (!s || s.implementDoneAt === null || cr?.status !== "failed" || !interrupted(cr.detail)) return false
  publish(f, { ...s, reviewRounds: Math.max(0, s.reviewRounds - 1) })
  void inScopeRun(f, scope, () => afterImplementIn(f, scope, null, f.workers.get(scope.id)?.auth))
  return true
}

const afterImplementIn = async (
  f: Factory,
  scope: Scope,
  implementWorkerId: string | null,
  scopeAuth: Auth | undefined,
) => {
  const s0prev = f.sdlc.get(scope.id) ?? newSdlc(scope.id, scope.threadId)
  const implementer = implementWorkerId ? f.workers.get(implementWorkerId) : undefined
  const s0 = { ...s0prev, implementerModel: implementer?.model ?? s0prev.implementerModel ?? null }
  const c = pinnedConfig(f.root, s0.configId)
  publish(f, implementWorkerId ? { ...s0, implementDoneAt: Date.now() } : s0)
  const workdir = scope.workdir
  const base = scope.base
  if (!workdir || !base) return
  const files = diffFiles(workdir, base)
  const risk = classify(files)
  const diffStat = files
    .map((x) => `${x.path} +${x.added} -${x.removed}`)
    .join("\n")
    .slice(0, 4000)
  const first = s0.firstLines === null
  const gates = first
    ? decide(
        "diff",
        (
          await askGates(
            "diff",
            { request: s0.request, criteria: s0.criteria, tier: risk.tier, reasons: risk.reasons, diff: diffStat },
            c,
          )
        ).probabilities,
        risk,
        undefined,
        c,
      )
    : s0.gates
        .filter((g) => gateDefs(c).some((d) => d.id === g.id && d.phase === "diff"))
        .map((g) =>
          floorReason(g.id, risk) && !g.chosen
            ? { ...g, chosen: true, status: "pending" as const, reason: floorReason(g.id, risk)! }
            : g,
        )
  let scopeWarning = s0.scopeWarning
  if (!first && s0.firstLines !== null && risk.lines > 2 * s0.firstLines && risk.lines > 200) {
    const p = await growthNeeded({
      request: s0.request,
      criteria: s0.criteria,
      firstLines: s0.firstLines,
      lines: risk.lines,
      diff: diffStat,
    })
    scopeWarning =
      p !== null && p < 0.5
        ? `diff grew from ${s0.firstLines} to ${risk.lines} lines; ${decisionLabel()} ${p.toFixed(2)} says the growth is not needed for the criteria. Trim it.`
        : null
  }
  publish(
    f,
    withGates({ ...f.sdlc.get(scope.id)!, risk, firstLines: s0.firstLines ?? risk.lines, scopeWarning }, gates),
  )
  const auth = implementer?.auth ?? scopeAuth ?? f.defaultAuth
  const jobs: Promise<unknown>[] = []
  if (gate(f.sdlc.get(scope.id)!, "supplyChain")?.chosen) {
    setGate(f, scope.id, "supplyChain", "running")
    jobs.push(
      supplyChainScan(workdir, base).then((r) =>
        setGate(f, scope.id, "supplyChain", r.ok ? "done" : "failed", r.detail),
      ),
    )
  }
  const cr = gate(f.sdlc.get(scope.id)!, "codeReview")
  const since = s0.reviewedCommit ?? base
  // Re-reviews count only non-test lines: tests added for review findings do not earn another round.
  const newLines = s0.reviewedCommit
    ? diffFiles(workdir, s0.reviewedCommit)
        .filter((x) => !isTestPath(x.path))
        .reduce((n, x) => n + x.added + x.removed, 0)
    : risk.lines
  const rounds = s0.reviewRounds ?? 0
  const rereview = s0.reviewedCommit !== null
  if (cr?.chosen && rounds < maxReviewRounds(c) && (!rereview || newLines >= rereviewLines(c))) {
    setGate(f, scope.id, "codeReview", "running")
    publish(f, { ...f.sdlc.get(scope.id)!, reviewRounds: rounds + 1 })
    const reviewed = head(workdir)
    jobs.push(
      codeReview(f, scope, {
        workdir,
        base: since,
        auth,
        request: s0.request,
        criteria: s0.criteria,
        diffStat,
        tier: risk.tier,
        implementerModel: s0.implementerModel,
        config: c,
        // A re-review is one reviewer (the first configured lens, correctness by default) on the new lines, no synthesis.
        ...(rereview ? { lenses: [lenses(c)[0]!.id] } : {}),
        onFindings: (kept, dropped) => {
          const s = f.sdlc.get(scope.id)!
          publish(f, { ...s, findings: { kept: s.findings.kept + kept, dropped: s.findings.dropped + dropped } })
        },
      }).then((r) => {
        // Review fixes are part of the review: the next re-review starts after them.
        publish(f, {
          ...f.sdlc.get(scope.id)!,
          reviewedCommit: r.status === "done" ? (head(workdir) ?? reviewed) : s0.reviewedCommit,
        })
        setGate(f, scope.id, "codeReview", r.status === "done" ? "done" : "failed", r.error)
      }),
    )
  } else if (cr?.chosen)
    setGate(
      f,
      scope.id,
      "codeReview",
      "done",
      rounds >= maxReviewRounds(c)
        ? `review round limit (${maxReviewRounds(c)}) reached; verify only`
        : `${newLines} non-test lines since the last review (< ${rereviewLines(c)}); verify only`,
    )
  await Promise.all(jobs)
}

/** Ship blockers other than the security review (it runs last, once everything else is ready). */
const blockersBeforeSecurity = (f: Factory, scope: Scope): string[] => {
  const s = f.sdlc.get(scope.id)
  const crDone =
    codeReviewDoneSince(f.codeReviews.values(), scope.id, 0) ||
    s?.gates.find((g) => g.id === "codeReview")?.status === "done"
  return shipBlockers(s, scope.workdir!, scope.base, true, crDone)
}

/**
 * The final security review: started when every other gate is ready and none is running, over the whole diff.
 * Jev triages its findings; kept ones get a fix and a verify worker. Returns a note while it runs.
 */
export const startFinalSecurity = (f: Factory, scope: Scope): string | null =>
  inScopeRun(f, scope, () => startFinalSecurityIn(f, scope))

const startFinalSecurityIn = (f: Factory, scope: Scope): string | null => {
  if (!scope.workdir) return null
  const s = f.sdlc.get(scope.id)
  if (!s || blockersBeforeSecurity(f, scope).length || sdlcBusy(f, scope.id)) return null
  const last = [...f.securityReviews.values()].filter((r) => r.scopeId === scope.id).at(-1)
  if (last && last.status !== "done" && last.status !== "failed")
    return `final security review ${last.id} is ${last.status}; wait for it, then ask to ship again.`
  if (last?.status === "done" && last.at >= (s.implementDoneAt ?? 0)) return null
  void securityReview(
    f,
    scope,
    s.scopeId,
    f.workers.get(scope.id)?.auth,
    reviewModelFor(s.implementerModel, process.env.SF_SECURITY_MODEL, true, pinnedConfig(f.root, s.configId)),
  )
  return loadPrompt("final-security-started")
}

/**
 * The independent evaluation (src/evaluate.ts): started at a ship request when everything before the security review
 * is ready, once per implement. Returns a wait note while it runs; it never blocks shipping by its verdicts.
 * An evaluation a coordinator restart stopped runs again.
 */
export const startEvaluation = (f: Factory, scope: Scope): string | null =>
  inScopeRun(f, scope, () => startEvaluationIn(f, scope))

const startEvaluationIn = (f: Factory, scope: Scope): string | null => {
  const s = f.sdlc.get(scope.id)
  const c = pinnedConfig(f.root, s?.configId)
  if (!scope.workdir || !s?.criteria.length || !c.evaluate.enabled) return null
  if (blockersBeforeSecurity(f, scope).length || sdlcBusy(f, scope.id)) return null
  const pending = pendingEvaluation(f.evaluations.values(), scope.id)
  if (pending)
    return `the independent evaluation ${pending.id} is ${pending.status} (round ${pending.round}); wait with next_step, then ask to ship again.`
  const last = lastEvaluation(f.evaluations.values(), scope.id)
  const restarted = last?.status === "failed" && interrupted(last.error)
  if (last && !restarted && last.at >= (s.implementDoneAt ?? 0)) return null
  void evaluate(f, scope, s, c)
  return loadPrompt("evaluate-started")
}

export const afterVerify = (f: Factory, scope: Scope) => inScopeRun(f, scope, () => afterVerifyIn(f, scope))

const afterVerifyIn = async (f: Factory, scope: Scope) => {
  const s = f.sdlc.get(scope.id)
  if (!s) return
  publish(f, { ...s, verifyDoneAt: Date.now() })
  // A failed supply-chain gate is scanned again, so a fixed lockfile or base clears it without another implement.
  if (gate(s, "supplyChain")?.status === "failed" && scope.workdir && scope.base) {
    setGate(f, scope.id, "supplyChain", "running")
    const r = await supplyChainScan(scope.workdir, scope.base)
    setGate(f, scope.id, "supplyChain", r.ok ? "done" : "failed", r.detail)
  }
}

/** Count every worker the conversation starts (delivery metric). */
export const countWorker = (f: Factory, scopeId: string) => {
  const s = f.sdlc.get(scopeId)
  if (s) f.sdlc.set(scopeId, { ...s, workers: s.workers + 1 })
}

/** Ship blockers of the conversation; [] when it may ship. */
export const sdlcShipBlockers = (f: Factory, scope: Scope): string[] => {
  if (!scope.workdir) return []
  const s = f.sdlc.get(scope.id)
  const securityDone = [...f.securityReviews.values()].some(
    (r) => r.scopeId === scope.id && r.status === "done" && r.at >= (s?.implementDoneAt ?? 0),
  )
  const crDone =
    codeReviewDoneSince(f.codeReviews.values(), scope.id, 0) ||
    s?.gates.find((g) => g.id === "codeReview")?.status === "done"
  const blockers = shipBlockers(s, scope.workdir, scope.base, securityDone, crDone)
  if (s) {
    const settled = settleGates(s, blockers)
    if (JSON.stringify(settled.gates) !== JSON.stringify(s.gates)) publish(f, settled)
  }
  return blockers
}
