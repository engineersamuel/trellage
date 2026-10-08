import { readdir } from "node:fs/promises"
import { optimizeDigest } from "./guide-optimize-evidence.ts"
import { parseStoredOptimizeEvidence, validateSharedReviewEvidence } from "./review-evidence.ts"
import { parseOptimizeCitations } from "./guide-optimize-review.ts"
import { PrivateReviewRecords, reviewRecordId } from "./guide-optimize-store.ts"
import { parseGuideOptimizeTarget } from "./guide-optimize-target.ts"
import { array, boundedNumber, exactKeys, literal, record, stringArray, text, uniqueArray } from "./guide-text.ts"
import { fleetLenses, selectReviewChecks, type ReviewCheckAssignment } from "./review-catalog.ts"
import {
  reviewApprovedFindings,
  reviewFindingLimit,
  reviewIncompatibilities,
  reviewExecutionPolicy,
  type ReviewRun,
  type ReviewFinding,
  type ReviewRequest,
} from "./review-contracts.ts"
import type { GuideModelConfig } from "./guide-model-routing.ts"

const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"
const recordBytes = 100_000_000
const prose = (value: unknown, name: string, max = 4000) => text(value, name, max, { multiline: true })
const model = (input: unknown): GuideModelConfig => {
  const value = record(input, "model")
  exactKeys(value, "model", ["model", "effort"])
  return {
    model: text(value.model, "model", 256),
    effort: literal(value.effort, "effort", ["low", "medium", "high", "xhigh", "max"]),
  }
}

const parseAssignment = (input: unknown): ReviewCheckAssignment => {
  const value = record(input, "assignment")
  exactKeys(value, "assignment", ["id", "model", "workers"])
  const check = selectReviewChecks([text(value.id, "check ID", 100)])[0]!
  const workers = array(value.workers, "workers", { maximum: 6 }).map((workerInput) => {
    const worker = record(workerInput, "worker")
    exactKeys(worker, "worker", ["name", "model"])
    return { name: text(worker.name, "worker name", 100), model: model(worker.model) }
  })
  const names = check.kind === "fleet" ? fleetLenses : check.kind === "two-axis" ? ["Standards"] : []
  if (JSON.stringify(workers.map((worker) => worker.name)) !== JSON.stringify(names))
    throw new Error("Saved worker assignments differ from selected check.")
  return { id: check.id, model: model(value.model), workers }
}

const parseRequest = (input: unknown): ReviewRequest => {
  const value = record(input, "request")
  exactKeys(value, "request", ["target", "paths", "checks", "coordinator"], ["originalIntent", "intent"])
  const request: ReviewRequest = {
    target: parseGuideOptimizeTarget(value.target),
    paths: uniqueArray(
      array(value.paths, "paths", { minimum: 1, maximum: 5000 }).map((name) =>
        text(name, "path", 4096, { preserve: true }),
      ),
      "paths",
      "paths",
    ),
    checks: array(value.checks, "checks", { minimum: 1, maximum: 6 }).map(parseAssignment),
    coordinator: model(value.coordinator),
    ...(value.originalIntent === undefined
      ? {}
      : { originalIntent: text(value.originalIntent, "original intent", 60_000, { multiline: true, preserve: true }) }),
    ...(value.intent === undefined
      ? {}
      : { intent: text(value.intent, "intent", 60_000, { multiline: true, preserve: true }) }),
  }
  const incompatible = reviewIncompatibilities(request)
  if (incompatible.length) throw new Error(incompatible.join("\n"))
  return request
}

const validateFinding = (input: unknown, run: ReviewRun, checkId: string, reportId: string): void => {
  const value = record(input, "finding")
  exactKeys(
    value,
    "finding",
    ["id", "checkId", "reportId", "sourceId", "title", "paths", "citations", "grounded"],
    ["proposal", "benefit", "risk", "verification", "severity", "limitation", "code", "sourceExcerpt"],
  )
  const id = text(value.id, "finding ID", 200)
  if (!id.startsWith(`${checkId}:`) || value.checkId !== checkId || value.reportId !== reportId)
    throw new Error("Finding source identity differs.")
  text(value.sourceId, "source ID", 200)
  if (value.sourceExcerpt !== undefined) {
    const excerpt = text(value.sourceExcerpt, "report excerpt", 8000, { multiline: true, preserve: true })
    if (!run.artifacts.find((artifact) => artifact.id === reportId)?.content.includes(excerpt))
      throw new Error("Finding excerpt is absent from its source report.")
  }
  prose(value.title, "title", 300)
  for (const key of ["proposal", "benefit", "risk", "verification", "limitation"])
    if (value[key] !== undefined) prose(value[key], key, 8000)
  if (value.severity !== undefined) literal(value.severity, "severity", ["critical", "high", "medium", "low"])
  validateFindingGrounding(value, run)
  if (value.code !== undefined) validateCode(value.code)
}

const validateFindingGrounding = (value: Record<string, unknown>, run: ReviewRun): void => {
  const paths = uniqueArray(
    array(value.paths, "finding paths", { maximum: 16 }).map((name) => text(name, "path", 4096, { preserve: true })),
    "paths",
    "paths",
  )
  if (paths.some((name) => !run.request.paths.includes(name))) throw new Error("Finding exceeds selected paths.")
  const citations = array(value.citations, "citations", { maximum: 3 })
  if (citations.length) parseOptimizeCitations(citations, run.evidence.source)
  if (typeof value.grounded !== "boolean" || (value.grounded && (!paths.length || !citations.length)))
    throw new Error("Finding lacks checked repository grounding.")
  if (
    value.grounded &&
    citations.every((citation) => String(record(citation, "citation").source).startsWith("@skill/"))
  )
    throw new Error("Skill principles do not ground an implementation finding.")
}

const validateCode = (input: unknown): void => {
  const code = record(input, "code suggestion")
  exactKeys(code, "code suggestion", ["current", "suggested", "kind"])
  for (const key of ["current", "suggested"])
    if (typeof code[key] !== "string" || Buffer.byteLength(code[key] as string) > 32_000)
      throw new Error("Invalid code suggestion.")
  literal(code.kind, "fix kind", ["exact", "illustrative"])
}

const validateResults = (run: ReviewRun): void => {
  const results = array(run.results, "results", { maximum: run.request.checks.length })
  const ids: string[] = []
  const findingIds: string[] = []
  for (const input of results) {
    const value = record(input, "result")
    exactKeys(value, "result", ["id", "status", "reportId", "findings", "limitations"], ["error"])
    const id = text(value.id, "check ID", 100)
    const check = selectReviewChecks([id])[0]!
    if (!run.request.checks.some((entry) => entry.id === id)) throw new Error("Unselected check result.")
    ids.push(id)
    const reportId = text(value.reportId, "report ID", 200)
    if (!run.artifacts.some((artifact) => artifact.id === reportId && artifact.checkId === id))
      throw new Error("Missing source report.")
    const status = literal(value.status, "check status", ["complete", "partial", "failed"])
    stringArray(value.limitations, "limitations", { maximumItems: 100, itemMaximum: 4000 })
    if (value.error !== undefined) prose(value.error, "error", 8000)
    const maximumFindings = status === "partial" ? check.maximumFindings * 128 : check.maximumFindings
    for (const finding of array(value.findings, "findings", { maximum: maximumFindings })) {
      validateFinding(finding, run, id, reportId)
      findingIds.push(text(record(finding, "finding").id, "finding ID", 200))
    }
  }
  uniqueArray(ids, "results", "check IDs")
  uniqueArray(findingIds, "findings", "finding IDs")
}

const validateArtifacts = (run: ReviewRun): void => {
  const ids: string[] = []
  for (const input of array(run.artifacts, "artifacts", { maximum: 4096 + run.request.checks.length * 8 })) {
    const value = record(input, "artifact")
    exactKeys(value, "artifact", ["id", "checkId", "name", "content", "digest"])
    ids.push(text(value.id, "artifact ID", 200))
    if (value.checkId !== "synthesis" && !run.request.checks.some((check) => check.id === value.checkId))
      throw new Error("Unselected artifact.")
    text(value.name, "artifact name", 256)
    if (
      typeof value.content !== "string" ||
      Buffer.byteLength(value.content) > 1024 * 1024 ||
      optimizeDigest(value.content) !== value.digest
    )
      throw new Error("Saved report content differs.")
  }
  uniqueArray(ids, "artifacts", "artifact IDs")
}

const validateDecisions = (run: ReviewRun): void => {
  const findings = run.results.flatMap((result) => result.findings)
  const ids: string[] = []
  for (const input of array(run.decisions, "decisions", { maximum: reviewFindingLimit(run.request) })) {
    const value = record(input, "decision")
    exactKeys(value, "decision", ["findingId", "disposition", "reason"], ["duplicateOf"])
    const finding = findings.find((entry) => entry.id === value.findingId)
    if (!finding) throw new Error("Decision has no source finding.")
    ids.push(finding.id)
    literal(value.disposition, "disposition", ["recommended", "rejected", "unresolved"])
    prose(value.reason, "decision reason")
    if (value.disposition === "recommended" && (!finding.grounded || !finding.proposal))
      throw new Error("Ungrounded finding cannot be recommended for implementation.")
    if (
      value.duplicateOf !== undefined &&
      (value.duplicateOf === finding.id || !findings.some((entry) => entry.id === value.duplicateOf))
    )
      throw new Error("Invalid duplicate source finding.")
  }
  uniqueArray(ids, "decisions", "finding IDs")
  if (
    run.status === "complete" &&
    (ids.length !== findings.length ||
      run.results.length !== run.request.checks.length ||
      run.results.some((result) => result.status !== "complete"))
  )
    throw new Error("Complete review lacks findings or check coverage.")
}

const validateFailure = (input: unknown, status: unknown): void => {
  if (input === undefined) return
  const failure = record(input, "review failure")
  exactKeys(failure, "review failure", ["kind", "phase", "message"])
  literal(failure.kind, "review failure kind", [
    "user-cancelled",
    "request-timeout",
    "overall-timeout",
    "validation-failure",
    "provider-failure",
  ])
  literal(failure.phase, "review failure phase", [
    "evidence-capture",
    "independent-reviews",
    "final-synthesis",
    "cleanup",
  ])
  prose(failure.message, "review failure message", 16_000)
  if (status === "complete") throw new Error("Complete review cannot have a failure diagnostic.")
}

export const parseSharedReview = (input: unknown): ReviewRun => {
  const value = record(input, "shared review")
  exactKeys(value, "shared review", [
    "schemaVersion",
    "policy",
    "id",
    "createdAt",
    "request",
    "evidence",
    "status",
    "results",
    "artifacts",
    "challenges",
    "decisions",
    "summary",
    "error",
    "calls",
    "approvedIds",
    "execution",
  ], ["synthesisStatus", "failure"])
  if (value.schemaVersion !== 2) throw new Error("Unsupported shared review version.")
  reviewRecordId(value.id)
  text(value.createdAt, "createdAt", 80)
  const request = parseRequest(value.request)
  const evidence = record(value.evidence, "evidence")
  exactKeys(evidence, "evidence", ["fingerprint", "source"], ["patch"])
  const source = parseStoredOptimizeEvidence(evidence.source)
  validateSharedReviewEvidence(evidence, request, source)
  literal(value.status, "status", ["running", "complete", "incomplete", "cancelled"])
  if (value.synthesisStatus !== undefined) {
    literal(value.synthesisStatus, "synthesis status", ["queued", "running", "complete", "failed", "not-run"])
    if (value.status === "complete" && value.synthesisStatus !== "complete")
      throw new Error("Complete review lacks completed synthesis.")
  }
  validateFailure(value.failure, value.status)
  literal(value.execution, "execution", ["not-started", "launching", "launched", "unknown"])
  prose(value.summary, "summary", 16_000)
  if (value.error !== null) prose(value.error, "error", 16_000)
  const ids = request.checks.map((check) => check.id)
  const current = reviewExecutionPolicy(ids, source)
  const legacy = reviewExecutionPolicy(ids)
  const policy = optimizeDigest(value.policy) === optimizeDigest(legacy) ? legacy : current
  if (optimizeDigest(value.policy) !== optimizeDigest(policy))
    throw new Error("Saved execution policy differs from selected checks.")
  const calls = boundedNumber(value.calls, "calls", 0, policy.maximumCalls)
  if (!Number.isInteger(calls)) throw new Error("Call count must be an integer.")
  // Complex fields are checked below before this value can escape the parser.
  const run = { ...value, request } as unknown as ReviewRun
  validateArtifacts(run)
  validateResults(run)
  validateDecisions(run)
  validateChallenges(run)
  uniqueArray(
    stringArray(value.approvedIds, "approved IDs", { maximumItems: reviewFindingLimit(request), itemMaximum: 200 }),
    "approval",
    "IDs",
  )
  if (run.approvedIds.length) reviewApprovedFindings({ ...run, execution: "not-started" }, run.approvedIds)
  else if (run.execution !== "not-started") throw new Error("Unapproved review cannot reserve execution.")
  return run
}

const validateChallenges = (run: ReviewRun): void => {
  for (const input of array(run.challenges, "challenges", { maximum: 3 })) {
    const value = record(input, "challenge")
    exactKeys(value, "challenge", ["reviewerId", "responses"])
    if (!run.request.checks.some((check) => check.id === value.reviewerId)) throw new Error("Unknown challenge author.")
    for (const response of array(value.responses, "responses", { maximum: 12 })) {
      const reply = record(response, "reply")
      exactKeys(reply, "reply", ["findingId", "disposition", "reason", "citations"])
      if (!run.results.some((result) => result.findings.some((finding) => finding.id === reply.findingId)))
        throw new Error("Challenge has no source finding.")
      literal(reply.disposition, "reply disposition", ["support", "reject", "uncertain"])
      prose(reply.reason, "reply reason")
      parseOptimizeCitations(reply.citations, run.evidence.source)
    }
  }
}

export interface SharedReviewApproval {
  readonly reviewId: string
  readonly reviewDigest: string
  readonly findings: ReadonlyArray<ReviewFinding>
}
export const sharedReviewApproval = (run: ReviewRun, ids: ReadonlyArray<string>): SharedReviewApproval => ({
  reviewId: run.id,
  reviewDigest: optimizeDigest({ ...run, approvedIds: ids }),
  findings: reviewApprovedFindings(run, ids),
})

export class SharedReviewStore extends PrivateReviewRecords {
  readonly namespace = "shared"
  constructor(gitDirectory: string) {
    super(gitDirectory, "trellage-reviews")
  }

  async read(id: string): Promise<ReviewRun> {
    const run = parseSharedReview(await this.readData(`${reviewRecordId(id)}.json`, recordBytes))
    if (run.id !== id || run.request.target.gitDirectory !== this.gitDirectory)
      throw new Error("Review belongs to another worktree.")
    return run
  }

  async save(input: ReviewRun): Promise<void> {
    const run = parseSharedReview(input)
    if (run.request.target.gitDirectory !== this.gitDirectory) throw new Error("Review belongs to another worktree.")
    await this.locked(async () => {
      let previous: ReviewRun | undefined
      try {
        previous = await this.read(run.id)
      } catch (error) {
        if (!missing(error)) throw error
      }
      if (!previous && (run.status !== "running" || run.approvedIds.length || run.execution !== "not-started"))
        throw new Error("Save an unapproved initial review first.")
      if (
        previous &&
        (previous.status !== "running" ||
          previous.execution !== "not-started" ||
          optimizeDigest(previous.request) !== optimizeDigest(run.request) ||
          previous.evidence.fingerprint !== run.evidence.fingerprint ||
          run.approvedIds.length ||
          run.execution !== "not-started")
      )
        throw new Error("Saved review authority cannot be replaced.")
      await this.writeData(`${run.id}.json`, run, recordBytes)
    })
  }

  async list(): Promise<ReadonlyArray<Pick<ReviewRun, "id" | "createdAt" | "status" | "summary">>> {
    await this.ensure()
    const files = (await readdir(this.directory)).filter((name) => name.endsWith(".json"))
    if (files.length > 128) throw new Error("Too many saved reviews; archive completed records.")
    const runs = await Promise.all(files.map((name) => this.read(name.slice(0, -5))))
    return runs
      .map(({ id, createdAt, status, summary }) => ({ id, createdAt, status, summary }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async approve(id: string, ids: ReadonlyArray<string>): Promise<SharedReviewApproval> {
    return this.locked(async () => {
      const run = await this.read(id)
      const approval = sharedReviewApproval(run, ids)
      await this.writeData(`${run.id}.json`, { ...run, approvedIds: ids }, recordBytes)
      return approval
    })
  }

  async approved(approval: SharedReviewApproval): Promise<ReviewRun> {
    const run = await this.read(approval.reviewId)
    const expected = sharedReviewApproval(run, run.approvedIds)
    if (optimizeDigest(expected) !== optimizeDigest(approval)) throw new Error("Approval differs from saved findings.")
    return run
  }

  async beginExecution(approval: SharedReviewApproval): Promise<void> {
    await this.locked(async () => {
      const run = await this.approved(approval)
      await this.writeData(`${run.id}.json`, { ...run, execution: "launching" }, recordBytes)
    })
  }

  async finishExecution(id: string, execution: "launched" | "unknown"): Promise<void> {
    await this.locked(async () => {
      const run = await this.read(id)
      if (run.execution !== "launching") throw new Error("Review execution was not reserved.")
      await this.writeData(`${run.id}.json`, { ...run, execution }, recordBytes)
    })
  }
}
