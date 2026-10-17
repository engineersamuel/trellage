import { lstat } from "node:fs/promises"
import path from "node:path"
import { CommandRunnerError, type CommandRunner } from "./guide-launch.ts"
import {
  optimizeDigest,
  optimizeEvidenceLimits,
  type OptimizeEvidence,
  type OptimizeSource,
} from "./review-source.ts"
import { assertGuideReviewTargetCurrent } from "./review-target.ts"
import { selectReviewChecks } from "./review-catalog.ts"
import type { ReviewEvidence, ReviewRequest, ReviewExecutionPolicy } from "./review-contracts.ts"
import type { ReviewSnapshot } from "./review-run.ts"
import { reviewSnapshotBytes } from "./review-context.ts"
import { array, exactKeys, literal, record, stringArray, text, uniqueArray } from "./guide-text.ts"

export { optimizeEvidenceTools } from "./review-source.ts"
export { reviewContextBudget, reviewTokenUpperBound, reviewSnapshotBytes } from "./review-context.ts"
export { ReviewSnapshotReader, snapshotBatches, snapshotSliceText, type ReviewSlice } from "./review-snapshot.ts"

// A local capture/storage safety bound, not a model context limit.
export const reviewPatchBytes = reviewSnapshotBytes
const standardsPaths = ["AGENTS.md", "CONTRIBUTING.md", "CODING_STANDARDS.md"]
type Git = (args: ReadonlyArray<string>) => Promise<string>
const patchFlags = ["--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--unified=5"]

const evidenceRequirements = (request: ReviewRequest) => {
  const checks = selectReviewChecks(request.checks.map((check) => check.id))
  return { requiresHead: checks.some((check) => check.requiresHead) }
}

export const maximumReviewCalls = (ids: ReadonlyArray<string>, batches: number): number => {
  if (!Number.isInteger(batches) || batches < 1 || batches > 128) throw new Error("Invalid review batch allowance.")
  const checks = selectReviewChecks(ids)
  const independent = checks.reduce(
    (count, check) => count + (check.kind === "fleet" ? 16 : check.kind === "two-axis" ? 6 : 4),
    0,
  )
  return independent * batches + 14
}

export const reviewExecutionPolicy = (
  ids: ReadonlyArray<string>,
  evidence?: OptimizeEvidence,
): ReviewExecutionPolicy => {
  const checks = selectReviewChecks(ids)
  const bytes = evidence?.sources.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0) ?? 0
  const batches = Math.max(1, Math.min(128, Math.ceil(bytes / 4096)))
  return {
    maximumCalls: maximumReviewCalls(ids, batches),
    maximumFindings: checks.reduce((count, check) => count + check.maximumFindings, 0),
    maximumPeerRounds: 2,
    maximumQuestionsPerRound: 4,
  }
}

export const parseStoredOptimizeEvidence = (input: unknown): OptimizeEvidence => {
  const fields = record(input, "evidence")
  exactKeys(fields, "evidence", ["fingerprint", "sources", "excluded"])
  const sources = array(fields.sources, "sources", { maximum: optimizeEvidenceLimits.files * 2 + 8 }).map((value) => {
    const entry = record(value, "source")
    exactKeys(entry, "source", ["id", "content"])
    if (typeof entry.content !== "string") throw new Error("Source content must be text.")
    return { id: text(entry.id, "id", 4096, { preserve: true }), content: entry.content }
  })
  uniqueArray(
    sources.map((source) => source.id),
    "sources",
    "IDs",
  )
  if (
    sources.reduce((bytes, source) => bytes + Buffer.byteLength(source.content), 0) > optimizeEvidenceLimits.totalBytes
  )
    throw new Error("Saved evidence exceeds the 32 MB local storage safety limit.")
  const excluded = array(fields.excluded, "excluded", { maximum: 5000 }).map((value) => {
    const entry = record(value, "excluded source")
    exactKeys(entry, "excluded source", ["path", "reason"])
    return { path: text(entry.path, "path", 4096, { preserve: true }), reason: text(entry.reason, "reason", 400) }
  })
  const fingerprint = text(fields.fingerprint, "fingerprint", 64)
  if (fingerprint !== optimizeDigest({ sources, excluded })) throw new Error("Saved review evidence was changed.")
  return { sources, excluded, fingerprint }
}

export const reviewIncompatibilities = (request: ReviewRequest): ReadonlyArray<string> => {
  const requirements = evidenceRequirements(request)
  const errors: string[] = []
  if (request.target.head === null && requirements.requiresHead)
    errors.push("Installed skill checks require HEAD. Select built-in checks or commit before a new review.")
  if (request.paths.length === 0 || new Set(request.paths).size !== request.paths.length)
    errors.push("Select one or more distinct changed paths.")
  for (const path of request.paths) {
    const change = request.target.changes.find((entry) => entry.path === path)
    if (!change) errors.push(`Path is not in the confirmed target: ${JSON.stringify(path)}.`)
    else if (change.kind === "unsupported")
      errors.push(`Selected checks cannot review ${JSON.stringify(path)}. Change the check or file selection.`)
  }
  return errors
}

export const planReviewEvidence = (request: ReviewRequest, frozen: ReviewEvidence, checkId: string) => {
  if (!request.checks.some((check) => check.id === checkId)) throw new Error("Unselected evidence check.")
  const check = selectReviewChecks([checkId])[0]!
  if (check.requiresHead && request.target.head === null) throw new Error("Selected review requires HEAD.")
  const ids = frozen.patch?.sourceIds
  if (!ids) throw new Error("Selected skill checks lack a frozen patch manifest.")
  if (ids.some((id) => !frozen.source.sources.some((source) => source.id === id)))
    throw new Error("Patch references differ from frozen source evidence.")
  const projection = { sources: frozen.source.sources.filter((source) => ids.includes(source.id)), excluded: [] }
  return { evidence: { ...projection, fingerprint: optimizeDigest(projection) }, requiredSources: ids }
}

const captureUntracked = async (git: Git, cwd: string, filename: string): Promise<OptimizeSource> => {
  const stat = await lstat(path.join(cwd, filename))
  if ((!stat.isFile() && !stat.isSymbolicLink()) || stat.size > reviewPatchBytes)
    throw new Error(`Unsupported or oversized untracked path: ${JSON.stringify(filename)}`)
  try {
    await git(["diff", ...patchFlags, "--no-index", "--", "/dev/null", filename])
    throw new Error(`Untracked file did not produce a patch: ${JSON.stringify(filename)}`)
  } catch (error) {
    if (!(error instanceof CommandRunnerError) || error.kind !== "exited" || error.exitCode !== 1) throw error
    return { id: `@diff/untracked/${filename}`, content: error.stdout }
  }
}

const capturePatchSources = async (git: Git, request: ReviewRequest) => {
  const { target, paths } = request
  if (target.head === null) throw new Error("Skill review requires HEAD.")
  const sources: OptimizeSource[] = []
  let bytes = 0
  const add = (source: OptimizeSource): void => {
    bytes += Buffer.byteLength(source.content)
    if (bytes > reviewPatchBytes)
      throw new Error("Frozen patch exceeds the 32 MB local storage safety limit; nothing was truncated.")
    sources.push(source)
  }
  const literal = paths.map((name) => `:(literal)${name}`)
  const flags = patchFlags
  const commands: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["@diff/staged", ["diff", "--cached", ...flags, "--", ...literal]],
    ["@diff/unstaged", ["diff", ...flags, "--", ...literal]],
    ...(target.base
      ? [["@diff/committed", ["diff", ...flags, target.base.mergeBase, target.head, "--", ...literal]] as const]
      : []),
  ]
  for (const [id, command] of commands) add({ id, content: await git(command) })
  const net = await git(["diff", ...flags, target.base?.mergeBase ?? target.head, "--", ...literal])
  const existingNet = sources.find((source) => source.content === net)
  const primarySourceIds = [existingNet?.id ?? "@diff/net"]
  if (!existingNet) add({ id: "@diff/net", content: net })
  const untracked = target.changes.filter((change) => change.untracked && paths.includes(change.path))
  if (untracked.length > 1024) throw new Error("Review snapshot exceeds 1024 untracked paths.")
  for (const change of untracked) {
    const source = await captureUntracked(git, target.cwd, change.path)
    add(source)
    primarySourceIds.push(source.id)
  }
  return { sources, primarySourceIds }
}

const captureStandards = async (git: Git, base: string) => {
  const standards: { path: string; content: string }[] = []
  for (const name of standardsPaths) {
    const entry = await git(["ls-tree", base, "--", name])
    if (!entry) continue
    if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t/u.test(entry))
      throw new Error(`Pinned standard must be a regular tracked file: ${name}`)
    const content = await git(["show", `${base}:${name}`])
    if (Buffer.byteLength(content) > 32 * 1024) throw new Error(`Pinned standard exceeds size limit: ${name}`)
    standards.push({ path: name, content })
  }
  return standards
}

const patchProjection = async (
  git: Git,
  request: ReviewRequest,
  sources: ReadonlyArray<OptimizeSource>,
  primarySourceIds: ReadonlyArray<string>,
): Promise<ReviewSnapshot> => {
  const { target, paths } = request
  if (target.head === null) throw new Error("Skill review requires HEAD.")
  const diff = "Frozen patch sources: " + sources.map((source) => source.id).join(", ")
  const base = target.base?.mergeBase ?? target.head
  const standards = await captureStandards(git, base)
  const commitList = await git(["log", "--format=%h %s", `${base}..${target.head}`])
  if (Buffer.byteLength(commitList) > 32 * 1024) throw new Error("Review commit list exceeds the size limit.")
  return {
    repository: target.cwd,
    baseRef: target.base?.ref ?? "HEAD",
    baseRefSha: target.base?.commit ?? target.head,
    base,
    head: target.head,
    diff,
    sourceIds: sources.map((source) => source.id),
    primarySourceIds,
    changedFiles: paths,
    workingTreeFiles: target.changes
      .filter((change) => paths.includes(change.path) && (change.staged || change.unstaged || change.untracked))
      .map((change) => change.path),
    standards,
    commitList,
  }
}

export const captureSharedReviewEvidence = async (
  runner: CommandRunner,
  request: ReviewRequest,
  signal: AbortSignal,
): Promise<ReviewEvidence> => {
  const incompatible = reviewIncompatibilities(request)
  if (incompatible.length) throw new Error(incompatible.join("\n"))
  const { target } = request
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  const git: Git = async (args) =>
    (
      await runner.run(
        "git",
        ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
        {
          cwd: target.cwd,
          signal: bounded,
          timeoutMs: 15_000,
          outputOverflow: "terminate",
          outputLimitBytes: reviewPatchBytes,
          env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
        },
      )
    ).stdout
  await assertGuideReviewTargetCurrent(runner, target, bounded)
  if (target.head === null) throw new Error("Skill review requires a committed baseline.")
  const { sources, primarySourceIds } = await capturePatchSources(git, request)
  const patch = await patchProjection(git, request, sources, primarySourceIds)
  const source = { sources, excluded: [], fingerprint: optimizeDigest({ sources, excluded: [] }) }
  await assertGuideReviewTargetCurrent(runner, target, bounded)
  const evidence = { source, ...(patch ? { patch } : {}) }
  return { ...evidence, fingerprint: optimizeDigest(evidence) }
}

const validatePatchSources = (patch: Record<string, unknown>, source: OptimizeEvidence): void => {
  const ids = uniqueArray(
    stringArray(patch.sourceIds, "patch source IDs", {
      minimum: 1,
      maximumItems: 5005,
      itemMaximum: 4096,
    }),
    "patch source IDs",
    "IDs",
  )
  const primary = uniqueArray(
    stringArray(patch.primarySourceIds, "primary patch sources", {
      minimum: 1,
      maximumItems: 5005,
      itemMaximum: 4096,
    }),
    "primary patch sources",
    "IDs",
  )
  const available = source.sources.filter((entry) => entry.id.startsWith("@diff/"))
  if (
    ids.length !== available.length ||
    ids.some((id) => !available.some((entry) => entry.id === id)) ||
    primary.some((id) => !ids.includes(id))
  )
    throw new Error("Patch references differ from frozen source evidence.")
  if (available.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.content), 0) > reviewPatchBytes)
    throw new Error("Frozen patch exceeds its local storage safety limit.")
}

const validatePatchIdentity = (patch: Record<string, unknown>, request: ReviewRequest): void => {
  const target = request.target
  const expected = {
    repository: target.cwd,
    head: target.head,
    base: target.base?.mergeBase ?? target.head,
    baseRefSha: target.base?.commit ?? target.head,
    baseRef: target.base?.ref ?? "HEAD",
  }
  if (target.head === null || Object.entries(expected).some(([key, value]) => patch[key] !== value))
    throw new Error("Patch identity differs from the confirmed target.")
}

const validateStandards = (input: unknown): void => {
  if (input === undefined) return
  for (const item of array(input, "standards", { maximum: standardsPaths.length })) {
    const standard = record(item, "standard")
    exactKeys(standard, "standard", ["path", "content"])
    literal(standard.path, "standard path", standardsPaths)
    if (typeof standard.content !== "string" || Buffer.byteLength(standard.content) > 32 * 1024)
      throw new Error("Pinned standard exceeds its byte limit.")
  }
}

const validatePatchProjection = (input: unknown, request: ReviewRequest, source: OptimizeEvidence): void => {
  const patch = record(input, "patch")
  exactKeys(
    patch,
    "patch",
    ["repository", "baseRef", "baseRefSha", "base", "head", "diff", "changedFiles", "workingTreeFiles"],
    ["standards", "commitList", "sourceIds", "primarySourceIds"],
  )
  validatePatchIdentity(patch, request)
  const target = request.target
  if (JSON.stringify(patch.changedFiles) !== JSON.stringify(request.paths)) throw new Error("Patch scope differs.")
  const working = target.changes
    .filter((change) => request.paths.includes(change.path) && (change.staged || change.unstaged || change.untracked))
    .map((change) => change.path)
  if (JSON.stringify(patch.workingTreeFiles) !== JSON.stringify(working))
    throw new Error("Patch working-tree scope differs.")
  if (typeof patch.diff !== "string" || Buffer.byteLength(patch.diff) > reviewPatchBytes)
    throw new Error("Patch exceeds its byte limit.")
  if (patch.sourceIds !== undefined) validatePatchSources(patch, source)
  else if (patch.primarySourceIds !== undefined) throw new Error("Primary patch sources require a source manifest.")
  if (
    patch.commitList !== undefined &&
    (typeof patch.commitList !== "string" || Buffer.byteLength(patch.commitList) > 32 * 1024)
  )
    throw new Error("Commit list exceeds its byte limit.")
  validateStandards(patch.standards)
}

export const validateSharedReviewEvidence = (
  evidence: Record<string, unknown>,
  request: ReviewRequest,
  source: OptimizeEvidence,
): void => {
  validatePatchProjection(evidence.patch, request, source)
  if (
    evidence.fingerprint !==
    optimizeDigest({ source, ...(evidence.patch === undefined ? {} : { patch: evidence.patch }) })
  )
    throw new Error("Shared snapshot changed.")
}
