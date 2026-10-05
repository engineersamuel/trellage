import { execFile } from "node:child_process"
import { lstat, mkdir, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import path from "node:path"
import { fleetLenses, pinnedFleetModel, reviewCatalog, type ReviewDefinition, selectReviews } from "./review-catalog.ts"
import { prepareReviewWorkspace, type ReviewSkillOptions } from "./review-skills.ts"
import { CopilotReviewProvider, type ReviewClientFactory, type ReviewResult } from "./copilot-review-provider.ts"

const exec = promisify(execFile)
const sha = /^[0-9a-f]{40,64}$/u
const severities = ["critical", "high", "medium", "low"] as const
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u

export interface ReviewSnapshot {
  readonly repository: string
  readonly baseRef: string
  readonly baseRefSha: string
  readonly base: string
  readonly head: string
  readonly diff: string
  readonly changedFiles: ReadonlyArray<string>
  readonly workingTreeFiles: ReadonlyArray<string>
  readonly commitList?: string
  readonly standards?: ReadonlyArray<{ readonly path: string; readonly content: string }>
}

const standardsPaths = ["AGENTS.md", "CONTRIBUTING.md", "CODING_STANDARDS.md", ".agents/rules/trellage-cli.md"] as const

interface CaptureBudget {
  readonly signal: AbortSignal
  readonly deadline: number
}

const captureRemaining = (budget: CaptureBudget): number => {
  budget.signal.throwIfAborted()
  const remaining = budget.deadline - performance.now()
  if (remaining <= 0) throw new Error("Review snapshot capture exceeded 60000 ms.")
  return Math.max(1, Math.ceil(remaining))
}

const committedStandards = async (root: string, base: string, changedFiles: ReadonlyArray<string>,
  signal: CaptureBudget): Promise<ReadonlyArray<{ path: string; content: string }>> => {
  const sources: Array<{ path: string; content: string }> = []
  for (const file of standardsPaths) {
    if (file === ".agents/rules/trellage-cli.md" &&
      !changedFiles.some((name) => name.startsWith("packages/trellage-cli/"))) continue
    const entry = await git(root, signal, "ls-tree", base, "--", file)
    if (!entry) continue
    if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t/u.test(entry)) {
      throw new Error(`Pinned standard must be a regular tracked file: ${file}`)
    }
    const content = await git(root, signal, "show", `${base}:${file}`)
    if (Buffer.byteLength(content) > 32 * 1024) throw new Error(`Pinned standard exceeds size limit: ${file}`)
    sources.push({ path: file, content })
  }
  return sources
}

const git = async (cwd: string, budget: CaptureBudget, ...args: string[]): Promise<string> => {
  const timeout = Math.min(15_000, captureRemaining(budget))
  const result = await exec("git", ["-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, signal: budget.signal, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  })
  captureRemaining(budget)
  return result.stdout.trimEnd()
}

const untrackedPatch = async (root: string, file: string, signal: CaptureBudget): Promise<string> => {
  try {
    await git(root, signal, "diff", "--no-ext-diff", "--no-textconv",
      "--binary", "--no-index", "--", "/dev/null", file)
    throw new Error(`Untracked file did not produce a patch: ${JSON.stringify(file)}`)
  } catch (error) {
    captureRemaining(signal)
    if (error instanceof Error && "code" in error && error.code === 1 &&
      "stdout" in error && typeof error.stdout === "string") return error.stdout.trimEnd()
    throw error
  }
}

const resolveReviewBase = async (root: string, baseRef: string, signal: CaptureBudget): Promise<{
  baseRefSha: string; base: string; head: string
}> => {
  const baseRefSha = await git(root, signal, "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`)
  const head = await git(root, signal, "rev-parse", "--verify", "HEAD^{commit}")
  if (!sha.test(baseRefSha) || !sha.test(head)) throw new Error("Review requires valid base and HEAD commits.")
  let base: string
  try {
    base = await git(root, signal, "merge-base", baseRefSha, head)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === 1) {
      throw new Error("Review base and HEAD have no common ancestor.", { cause: error })
    }
    throw error
  }
  if (!sha.test(base)) throw new Error("Review requires a valid common ancestor.")
  return { baseRefSha, base, head }
}

const maximumDiffBytes = 384 * 1024
const oversizedDiff = (): never => {
  throw new Error("The complete committed and working-tree diff is too large to review without truncation.")
}

const captureUntracked = async (root: string, files: ReadonlyArray<string>, initialBytes: number,
  signal: CaptureBudget): Promise<ReadonlyArray<string>> => {
  if (initialBytes > maximumDiffBytes) oversizedDiff()
  if (files.length > 1024) throw new Error("Review snapshot exceeds 1024 untracked paths.")
  const patches: string[] = []
  let bytes = initialBytes
  for (const file of files) {
    captureRemaining(signal)
    const stat = await lstat(path.join(root, file))
    captureRemaining(signal)
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`Unsupported untracked entry: ${JSON.stringify(file)}`)
    }
    if (stat.size > maximumDiffBytes) oversizedDiff()
    const patch = await untrackedPatch(root, file, signal)
    bytes += Buffer.byteLength(patch) + (patches.length ? 2 : 0)
    if (bytes > maximumDiffBytes) oversizedDiff()
    patches.push(patch)
  }
  return patches
}

export const captureReviewSnapshot = async (repository: string, baseRef: string,
  signal?: AbortSignal): Promise<ReviewSnapshot> => {
  if (signal?.aborted) throw signal.reason ?? new Error("Review capture cancelled.")
  const controller = new AbortController()
  const cancel = (): void => controller.abort(signal?.reason)
  signal?.addEventListener("abort", cancel, { once: true })
  const budget = { signal: controller.signal, deadline: performance.now() + 60_000 }
  const timer = setTimeout(() => controller.abort(new Error("Review snapshot capture exceeded 60000 ms.")), 60_000)
  try {
    return await captureSnapshot(repository, baseRef, budget)
  } catch (error) {
    captureRemaining(budget)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
  }
}

const captureSnapshot = async (repository: string, baseRef: string,
  signal: CaptureBudget): Promise<ReviewSnapshot> => {
  if (!/^refs\/(?:remotes|heads)\/[a-zA-Z0-9][a-zA-Z0-9/._-]*$/u.test(baseRef) || baseRef.includes("..")) {
    throw new Error("Select an explicit local or remote base ref.")
  }
  const root = await git(repository, signal, "rev-parse", "--show-toplevel")
  if (path.resolve(root) !== path.resolve(repository)) throw new Error("Review must start at the Git worktree root.")
  const { baseRefSha, base, head } = await resolveReviewBase(root, baseRef, signal)
  const committed = await git(root, signal, "diff", "--no-ext-diff", "--no-textconv", "--binary", base, head)
  const working = await git(root, signal, "diff", "--no-ext-diff", "--no-textconv", "--binary", head)
  const committedFiles = (await git(root, signal, "diff", "--name-only", "-z", base, head)).split("\0").filter(Boolean)
  const workingFiles = (await git(root, signal, "diff", "--name-only", "-z", head)).split("\0").filter(Boolean)
  const untracked = (await git(root, signal, "ls-files", "--others", "--exclude-standard", "-z")).split("\0").filter(Boolean)
  const prefix = `Committed changes (${base} -> ${head}):\n${committed || "(none)"}\n\n` +
    `Staged and unstaged changes (HEAD -> working tree):\n${working || "(none)"}\n\nUntracked files:\n`
  const patches = await captureUntracked(root, untracked, Buffer.byteLength(prefix), signal)
  const diff = `${prefix}${patches.join("\n\n") || "(none)"}`
  if (!committed && !working && patches.length === 0) throw new Error("No committed or working-tree changes to review.")
  if (Buffer.byteLength(diff) > maximumDiffBytes) oversizedDiff()
  const changedFiles = [...new Set([...committedFiles, ...workingFiles, ...untracked])]
  const workingTreeFiles = [...new Set([...workingFiles, ...untracked])]
  const commitList = await git(root, signal, "log", "--format=%h %s", `${base}..${head}`)
  if (Buffer.byteLength(commitList) > 32 * 1024) throw new Error("Review commit list exceeds the size limit.")
  const standards = await committedStandards(root, base, changedFiles, signal)
  captureRemaining(signal)
  return {
    repository: root, baseRef, baseRefSha, base, head, diff,
    changedFiles, workingTreeFiles, commitList, standards,
  }
}

export interface FleetReport {
  readonly schemaVersion: 1
  readonly status: "complete" | "partial"
  readonly summary: string
  readonly startedAt: string
  readonly completedAt: string
  readonly runId?: string
  readonly repository?: string
  readonly pr: {
    readonly baseSha: string; readonly headSha: string
    readonly number?: null; readonly title?: null; readonly url?: null
    readonly author?: null; readonly isDraft?: null
  }
  readonly agents: ReadonlyArray<{
    readonly name: string; readonly lens: string; readonly model: string
    readonly status: "complete" | "failed" | "timed_out"; readonly error: string
  }>
  readonly counts: Record<(typeof severities)[number], number> & { readonly confirmedTotal: number }
  readonly findings: ReadonlyArray<{
    readonly id: string; readonly severity: (typeof severities)[number]; readonly title: string
    readonly problem: string; readonly evidence: string; readonly path: string
    readonly lineStart: number; readonly lineEnd: number
    readonly currentCode: string; readonly suggestedCode: string
    readonly fixKind: "exact" | "illustrative"; readonly judgmentNotes: string
    readonly reportedBy: ReadonlyArray<string>
  }>
  readonly reportMarkdown: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const validateFleetAgents = (agents: unknown, status: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (!Array.isArray(agents) || agents.length !== 6) throw new Error("Fleet must report six agents.")
  for (const name of fleetLenses) {
    if (agents.filter((agent) => object(agent) && agent.name === name).length !== 1) {
      throw new Error(`Fleet report must contain exactly one ${name} result.`)
    }
  }
  if (agents.some((agent) => !object(agent) || typeof agent.model !== "string" ||
    agent.model !== pinnedFleetModel(String(agent.name)) ||
    !["complete", "failed", "timed_out"].includes(String(agent.status)) ||
    typeof agent.lens !== "string" || typeof agent.error !== "string" ||
    (agent.status !== "complete" && !agent.error))) throw new Error("Fleet agent status or model is invalid.")
  if (status !== (agents.every((agent) => agent.status === "complete") ? "complete" : "partial")) {
    throw new Error("Fleet completeness does not match agent outcomes.")
  }
  return agents
}

const validateFleetCounts = (counts: unknown, findings: unknown[], markdown: string): void => {
  if (!object(counts) || severities.some((key) => !Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0) ||
    !Number.isSafeInteger(counts.confirmedTotal) || (counts.confirmedTotal as number) < 0 ||
    severities.reduce((total, key) => total + (counts[key] as number), 0) !== counts.confirmedTotal ||
    findings.length !== Math.min(counts.confirmedTotal as number, 50)) throw new Error("Fleet counts are inconsistent.")
  const omitted = (counts.confirmedTotal as number) - findings.length
  if (omitted > 0 && (!markdown.includes(String(omitted)) || !markdown.includes(String(counts.confirmedTotal)))) {
    throw new Error("Fleet Markdown does not disclose total and omitted findings.")
  }
  for (const severity of severities) {
    if (findings.filter((finding) => object(finding) && finding.severity === severity).length > (counts[severity] as number)) {
      throw new Error("Fleet finding severity exceeds the full counts.")
    }
    const row = markdown.match(new RegExp(`^\\|\\s*${severity}\\s*\\|\\s*(\\d+)\\s*\\|`, "imu"))
    if (row && Number(row[1]) !== counts[severity]) {
      throw new Error(`Fleet Markdown ${severity} total differs from JSON counts.`)
    }
  }
}

const validFinding = (finding: unknown, agents: ReadonlyArray<Record<string, unknown>>): finding is Record<string, unknown> => {
  if (!object(finding) || typeof finding.id !== "string" ||
    !severities.includes(finding.severity as (typeof severities)[number]) ||
    ["title", "problem", "evidence", "path", "currentCode", "suggestedCode", "judgmentNotes"]
      .some((key) => typeof finding[key] !== "string") ||
    !["exact", "illustrative"].includes(String(finding.fixKind)) ||
    (finding.fixKind === "illustrative" && !finding.judgmentNotes)) return false
  return Number.isSafeInteger(finding.lineStart) && (finding.lineStart as number) > 0 &&
    Number.isSafeInteger(finding.lineEnd) && (finding.lineEnd as number) >= (finding.lineStart as number) &&
    Array.isArray(finding.reportedBy) && finding.reportedBy.length > 0 &&
    finding.reportedBy.every((source: unknown) => typeof source === "string" &&
      agents.some((agent) => agent.status === "complete" && source === `${agent.name} / ${agent.model}`))
}

const validateFleetFindings = (findings: unknown[], agents: ReadonlyArray<Record<string, unknown>>): void => {
  const ids = new Set<string>()
  for (const finding of findings) {
    if (!validFinding(finding, agents) || ids.has(finding.id as string)) {
      throw new Error("Fleet finding is invalid or lacks source attribution.")
    }
    ids.add(finding.id as string)
  }
}

const validateFleetCoverage = (markdown: string, agents: ReadonlyArray<Record<string, unknown>>): void => {
  const coverageStatus = (value: string): string => {
    const label = value.trim().toLowerCase().replace(/[ -]+/gu, "_")
    return label === "incomplete_coverage" ? "failed" : label
  }
  for (const agent of agents) {
    const row = markdown.split("\n").find((line) => line.startsWith(`| ${agent.name} |`))
    if (row && (row.split("|")[2]?.trim() !== agent.model ||
      coverageStatus(row.split("|")[4] ?? "") !== agent.status)) {
      throw new Error(`Fleet Markdown coverage differs from JSON for ${agent.name}.`)
    }
  }
}

const validFleetIdentity = (value: Record<string, unknown>): boolean =>
  (value.runId === undefined || typeof value.runId === "string") &&
  (value.repository === undefined || typeof value.repository === "string")

function assertFleetEnvelope(value: unknown, snapshot: ReviewSnapshot): asserts value is Record<string, unknown> & {
  findings: unknown[]; reportMarkdown: string
} {
  if (!object(value) || value.schemaVersion !== 1 || !object(value.pr)) {
    throw new Error("Fleet JSON needs schemaVersion 1 and a pr object.")
  }
  const pr = value.pr
  if (pr.baseSha !== snapshot.base || pr.headSha !== snapshot.head) {
    throw new Error("Fleet JSON baseSha or headSha differs from the captured review.")
  }
  if (!validFleetIdentity(value)) throw new Error("Fleet run identity is invalid.")
  if (["number", "title", "url", "author", "isDraft"].some((key) => pr[key] != null)) {
    throw new Error("Fleet JSON invented PR metadata for a worktree review.")
  }
  if (!validFleetDates(value)) throw new Error("Fleet JSON summary or timestamps are invalid.")
  if (!Array.isArray(value.findings) || value.findings.length > 50) {
    throw new Error("Fleet JSON findings must be an array with at most 50 items.")
  }
  if (typeof value.reportMarkdown !== "string" || !value.reportMarkdown.includes(snapshot.base) ||
    !value.reportMarkdown.includes(snapshot.head)) {
    throw new Error("Fleet JSON reportMarkdown must include the reviewed base and HEAD SHAs.")
  }
}

const validFleetDates = (value: Record<string, unknown>): boolean =>
  typeof value.summary === "string" && Boolean(value.summary.trim()) &&
  typeof value.startedAt === "string" && isoTime.test(value.startedAt) &&
  typeof value.completedAt === "string" && isoTime.test(value.completedAt)

function assertFleetReport(value: unknown, snapshot: ReviewSnapshot): asserts value is FleetReport {
  assertFleetEnvelope(value, snapshot)
  const agents = validateFleetAgents(value.agents, value.status)
  validateFleetCounts(value.counts, value.findings, value.reportMarkdown)
  validateFleetFindings(value.findings, agents)
  validateFleetCoverage(value.reportMarkdown, agents)
}

export const validateFleetReport = (value: unknown, snapshot: ReviewSnapshot): FleetReport => {
  assertFleetReport(value, snapshot)
  return value
}

export interface ReviewRunOptions {
  readonly repository: string
  readonly baseRef: string
  /** Snapshot shown at confirmation; checked again before SDK work starts. */
  readonly snapshot?: ReviewSnapshot
  readonly selected: ReadonlyArray<string>
  readonly confirmed: true
  readonly signal: AbortSignal
  readonly skills: ReviewSkillOptions
  readonly catalog?: ReadonlyArray<ReviewDefinition>
  readonly clientFactory?: ReviewClientFactory
  readonly timeoutMs?: number
  /** Supplies the owned report directory before sessions start, including on cancellation. */
  readonly onWorkspace?: (directory: string) => void
  readonly onProgress?: (id: string, state: "running" | "complete" | "partial" | "failed") => void
  readonly onOutput?: (id: string, output: ReviewOutput) => void
}

export interface ReviewOutput {
  readonly kind: "text" | "activity"
  readonly text: string
  readonly source?: string
}

export interface ReviewRunResult {
  readonly snapshot: ReviewSnapshot
  readonly reports: ReadonlyArray<ReviewResult>
  readonly synthesis: string
  readonly incomplete: boolean
  readonly directory: string
  readonly cleanupError?: string
}

const confirmedSnapshot = (expected: ReviewSnapshot | undefined, current: ReviewSnapshot): ReviewSnapshot => {
  if (expected && (expected.repository !== current.repository ||
    expected.baseRef !== current.baseRef || expected.baseRefSha !== current.baseRefSha ||
    expected.base !== current.base ||
    expected.head !== current.head || expected.diff !== current.diff ||
    JSON.stringify(expected.changedFiles) !== JSON.stringify(current.changedFiles) ||
    JSON.stringify(expected.workingTreeFiles) !== JSON.stringify(current.workingTreeFiles) ||
    JSON.stringify(expected.standards) !== JSON.stringify(current.standards) ||
    expected.commitList !== current.commitList)) {
    throw new Error("The confirmed review snapshot changed. Confirm the new base, HEAD, and working-tree changes.")
  }
  return expected ?? current
}

const finishReviewRun = async (
  provider: CopilotReviewProvider | undefined,
  workspace: Awaited<ReturnType<typeof prepareReviewWorkspace>>,
  failure: unknown,
): Promise<void> => {
  try {
    if (provider) await provider.close()
    else await workspace.dispose()
  } catch (cleanupError) {
    if (failure !== undefined) {
      throw new AggregateError([failure, cleanupError],
        `Review failed: ${String(failure)}; cleanup failed: ${String(cleanupError)}`)
    }
    throw cleanupError
  }
}

export const persistReviewResult = async (
  work: string, snapshot: ReviewSnapshot, result: ReviewResult,
): Promise<string> => {
  if (!/^[a-z][a-z0-9-]*$/u.test(result.id)) throw new Error("Invalid review result ID.")
  const directory = path.join(work, "docs", "review")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${result.id}-result.json`)
  await writeFile(file, JSON.stringify({
    baseRefSha: snapshot.baseRefSha, baseSha: snapshot.base, headSha: snapshot.head,
    workingTreeFiles: snapshot.workingTreeFiles,
    result,
  }, null, 2), { flag: "wx", mode: 0o600 })
  return file
}

const runSelectedReviews = async (provider: CopilotReviewProvider,
  reviews: ReadonlyArray<ReviewDefinition>, snapshot: ReviewSnapshot, work: string,
  options: ReviewRunOptions): Promise<ReadonlyArray<ReviewResult>> => {
  const settled = await Promise.allSettled(reviews.map(async (review) => {
    options.onProgress?.(review.id, "running")
    const result = await provider.review(review, options.signal)
    await persistReviewResult(work, snapshot, result)
    options.onProgress?.(review.id, result.error ? "failed" : result.fleet?.status === "partial" ? "partial" : "complete")
    return result
  }))
  const reports: ReviewResult[] = []
  const errors: unknown[] = []
  for (const item of settled) {
    if (item.status === "fulfilled") reports.push(item.value)
    else errors.push(item.reason)
  }
  if (errors.length) throw new AggregateError(errors, "One or more review sessions failed before synthesis.")
  return reports
}

const finishWithResult = async (provider: CopilotReviewProvider | undefined,
  workspace: Awaited<ReturnType<typeof prepareReviewWorkspace>>,
  result: ReviewRunResult | undefined, failure: unknown): Promise<ReviewRunResult> => {
  try {
    await finishReviewRun(provider, workspace, failure)
  } catch (error) {
    if (failure !== undefined || !result) throw error
    return { ...result, incomplete: true, cleanupError: String(error) }
  }
  if (failure !== undefined) throw failure
  if (!result) throw new Error("Review finished without a result or a reported error.")
  return result
}

export const runReviews = async (options: ReviewRunOptions): Promise<ReviewRunResult> => {
  if (options.confirmed !== true || options.signal.aborted) throw new Error("Review needs confirmation and an active signal.")
  const reviews = selectReviews(options.selected, options.catalog ?? reviewCatalog)
  const snapshot = confirmedSnapshot(options.snapshot,
    await captureReviewSnapshot(options.repository, options.baseRef, options.signal))
  const workspace = await prepareReviewWorkspace(options.skills, reviews, snapshot.repository, options.signal)
  let provider: CopilotReviewProvider | undefined
  let failure: unknown
  let result: ReviewRunResult | undefined
  try {
    options.onWorkspace?.(workspace.root)
    provider = new CopilotReviewProvider(workspace, snapshot, options.clientFactory, options.timeoutMs, options.onOutput)
    const reports = await runSelectedReviews(provider, reviews, snapshot, workspace.work, options)
    options.onProgress?.("synthesis", "running")
    options.onOutput?.("synthesis", { kind: "activity", text: "Combining reviewer findings." })
    const synthesis = await provider.synthesize(reports, options.signal)
    options.onProgress?.("synthesis", "complete")
    options.onOutput?.("synthesis", { kind: "activity", text: "Combined report saved." })
    result = {
      snapshot, reports, synthesis,
      incomplete: provider.debateIncomplete ||
        reports.some((report) => report.error !== undefined || report.fleet?.status === "partial") ||
        options.signal.aborted,
      directory: workspace.root,
    }
  } catch (error) {
    failure = error
  }
  return finishWithResult(provider, workspace, result, failure)
}
