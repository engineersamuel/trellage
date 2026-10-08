import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises"
import path from "node:path"
import lockfile from "proper-lockfile"
import { optimizeDigest, type OptimizeEvidence } from "./guide-optimize-evidence.ts"
import { parseStoredOptimizeEvidence } from "./review-evidence.ts"
export { parseStoredOptimizeEvidence } from "./review-evidence.ts"
import { parseGuideOptimizeTarget, selectedGuideOptimizeChanges } from "./guide-optimize-target.ts"
import {
  optimizeApproval,
  optimizeReviewCallLimit,
  parseOptimizeChallenge,
  parseOptimizeReport,
  parseOptimizeVerdict,
  type OptimizeApproval,
  type OptimizeReview,
  type OptimizeReviewInput,
} from "./guide-optimize-review.ts"
import { array, boundedNumber, exactKeys, literal, record, stringArray, text, uniqueArray } from "./guide-text.ts"

export interface OptimizeReviewSummary {
  readonly id: string
  readonly createdAt: string
  readonly status: OptimizeReview["status"]
  readonly summary: string
}

export const reviewRecordId = (value: unknown): string => {
  const id = text(value, "review ID", 36)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(id))
    throw new Error("Invalid review ID.")
  return id
}
const uuid = reviewRecordId
const missing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const snapshotRecordBytes = 96_000_000
const privateFile = (metadata: Stats): void => {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o600
  )
    throw new Error("Optimize records require owned, single-link mode-0600 files.")
}
const model = (input: unknown) => {
  const value = record(input, "model")
  exactKeys(value, "model", ["model", "effort"])
  return {
    model: text(value.model, "model", 256),
    effort: literal(value.effort, "effort", ["low", "medium", "high", "xhigh", "max"]),
  }
}

const parseInput = (input: unknown): OptimizeReviewInput => {
  const fields = record(input, "review input")
  exactKeys(fields, "review input", ["target", "paths", "reviewerIds"], ["originalIntent", "intent"])
  const target = parseGuideOptimizeTarget(fields.target)
  const paths = array(fields.paths, "paths", { minimum: 1, maximum: 5000 }).map((value) =>
    text(value, "path", 4096, { preserve: true }),
  )
  selectedGuideOptimizeChanges(target, paths)
  return {
    target,
    paths,
    reviewerIds: uniqueArray(
      stringArray(fields.reviewerIds, "reviewerIds", {
        minimum: 1,
        maximumItems: 3,
        itemMaximum: 100,
      }),
      "reviewerIds",
      "IDs",
    ),
    ...(fields.originalIntent === undefined
      ? {}
      : { originalIntent: text(fields.originalIntent, "originalIntent", 60_000, { multiline: true, preserve: true }) }),
    ...(fields.intent === undefined
      ? {}
      : { intent: text(fields.intent, "intent", 60_000, { multiline: true, preserve: true }) }),
  }
}

const parseEvidence = parseStoredOptimizeEvidence

const parseReview = (serialized: unknown, evidence: OptimizeEvidence): OptimizeReview => {
  const fields = record(serialized, "saved review")
  exactKeys(fields, "saved review", [
    "schemaVersion",
    "id",
    "createdAt",
    "input",
    "evidenceFingerprint",
    "reviewers",
    "coordinator",
    "status",
    "reports",
    "challenges",
    "decisions",
    "summary",
    "error",
    "calls",
    "approvedIds",
    "execution",
  ])
  if (fields.schemaVersion !== 1 || fields.evidenceFingerprint !== evidence.fingerprint)
    throw new Error("Saved review version or evidence differs.")
  const input = parseInput(fields.input)
  const reviewers = array(fields.reviewers, "reviewers", { minimum: 1, maximum: 3 }).map((value) => {
    const entry = record(value, "reviewer")
    exactKeys(entry, "reviewer", ["id", "title", "description", "prompt", "model"])
    return {
      id: text(entry.id, "reviewer ID", 100),
      title: text(entry.title, "title", 160),
      description: text(entry.description, "description", 1000),
      prompt: text(entry.prompt, "prompt", 4000, { multiline: true }),
      model: model(entry.model),
    }
  })
  if (JSON.stringify(reviewers.map((entry) => entry.id)) !== JSON.stringify(input.reviewerIds))
    throw new Error("Saved review participants differ from the request.")
  const reports = array(fields.reports, "reports", { maximum: 3 }).map((value) => {
    const id = text(record(value, "report").reviewerId, "reviewerId", 100)
    if (!input.reviewerIds.includes(id)) throw new Error("Unknown reviewer in saved report.")
    return parseOptimizeReport(value, id, input, evidence)
  })
  uniqueArray(
    reports.map((entry) => entry.reviewerId),
    "reports",
    "reviewers",
  )
  const bytes = evidence.sources.reduce((total, source) => total + Buffer.byteLength(source.content), 0)
  const calls = boundedNumber(fields.calls, "calls", 0, optimizeReviewCallLimit(reviewers.length, bytes))
  if (!Number.isInteger(calls)) throw new Error("Invalid model call count.")
  let review: OptimizeReview = {
    schemaVersion: 1,
    id: uuid(fields.id),
    createdAt: text(fields.createdAt, "createdAt", 80),
    input,
    evidence,
    reviewers,
    coordinator: model(fields.coordinator),
    status: literal(fields.status, "status", ["running", "complete", "incomplete", "cancelled"]),
    reports,
    challenges: [],
    decisions: [],
    summary: text(fields.summary, "summary", 1600, { multiline: true }),
    error: fields.error === null ? null : text(fields.error, "error", 8000, { multiline: true }),
    calls,
    approvedIds: stringArray(fields.approvedIds, "approvedIds", { maximumItems: 12 }),
    execution: literal(fields.execution, "execution", ["not-started", "launching", "launched", "unknown"]),
  }
  const challenges = array(fields.challenges, "challenges", { maximum: 3 }).map((value) => {
    const id = text(record(value, "challenge").reviewerId, "reviewerId", 100)
    if (!input.reviewerIds.includes(id)) throw new Error("Unknown reviewer in challenge.")
    return parseOptimizeChallenge(value, id, review)
  })
  uniqueArray(
    challenges.map((entry) => entry.reviewerId),
    "challenges",
    "reviewers",
  )
  review = { ...review, challenges }
  return validateCompletedReview(review, fields.decisions)
}

const validateCompletedReview = (review: OptimizeReview, input: unknown): OptimizeReview => {
  if (review.status !== "complete") {
    if (array(input, "decisions").length || review.approvedIds.length || review.execution !== "not-started")
      throw new Error("Incomplete review cannot authorize implementation.")
    return review
  }
  if (review.reports.length !== review.reviewers.length || review.error !== null)
    throw new Error("Complete review is missing reports.")
  const expectedChallenges = review.reports.some((entry) => entry.findings.length > 0) ? review.reviewers.length : 0
  if (review.challenges.length !== expectedChallenges) throw new Error("Complete review is missing challenge replies.")
  const requiredCalls = review.reviewers.length + expectedChallenges + 1
  if (review.calls < requiredCalls || review.calls > requiredCalls * 2)
    throw new Error("Complete review has an invalid model request count.")
  const verdict = parseOptimizeVerdict({ summary: review.summary, decisions: input }, review)
  const result = { ...review, ...verdict }
  if (result.approvedIds.length > 0) optimizeApproval({ ...result, execution: "not-started" }, result.approvedIds)
  else if (result.execution !== "not-started") throw new Error("Unapproved review cannot authorize execution.")
  return result
}

export class PrivateReviewRecords {
  readonly directory: string
  constructor(protected readonly gitDirectory: string, namespace: "trellage-optimize-reviews" | "trellage-reviews") {
    this.directory = path.join(gitDirectory, namespace)
  }

  protected async ensure(): Promise<void> {
    const git = await lstat(this.gitDirectory)
    if (
      !git.isDirectory() ||
      git.isSymbolicLink() ||
      git.uid !== process.getuid?.() ||
      (await realpath(this.gitDirectory)) !== this.gitDirectory
    )
      throw new Error("Unsafe Optimize Git metadata directory.")
    try {
      await mkdir(this.directory, { mode: 0o700 })
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause
    }
    const info = await lstat(this.directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700
    )
      throw new Error("Optimize state directory must be owned, real, and mode 0700.")
  }

  async hasRecord(id: string): Promise<boolean> {
    const filename = `${uuid(id)}.json`
    await this.ensure()
    try {
      privateFile(await lstat(path.join(this.directory, filename)))
      return true
    } catch (cause) {
      if (missing(cause)) return false
      throw cause
    }
  }

  protected async readData(filename: string, maximum = 2_000_000): Promise<unknown> {
    await this.ensure()
    const handle = await open(
      path.join(this.directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const before = await handle.stat()
      privateFile(before)
      if (before.size > maximum) throw new Error("Optimize record exceeds its byte limit.")
      const buffer = Buffer.alloc(before.size + 1)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (result.bytesRead === 0) break
        bytesRead += result.bytesRead
      }
      const after = await handle.stat()
      const current = await lstat(path.join(this.directory, filename))
      privateFile(current)
      if (
        bytesRead !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new Error("Optimize record changed while reading.")
      if (current.ino !== before.ino || current.dev !== before.dev)
        throw new Error("Optimize record was replaced while reading.")
      const envelope = record(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))),
        "record",
      )
      exactKeys(envelope, "record", ["digest", "data"])
      if (envelope.digest !== optimizeDigest(envelope.data)) throw new Error("Saved Optimize record was changed.")
      return envelope.data
    } finally {
      await handle.close()
    }
  }

  protected async writeData(filename: string, data: unknown, maximum = 2_000_000): Promise<void> {
    await this.ensure()
    const encoded = `${JSON.stringify({ digest: optimizeDigest(data), data })}\n`
    if (Buffer.byteLength(encoded) > maximum)
      throw new Error("Optimize record exceeds its byte limit; it was not published.")
    const destination = path.join(this.directory, filename)
    try {
      privateFile(await lstat(destination))
    } catch (cause) {
      if (!missing(cause)) throw cause
    }
    const temporary = `${destination}.${randomUUID()}.tmp`
    const handle = await open(temporary, "wx", 0o600)
    try {
      try {
        await handle.writeFile(encoded)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.ensure()
      await rename(temporary, destination)
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (cause) {
      try {
        await unlink(temporary)
      } catch (cleanup) {
        if (!missing(cleanup))
          throw new AggregateError([cause, cleanup], "Optimize save and cleanup failed.", { cause: cleanup })
      }
      throw cause
    }
  }

  protected async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensure()
    try {
      const info = await lstat(`${this.directory}.lock`)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.())
        throw new Error("Unsafe Optimize record lock.")
    } catch (cause) {
      if (!missing(cause)) throw cause
    }
    const release = await lockfile.lock(this.directory, { realpath: false, retries: 0 })
    try {
      return await operation()
    } finally {
      await release()
    }
  }

}

export class OptimizeReviewStore extends PrivateReviewRecords {
  constructor(gitDirectory: string) {
    super(gitDirectory, "trellage-optimize-reviews")
  }

  async save(review: OptimizeReview): Promise<void> {
    const id = uuid(review.id)
    if (review.input.target.gitDirectory !== this.gitDirectory) throw new Error("Review belongs to another worktree.")
    const { evidence, ...state } = review
    const data = { ...state, evidenceFingerprint: evidence.fingerprint }
    parseReview(data, evidence)
    await this.locked(async () => {
      try {
        const previous = record(await this.readData(`${id}.json`), "previous review")
        if (previous.status !== "running" || previous.execution !== "not-started")
          throw new Error("Completed review evidence cannot be replaced.")
      } catch (cause) {
        if (!missing(cause)) throw cause
        if (review.status !== "running" || review.approvedIds.length > 0)
          throw new Error("Save the initial review before it can finish.", { cause })
      }
      const snapshot = `${id}.snapshot.json`
      try {
        const existing = record(await this.readData(snapshot, snapshotRecordBytes), "snapshot")
        if (existing.fingerprint !== evidence.fingerprint) throw new Error("Review snapshot cannot be replaced.")
      } catch (cause) {
        if (!missing(cause)) throw cause
        await this.writeData(snapshot, evidence, snapshotRecordBytes)
      }
      await this.writeData(`${id}.json`, data)
    })
  }

  async read(id: string): Promise<OptimizeReview> {
    const key = uuid(id)
    const evidence = parseEvidence(await this.readData(`${key}.snapshot.json`, snapshotRecordBytes))
    const review = parseReview(await this.readData(`${key}.json`), evidence)
    if (review.id !== key || review.input.target.gitDirectory !== this.gitDirectory)
      throw new Error("Review identity differs from this worktree.")
    return review
  }

  async list(): Promise<ReadonlyArray<OptimizeReviewSummary>> {
    await this.ensure()
    const filenames = (await readdir(this.directory)).filter(
      (name) => name.endsWith(".json") && !name.endsWith(".snapshot.json"),
    )
    if (filenames.length > 128)
      throw new Error("Too many saved reviews; archive completed review records before continuing.")
    const summaries: OptimizeReviewSummary[] = []
    for (const filename of filenames) {
      const id = uuid(filename.slice(0, -5))
      const fields = record(await this.readData(filename), "review")
      if (fields.id !== id) throw new Error("Review filename and ID differ.")
      summaries.push({
        id,
        createdAt: text(fields.createdAt, "createdAt", 80),
        status: literal(fields.status, "status", ["running", "complete", "incomplete", "cancelled"]),
        summary: text(fields.summary, "summary", 1600, { multiline: true }),
      })
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async approve(id: string, ids: ReadonlyArray<string>): Promise<OptimizeApproval> {
    return this.locked(async () => {
      const current = await this.read(id)
      const approval = optimizeApproval(current, ids)
      await this.writeState({ ...current, approvedIds: [...ids] })
      return approval
    })
  }

  private async writeState(review: OptimizeReview): Promise<void> {
    const { evidence, ...state } = review
    const data = { ...state, evidenceFingerprint: evidence.fingerprint }
    parseReview(data, evidence)
    await this.writeData(`${uuid(review.id)}.json`, data)
  }

  async approved(approval: OptimizeApproval): Promise<OptimizeReview> {
    const review = await this.read(approval.reviewId)
    const expected = optimizeApproval(review, review.approvedIds)
    if (optimizeDigest(expected) !== optimizeDigest(approval))
      throw new Error("Approval differs from the saved review.")
    return review
  }

  async beginExecution(approval: OptimizeApproval): Promise<void> {
    await this.locked(async () => {
      const review = await this.approved(approval)
      await this.writeState({ ...review, execution: "launching" })
    })
  }

  async finishExecution(id: string, state: "launched" | "unknown"): Promise<void> {
    await this.locked(async () => {
      const review = await this.read(id)
      if (review.execution !== "launching") throw new Error("Review execution was not reserved.")
      await this.writeState({ ...review, execution: state })
    })
  }
}
