import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { promisify } from "node:util"

import { findTrellageRoot } from "./trellage-root.ts"

const execFileAsync = promisify(execFile)
export const sandboxBridgeMaximumOutputBytes = 512 * 1024

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const parseBridgeResult = (source, identity) => {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("The Trellage Sandbox session bridge returned invalid JSON.")
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.agent !== identity.agent ||
    value.profile !== identity.profile ||
    typeof value.session_id !== "string" ||
    value.session_id.length === 0 ||
    typeof value.answer !== "string" ||
    value.answer.trim().length === 0
  ) {
    throw new Error("The Trellage Sandbox session bridge returned mismatched session data.")
  }
  return value
}

const defaultBridgeRunner = async ({ identity, env, cwd }) => {
  const repositoryRoot = await findTrellageRoot(import.meta.dirname)
  const command = path.join(repositoryRoot, "prototypes", "trellage", "trellage")
  const args = [
    "--profile",
    identity.profile,
    "session",
    "final-message",
    "--agent",
    identity.agent,
    "--container-id",
    identity.containerId,
    "--invocation",
    identity.invocationId,
  ]
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: sandboxBridgeMaximumOutputBytes,
      timeout: 30_000,
    })
    return result.stdout
  } catch (error) {
    const detail = typeof error?.stderr === "string" ? error.stderr.trim() : ""
    throw new Error(detail || "The Trellage Sandbox session bridge could not read the completed result.")
  }
}

export const captureSandboxFinalMessage = async ({
  identity,
  cwd,
  env = process.env,
  bridgeRunner = defaultBridgeRunner,
}) => {
  const value = parseBridgeResult(await bridgeRunner({ identity, env, cwd }), identity)
  return {
    text: value.answer,
    source: "sandbox-transcript",
    agent: identity.agent,
    sessionId: value.session_id,
    identitySource: "trellage-sandbox-bridge",
    profile: identity.profile,
  }
}

export const sandboxConversationMaximumOutputBytes = 2 * 1024 * 1024
export const sandboxConversationMaximumBytes = 32 * 1024 * 1024
export const sandboxConversationMaximumMessages = 50_000
export const sandboxConversationMaximumPages = 512
export const sandboxConversationProcessTimeoutMs = 30_000
export const sandboxConversationReleaseTimeoutMs = 5_000
export const sandboxConversationKillGraceMs = 250
export const sandboxConversationReapTimeoutMs = 1_000

const opaqueId = /^[a-f0-9]{64}$/u
const opaqueCursor = /^[a-f0-9]{128}$/u
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u
const messageIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

interface SandboxConversationIdentity {
  readonly agent: string
  readonly profile: string
  readonly containerId: string
  readonly invocationId: string
  readonly sessionId?: string
}

interface SandboxConversationRunnerInput {
  readonly identity: SandboxConversationIdentity
  readonly cwd?: string
  readonly env: NodeJS.ProcessEnv
  readonly operation: string
  readonly signal?: AbortSignal
  readonly cursor?: string
  readonly snapshotId?: string
}

interface SandboxConversationOptions {
  readonly identity: SandboxConversationIdentity
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly cleanupTimeoutMs?: number
  readonly bridgeRunner?: (input: SandboxConversationRunnerInput) => Promise<string>
}

interface SandboxBridgeProcessOptions {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly spawnProcess?: typeof spawn
}

const conversationProcessFailure = (detail: string) => {
  if (/budget|too large/u.test(detail)) {
    return new Error("The Sandbox conversation exceeds its capture budget.")
  }
  if (/invalid choice|requires the final-message subcommand/u.test(detail)) {
    return new Error("This Sandbox bridge does not support conversation export. Rebuild and reattach the container.")
  }
  return new Error("The Sandbox conversation bridge failed. Check the exact container and bridge version.")
}

const checkedTimeBudget = (value: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("The Sandbox conversation time budget is invalid.")
  }
  return value
}

class SandboxBridgeProcess {
  readonly child: ChildProcess
  readonly options: SandboxBridgeProcessOptions
  readonly resolve: (value: string) => void
  readonly reject: (reason: unknown) => void
  readonly output = { chunks: [] as Buffer[], bytes: 0, limit: sandboxConversationMaximumOutputBytes }
  readonly diagnostics = { chunks: [] as Buffer[], bytes: 0, limit: 64 * 1024 }
  settled = false
  stopping = false
  failure: unknown
  deadline: ReturnType<typeof setTimeout> | undefined
  killTimer: ReturnType<typeof setTimeout> | undefined
  reapTimer: ReturnType<typeof setTimeout> | undefined
  readonly abort = () => this.stop(this.options.signal?.reason ?? new Error("Sandbox capture was cancelled."))

  constructor(
    options: SandboxBridgeProcessOptions,
    resolve: (value: string) => void,
    reject: (reason: unknown) => void,
  ) {
    this.options = options
    this.resolve = resolve
    this.reject = reject
    this.child = (options.spawnProcess ?? spawn)(options.command, [...options.args], {
      cwd: options.cwd, env: options.env,
      // A referenced child in its own group lets cancellation reach only this request's helpers.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.child.stdout?.on("data", (chunk) => this.collect(this.output, chunk))
    this.child.stderr?.on("data", (chunk) => this.collect(this.diagnostics, chunk))
    this.child.once("close", (code) => this.complete(code))
    this.child.once("error", () => {
      this.stop(new Error("The Sandbox conversation bridge process could not start."))
      if (this.child.pid === undefined) this.complete(null)
    })
    this.deadline = setTimeout(
      () => this.stop(new Error("The Sandbox conversation bridge exceeded its time budget.")),
      options.timeoutMs,
    )
    options.signal?.addEventListener("abort", this.abort, { once: true })
    if (options.signal?.aborted) this.abort()
  }

  collect(target: { chunks: Buffer[]; bytes: number; limit: number }, data: Buffer) {
    if (this.settled || this.stopping) return
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data)
    target.bytes += chunk.length
    if (target.bytes > target.limit) {
      this.stop(new Error("The Sandbox conversation bridge exceeded its response budget."))
      return
    }
    target.chunks.push(chunk)
  }

  signalOwnedProcess(signal: NodeJS.Signals) {
    if (this.settled || this.child.pid === undefined) return
    try {
      if (process.platform === "win32") this.child.kill(signal)
      else process.kill(-this.child.pid, signal)
    } catch (error) {
      // The child can be signalled before its new process group is ready, or after it has exited.
      if (error?.code === "ESRCH") {
        try {
          this.child.kill(signal)
        } catch {
          // An already-exited owned child will still emit close and be reaped normally.
        }
      }
    }
  }

  stop(reason: unknown) {
    if (this.settled || this.stopping) return
    this.stopping = true
    this.failure = reason
    this.signalOwnedProcess("SIGTERM")
    this.killTimer = setTimeout(() => {
      this.signalOwnedProcess("SIGKILL")
      this.reapTimer = setTimeout(() => this.finishUnresponsive(), sandboxConversationReapTimeoutMs)
    }, sandboxConversationKillGraceMs)
  }

  finishUnresponsive() {
    if (this.settled) return
    this.child.stdout?.destroy()
    this.child.stderr?.destroy()
    this.child.unref()
    this.complete(null)
  }

  complete(code: number | null) {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.deadline)
    clearTimeout(this.killTimer)
    clearTimeout(this.reapTimer)
    this.options.signal?.removeEventListener("abort", this.abort)
    const result = this.stopping ? this.failure : conversationProcessFailure(Buffer.concat(this.diagnostics.chunks).toString("utf8"))
    const output = !this.stopping && code === 0 ? Buffer.concat(this.output.chunks).toString("utf8") : undefined
    this.output.chunks = []
    this.diagnostics.chunks = []
    if (output !== undefined) this.resolve(output)
    else this.reject(result)
  }
}

export const runSandboxConversationProcess = async (
  options: SandboxBridgeProcessOptions,
): Promise<string> => {
  options.signal?.throwIfAborted()
  const timeoutMs = checkedTimeBudget(
    options.timeoutMs ?? sandboxConversationProcessTimeoutMs, sandboxConversationProcessTimeoutMs,
  )
  return new Promise((resolve, reject) => {
    try {
      new SandboxBridgeProcess({ ...options, timeoutMs }, resolve, reject)
    } catch {
      reject(new Error("The Sandbox conversation bridge process could not start."))
    }
  })
}

const boundedConversationCleanup = async (
  operation: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
) => {
  const controller = new AbortController()
  const failure = new Error("The Sandbox conversation snapshot release exceeded its time budget.")
  let deadline: ReturnType<typeof setTimeout> | undefined
  let reapDeadline: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => {
      controller.abort(failure)
      reapDeadline = setTimeout(
        () => reject(failure),
        sandboxConversationKillGraceMs + sandboxConversationReapTimeoutMs + 100,
      )
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), expired])
  } finally {
    clearTimeout(deadline)
    clearTimeout(reapDeadline)
  }
}

const requireObjectKeys = (value, keys) => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error("The Sandbox conversation bridge returned an unsupported record.")
  }
}

const immutableConversationIdentity = (identity: SandboxConversationIdentity) => {
  if (
    !["copilot", "codex", "claude"].includes(identity?.agent) ||
    typeof identity.profile !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(identity.profile) ||
    Buffer.byteLength(identity.profile) > 1024 ||
    typeof identity.containerId !== "string" || !opaqueId.test(identity.containerId) ||
    typeof identity.invocationId !== "string" || !/^[a-f0-9]{32}$/u.test(identity.invocationId)
  ) {
    throw new Error("The focused Sandbox conversation identity is missing or invalid.")
  }
  if (
    identity.sessionId !== undefined &&
    (typeof identity.sessionId !== "string" || !sessionIdPattern.test(identity.sessionId))
  ) {
    throw new Error("The focused Sandbox conversation session identity is invalid.")
  }
  return Object.freeze({ ...identity })
}

const parseConversationResponse = (source, identity) => {
  if (typeof source !== "string" || Buffer.byteLength(source) > sandboxConversationMaximumOutputBytes) {
    throw new Error("The Sandbox conversation bridge exceeded its response budget.")
  }
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("The Sandbox conversation bridge returned invalid JSON.")
  }
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("This Sandbox bridge does not support conversation export. Rebuild and reattach the container.")
  }
  const identityKeys = ["agent", "profile", "containerId", "invocationId"]
  if (
    identityKeys.some((key) => value[key] !== identity[key]) ||
    typeof value.sessionId !== "string" ||
    !sessionIdPattern.test(value.sessionId) ||
    (identity.sessionId !== undefined && value.sessionId !== identity.sessionId)
  ) {
    throw new Error("The Sandbox conversation bridge returned a different source identity.")
  }
  return value
}

const validateConversationMetadata = (value) => {
  requireObjectKeys(value.cutoff, ["messageId", "recordIndex"])
  requireObjectKeys(value.coverage, ["complete", "notices"])
  if (
    typeof value.cutoff.messageId !== "string" || !messageIdPattern.test(value.cutoff.messageId) ||
    !Number.isSafeInteger(value.cutoff.recordIndex) ||
    value.cutoff.recordIndex < 0 ||
    typeof value.revision !== "string" || !opaqueId.test(value.revision) ||
    typeof value.activityRevision !== "string" || !opaqueId.test(value.activityRevision)
  ) {
    throw new Error("The Sandbox conversation bridge returned invalid revision or cutoff data.")
  }
  const notices = value.coverage.notices
  if (
    typeof value.coverage.complete !== "boolean" ||
    !Array.isArray(notices) ||
    notices.length > 32 ||
    notices.some((notice) => typeof notice !== "string" || !/^[a-z][a-z0-9-]{0,79}$/u.test(notice)) ||
    new Set(notices).size !== notices.length
  ) {
    throw new Error("The Sandbox conversation bridge returned invalid coverage data.")
  }
}

const conversationPageKeys = [
  "schemaVersion", "agent", "profile", "sessionId", "containerId", "invocationId",
  "snapshotId", "capturedAt", "cutoff", "revision", "activityRevision", "coverage",
  "messages", "page",
]

const validateConversationPage = (value) => {
  requireObjectKeys(value, conversationPageKeys)
  validateConversationMetadata(value)
  requireObjectKeys(value.page, ["index", "total", "nextCursor"])
  if (
    typeof value.snapshotId !== "string" || !opaqueId.test(value.snapshotId) ||
    typeof value.capturedAt !== "string" || value.capturedAt.length > 40 ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    !Array.isArray(value.messages) || value.messages.length === 0 ||
    value.messages.length > sandboxConversationMaximumMessages
  ) {
    throw new Error("The Sandbox conversation bridge returned invalid snapshot data.")
  }
  validateConversationPagePosition(value)
}

const validateConversationPagePosition = (value) => {
  const { index, total, nextCursor } = value.page
  if (
    !Number.isSafeInteger(index) || !Number.isSafeInteger(total) ||
    index < 0 || index >= total || total > sandboxConversationMaximumPages
  ) {
    throw new Error("The Sandbox conversation bridge returned an invalid page sequence.")
  }
  if (index === total - 1) {
    if (nextCursor !== null) throw new Error("The Sandbox conversation final page has an unexpected cursor.")
  } else if (
    typeof nextCursor !== "string" ||
    !opaqueCursor.test(nextCursor) ||
    !nextCursor.startsWith(value.snapshotId)
  ) {
    throw new Error("The Sandbox conversation page is missing its next cursor.")
  }
}

const normalizedConversationMessage = (value) => {
  requireObjectKeys(value, ["id", "role", "text", "recordIndex"])
  if (
    typeof value.id !== "string" || !messageIdPattern.test(value.id) ||
    !["user", "assistant"].includes(value.role) ||
    typeof value.text !== "string" || value.text.trim().length === 0 ||
    !Number.isSafeInteger(value.recordIndex) || value.recordIndex < 0
  ) {
    throw new Error("The Sandbox conversation bridge returned an invalid message.")
  }
  return { id: value.id, role: value.role, text: value.text, recordIndex: value.recordIndex }
}

const defaultConversationBridgeRunner = async ({
  identity, env, cwd, operation, signal, cursor, snapshotId,
}: SandboxConversationRunnerInput) => {
  signal?.throwIfAborted()
  const repositoryRoot = await findTrellageRoot(import.meta.dirname)
  const command = path.join(repositoryRoot, "prototypes", "trellage", "trellage")
  const args = [
    "--profile", identity.profile, "session", operation, "--agent", identity.agent,
    "--container-id", identity.containerId, "--invocation", identity.invocationId,
  ]
  if (cursor !== undefined) args.push("--cursor", cursor)
  if (snapshotId !== undefined) args.push("--snapshot", snapshotId)
  return runSandboxConversationProcess({
    command, args, cwd, env, signal,
    timeoutMs: operation === "release-conversation"
      ? sandboxConversationReleaseTimeoutMs : sandboxConversationProcessTimeoutMs,
  })
}

const pageMetadata = (page) => JSON.stringify({
  snapshotId: page.snapshotId,
  capturedAt: page.capturedAt,
  sessionId: page.sessionId,
  cutoff: { messageId: page.cutoff.messageId, recordIndex: page.cutoff.recordIndex },
  revision: page.revision,
  activityRevision: page.activityRevision,
  coverage: { complete: page.coverage.complete, notices: page.coverage.notices },
  total: page.page.total,
})

class SandboxConversationPages {
  first
  messages = []
  evidenceIds = new Set<string>()
  cursors = new Set<string>()
  nextIndex = 0
  bytes = 2
  lastRecordIndex = -1

  accept(page) {
    validateConversationPage(page)
    if (
      page.page.index !== this.nextIndex ||
      (this.first !== undefined && pageMetadata(page) !== pageMetadata(this.first))
    ) {
      throw new Error("The Sandbox conversation changed identity, revision, or page sequence during export.")
    }
    if (this.first === undefined) this.first = page
    for (const value of page.messages) this.acceptMessage(value)
    this.nextIndex += 1
    const cursor = page.page.nextCursor
    if (cursor !== null && this.cursors.has(cursor)) {
      throw new Error("The Sandbox conversation bridge repeated a page cursor.")
    }
    if (cursor !== null) this.cursors.add(cursor)
    return cursor
  }

  acceptMessage(value) {
    const message = normalizedConversationMessage(value)
    if (this.evidenceIds.has(message.id) || message.recordIndex <= this.lastRecordIndex) {
      throw new Error("The Sandbox conversation bridge returned duplicate or unordered evidence.")
    }
    this.evidenceIds.add(message.id)
    this.lastRecordIndex = message.recordIndex
    this.bytes += Buffer.byteLength(JSON.stringify(message)) + (this.messages.length === 0 ? 0 : 1)
    if (
      this.bytes > sandboxConversationMaximumBytes ||
      this.messages.length >= sandboxConversationMaximumMessages
    ) {
      throw new Error("The Sandbox conversation exceeded its normalized capture budget.")
    }
    this.messages.push(message)
  }

  result() {
    const first = this.first
    const last = this.messages.at(-1)
    const revision = createHash("sha256").update(JSON.stringify(this.messages)).digest("hex")
    if (
      first === undefined || this.nextIndex !== first.page.total ||
      last?.role !== "assistant" || last.id !== first.cutoff.messageId ||
      last.recordIndex !== first.cutoff.recordIndex || revision !== first.revision
    ) {
      throw new Error("The Sandbox conversation digest or completed cutoff did not match.")
    }
    return {
      schemaVersion: 1 as const,
      id: randomUUID(),
      capturedAt: first.capturedAt,
      cutoff: first.cutoff,
      revision: first.revision,
      activityRevision: first.activityRevision,
      messages: this.messages,
      coverage: first.coverage,
      agent: first.agent,
      profile: first.profile,
      sessionId: first.sessionId,
    }
  }
}

export const releaseSandboxConversation = async ({
  identity, snapshotId, cwd, env = process.env, bridgeRunner = defaultConversationBridgeRunner,
  cleanupTimeoutMs = sandboxConversationReleaseTimeoutMs,
}: Omit<SandboxConversationOptions, "signal"> & { readonly snapshotId: string }) => {
  const bound = immutableConversationIdentity(identity)
  checkedTimeBudget(cleanupTimeoutMs, sandboxConversationReleaseTimeoutMs)
  if (!opaqueId.test(snapshotId)) throw new Error("The Sandbox conversation snapshot ID is invalid.")
  const value = parseConversationResponse(await boundedConversationCleanup((signal) => bridgeRunner({
    identity: bound, cwd, env, operation: "release-conversation", snapshotId, signal,
  }), cleanupTimeoutMs), bound)
  requireObjectKeys(value, [
    "schemaVersion", "agent", "profile", "sessionId", "containerId", "invocationId",
    "snapshotId", "released",
  ])
  if (value.snapshotId !== snapshotId || value.released !== true) {
    throw new Error("The Sandbox conversation bridge did not confirm snapshot release.")
  }
}

export const captureSandboxConversation = async ({
  identity, cwd, env = process.env, signal, bridgeRunner = defaultConversationBridgeRunner,
  cleanupTimeoutMs = sandboxConversationReleaseTimeoutMs,
}: SandboxConversationOptions) => {
  const bound = immutableConversationIdentity(identity)
  checkedTimeBudget(cleanupTimeoutMs, sandboxConversationReleaseTimeoutMs)
  const pages = new SandboxConversationPages()
  let snapshotId: string | undefined
  let sessionId = bound.sessionId
  let cursor: string | undefined
  let failed = false
  let captureError: unknown
  try {
    do {
      signal?.throwIfAborted()
      const value = parseConversationResponse(await bridgeRunner({
        identity: bound, cwd, env, signal, operation: "export-conversation", cursor,
      }), bound)
      if (snapshotId === undefined && typeof value.snapshotId === "string" && opaqueId.test(value.snapshotId)) {
        snapshotId = value.snapshotId
        sessionId = value.sessionId
      }
      signal?.throwIfAborted()
      cursor = pages.accept(value) ?? undefined
    } while (cursor !== undefined)
    return pages.result()
  } catch (error) {
    failed = true
    captureError = error
    throw error
  } finally {
    if (snapshotId !== undefined) {
      try {
        await releaseSandboxConversation({
          identity: { ...bound, sessionId }, snapshotId, cwd, env, bridgeRunner, cleanupTimeoutMs,
        })
      } catch (error) {
        if (failed) {
          throw new AggregateError(
            [captureError, error],
            "The Sandbox conversation capture failed and snapshot release also failed.",
            { cause: captureError },
          )
        }
        throw error
      }
    }
  }
}

export const describeSandboxConversation = async ({
  identity, snapshotId, cwd, env = process.env, signal, bridgeRunner = defaultConversationBridgeRunner,
}: SandboxConversationOptions & { readonly snapshotId?: string }) => {
  const bound = immutableConversationIdentity(identity)
  if (snapshotId !== undefined && !opaqueId.test(snapshotId)) {
    throw new Error("The Sandbox conversation snapshot ID is invalid.")
  }
  signal?.throwIfAborted()
  const value = parseConversationResponse(await bridgeRunner({
    identity: bound, cwd, env, signal, operation: "describe-conversation", snapshotId,
  }), bound)
  signal?.throwIfAborted()
  requireObjectKeys(value, [
    "schemaVersion", "agent", "profile", "sessionId", "containerId", "invocationId",
    "cutoff", "revision", "activityRevision", "coverage",
    ...(snapshotId === undefined ? [] : ["snapshotId", "changed"]),
  ])
  validateConversationMetadata(value)
  if (snapshotId !== undefined && (value.snapshotId !== snapshotId || typeof value.changed !== "boolean")) {
    throw new Error("The Sandbox conversation bridge returned a different snapshot description.")
  }
  return value
}
