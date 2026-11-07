// Wiring of the SDLC gates into a repo conversation: plan (criteria, plan-phase gates), the hooks after implement
// and verify (risk tier, diff-phase gates, code review, supply chain), and the ship check.
import { writeFileSync } from "node:fs"
import { now, type Auth, type Factory } from "./factory.ts"
import { codeReview, codeReviewDoneSince } from "./review.ts"
import {
  artifact,
  askGates,
  classify,
  criteriaMarkdown,
  decide,
  diffFiles,
  ensureFactoryDir,
  gate,
  implementAddendum,
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
import type { Scope } from "./tools.ts"

const publish = (f: Factory, s: Sdlc) => {
  f.sdlc.set(s.scopeId, s)
  f.publish(s.scopeId, "factory.sdlc", null, now(), s)
}

const setGate = (f: Factory, scopeId: string, id: GateId, status: GateStatus, detail?: string) => {
  const s = f.sdlc.get(scopeId)
  if (!s) return
  publish(f, { ...s, gates: s.gates.map((g) => (g.id === id ? { ...g, status, ...(detail ? { detail } : {}) } : g)) })
}

/** sdlc_plan: save the criteria, read the repo's CI checks, ask Jev which plan-phase gates this change needs. */
export const planSdlc = async (f: Factory, scope: Scope, request: string, criteria: string[], plan: string): Promise<Sdlc> => {
  const workdir = scope.workdir!
  ensureFactoryDir(workdir)
  writeFileSync(artifact(workdir, "acceptance.md"), criteriaMarkdown(criteria))
  const prev = f.sdlc.get(scope.id) ?? newSdlc(scope.id, scope.threadId)
  const { probabilities, error } = await askGates("plan", { request, plan, criteria })
  const s: Sdlc = withGates({ ...prev, request, criteria, checks: repoChecks(workdir) }, decide("plan", probabilities, null, error))
  publish(f, s)
  return s
}

/** The implement or verify task with the factory's rules appended; other steps unchanged. */
export const sdlcTask = (f: Factory, scope: Scope, step: string | undefined, task: string): string => {
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

/**
 * After an implement worker: security review (floor, always), then the risk tier and Jev's diff-phase gates; the
 * chosen code review and supply-chain scan run here. Fix workers of reviews never call this.
 */
export const afterImplement = async (f: Factory, scope: Scope, implementWorkerId: string, scopeAuth: Auth | undefined) => {
  const s0 = f.sdlc.get(scope.id) ?? newSdlc(scope.id, scope.threadId)
  const request = s0.request
  publish(f, { ...s0, implementDoneAt: Date.now() })
  const workdir = scope.workdir
  const base = scope.base
  const security = securityReview(f, scope, implementWorkerId, scopeAuth)
  if (!workdir || !base) return void (await security)
  const files = diffFiles(workdir, base)
  const risk = classify(files)
  const diffStat = files.map((x) => `${x.path} +${x.added} -${x.removed}`).join("\n").slice(0, 4000)
  const { probabilities, error } = await askGates("diff", { request, criteria: s0.criteria, tier: risk.tier, reasons: risk.reasons, diff: diffStat })
  publish(f, withGates({ ...f.sdlc.get(scope.id)!, risk }, decide("diff", probabilities, risk, error)))
  const auth = f.workers.get(implementWorkerId)?.auth ?? scopeAuth ?? f.defaultAuth
  const jobs: Promise<unknown>[] = [security]
  if (gate(f.sdlc.get(scope.id)!, "supplyChain")?.chosen) {
    setGate(f, scope.id, "supplyChain", "running")
    jobs.push(supplyChainScan(workdir, base).then((r) => setGate(f, scope.id, "supplyChain", r.ok ? "done" : "failed", r.detail)))
  }
  if (gate(f.sdlc.get(scope.id)!, "codeReview")?.chosen) {
    setGate(f, scope.id, "codeReview", "running")
    // After the security review, so the two never fix the same worktree at once.
    jobs.push(
      security.then(() =>
        codeReview(f, scope, {
          workdir,
          base,
          auth,
          request,
          criteria: s0.criteria,
          diffStat,
          onFindings: (kept, dropped) => {
            const s = f.sdlc.get(scope.id)!
            publish(f, { ...s, findings: { kept: s.findings.kept + kept, dropped: s.findings.dropped + dropped } })
          },
        }).then((r) => setGate(f, scope.id, "codeReview", r.status === "done" ? "done" : "failed", r.error)),
      ),
    )
  }
  await Promise.all(jobs)
}

export const afterVerify = (f: Factory, scopeId: string) => {
  const s = f.sdlc.get(scopeId)
  if (s) publish(f, { ...s, verifyDoneAt: Date.now() })
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
  const securityDone = [...f.securityReviews.values()].some((r) => r.scopeId === scope.id && r.status === "done" && r.at >= (s?.implementDoneAt ?? 0))
  const crDone = codeReviewDoneSince(f.codeReviews.values(), scope.id, s?.implementDoneAt ?? 0)
  return shipBlockers(s, scope.workdir, scope.base, securityDone, crDone)
}
