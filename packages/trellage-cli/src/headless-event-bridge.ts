#!/usr/bin/env node

import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import { pathToFileURL } from "node:url"

import {
  captureGitEvidenceSnapshot,
  compareGitEvidenceSnapshots,
  type GitChangedFilesEvidence,
  type GitEvidenceSnapshot,
} from "./git-evidence.js"

export const claudeStreamJsonV1 = "claude-stream-json-v1" as const

type JsonPrimitive = boolean | number | string | null
type JsonValue = JsonPrimitive | JsonObject | ReadonlyArray<JsonValue>
interface JsonObject {
  readonly [key: string]: JsonValue
}

type ClaudeResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_during_execution"
  | "error_max_budget_usd"
  | "error_max_structured_output_retries"

type NativeResultState = "success" | "error" | "malformed"

interface NativeResultEvidence {
  readonly state: NativeResultState
  readonly subtype: string | null
  readonly isError: boolean | null
  readonly sessionId: string | null
  readonly finalText: string | null
  readonly usage: JsonObject | null
  readonly costUsd: number | null
  readonly error: string | null
}

export interface TrellageSessionEventV1 {
  readonly type: "trellage.session"
  readonly schemaVersion: 1
  readonly profile: string
  readonly harness: string
  readonly runtime: string
  readonly eventContract: typeof claudeStreamJsonV1
  readonly sessionId: string
  readonly expectedSessionId: string | null
  readonly expectedSessionIdMatches: boolean | null
}

export interface TrellageResultEventV1 {
  readonly type: "trellage.result"
  readonly schemaVersion: 1
  readonly profile: string
  readonly harness: string
  readonly runtime: string
  readonly eventContract: typeof claudeStreamJsonV1
  readonly outcome: "success" | "failure" | "unknown"
  readonly sessionId: string | null
  readonly expectedSessionId: string | null
  readonly expectedSessionIdMatches: boolean | null
  readonly sessionIdConsistent: boolean | null
  readonly finalText: string | null
  readonly model: string | null
  readonly usage: JsonObject | null
  readonly costUsd: number | null
  readonly changedFiles: ReadonlyArray<string> | null
  readonly changedFilesSource: "git-diff" | null
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly nativeResultSubtype: string | null
  readonly nativeIsError: boolean | null
  readonly nativeError: string | null
  readonly nativeMalformedLineCount: number
  readonly spawnError: string | null
}

export interface HeadlessEventBridgeOptions {
  readonly eventContract: typeof claudeStreamJsonV1
  readonly gitRoot: string
  readonly profile: string
  readonly harness: string
  readonly runtime: string
  readonly expectedSessionId?: string
  readonly command: readonly [string, ...Array<string>]
}

export interface HeadlessEventBridgeDependencies {
  readonly output?: Writable
  readonly captureGitSnapshot?: (gitRoot: string) => Promise<GitEvidenceSnapshot | null>
  readonly compareGitSnapshots?: (
    before: GitEvidenceSnapshot | null,
    after: GitEvidenceSnapshot | null,
  ) => GitChangedFilesEvidence | Promise<GitChangedFilesEvidence>
  readonly forwardSignals?: boolean
}

export interface ChildTermination {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnError: string | null
}

export interface HeadlessEventBridgeRun {
  readonly termination: ChildTermination
  readonly result: TrellageResultEventV1
}

export class HeadlessEventBridgeUsageError extends Error {}

const resultSubtypes = new Set<ClaudeResultSubtype>([
  "success",
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
])
const errorResultSubtypes = new Set<ClaudeResultSubtype>([
  "error_max_turns",
  "error_during_execution",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
])
const strictUtf8 = new TextDecoder("utf-8", { fatal: true })
const forwardedSignals: ReadonlyArray<NodeJS.Signals> = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const nonEmptyString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null)

const jsonObject = (value: unknown): JsonObject | null => (isObject(value) ? (value as JsonObject) : null)

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const resultSubtype = (value: unknown): ClaudeResultSubtype | null =>
  typeof value === "string" && resultSubtypes.has(value as ClaudeResultSubtype) ? (value as ClaudeResultSubtype) : null

const nativeResultError = (event: Record<string, unknown>): string | null => {
  const direct = nonEmptyString(event.error)
  if (direct !== null) return direct
  const message = nonEmptyString(jsonObject(event.error)?.message)
  if (message !== null) return message
  if (!Array.isArray(event.errors)) return null
  const errors = event.errors.flatMap((value) => {
    const error = nonEmptyString(value)
    return error === null ? [] : [error]
  })
  return errors.length === 0 ? null : errors.join("\n")
}

const parseNativeResult = (event: Record<string, unknown>): NativeResultEvidence => {
  const subtypeValue = typeof event.subtype === "string" ? event.subtype : null
  const subtype = resultSubtype(event.subtype)
  const sessionId = nonEmptyString(event.session_id)
  const isError = typeof event.is_error === "boolean" ? event.is_error : null
  const finalText = subtype === "success" && typeof event.result === "string" ? event.result : null
  const usage = jsonObject(event.usage)
  const costUsd = finiteNumber(event.total_cost_usd)
  const error = nativeResultError(event)

  if (isError === true) {
    return { state: "error", subtype: subtypeValue, isError, sessionId, finalText, usage, costUsd, error }
  }
  if (subtype === null) {
    return { state: "malformed", subtype: subtypeValue, isError, sessionId, finalText, usage, costUsd, error }
  }
  if (errorResultSubtypes.has(subtype)) {
    return { state: "error", subtype, isError, sessionId, finalText, usage, costUsd, error }
  }
  return {
    state: sessionId !== null && isError === false && finalText !== null ? "success" : "malformed",
    subtype,
    isError,
    sessionId,
    finalText,
    usage,
    costUsd,
    error,
  }
}

class ClaudeStreamObserver {
  private readonly profile: string
  private readonly harness: string
  private readonly runtime: string
  private readonly expectedSessionId: string | undefined
  private readonly sessionIds = new Set<string>()
  private authoritativeSessionId: string | null = null
  private initializedModel: string | null = null
  private terminalResult: NativeResultEvidence | null = null
  private malformedLineCount = 0

  constructor(options: HeadlessEventBridgeOptions) {
    this.profile = options.profile
    this.harness = options.harness
    this.runtime = options.runtime
    this.expectedSessionId = options.expectedSessionId
  }

  observe(line: Buffer): TrellageSessionEventV1 | null {
    let value: unknown
    try {
      value = JSON.parse(strictUtf8.decode(line))
    } catch {
      this.malformedLineCount += 1
      return null
    }
    if (!isObject(value)) {
      this.malformedLineCount += 1
      return null
    }

    const isInit = value.type === "system" && value.subtype === "init"
    const isAssistant = value.type === "assistant"
    const isResult = value.type === "result"
    let authoritativeId: string | null = null

    if (isInit) {
      authoritativeId = nonEmptyString(value.session_id)
      if (this.initializedModel === null) this.initializedModel = nonEmptyString(value.model)
    }
    if (isAssistant && this.initializedModel === null) {
      this.initializedModel = nonEmptyString(jsonObject(value.message)?.model)
    }
    if (isResult) {
      this.terminalResult = parseNativeResult(value)
      if (resultSubtype(value.subtype) !== null) authoritativeId = nonEmptyString(value.session_id)
    }
    if (authoritativeId === null) return null

    this.sessionIds.add(authoritativeId)
    if (this.authoritativeSessionId !== null) return null
    this.authoritativeSessionId = authoritativeId
    return {
      type: "trellage.session",
      schemaVersion: 1,
      profile: this.profile,
      harness: this.harness,
      runtime: this.runtime,
      eventContract: claudeStreamJsonV1,
      sessionId: authoritativeId,
      expectedSessionId: this.expectedSessionId ?? null,
      expectedSessionIdMatches:
        this.expectedSessionId === undefined ? null : authoritativeId === this.expectedSessionId,
    }
  }

  result(termination: ChildTermination, gitEvidence: GitChangedFilesEvidence): TrellageResultEventV1 {
    const expectedSessionIdMatches =
      this.expectedSessionId === undefined || this.authoritativeSessionId === null
        ? null
        : this.authoritativeSessionId === this.expectedSessionId
    const sessionIdConsistent = this.sessionIds.size === 0 ? null : this.sessionIds.size === 1
    const processFailed =
      termination.spawnError !== null ||
      termination.signal !== null ||
      termination.exitCode === null ||
      termination.exitCode !== 0
    const contractFailed =
      expectedSessionIdMatches === false ||
      sessionIdConsistent === false ||
      (this.terminalResult?.state === "success" && this.malformedLineCount > 0)
    const nativeFailed = this.terminalResult?.state === "error"
    const outcome =
      processFailed || contractFailed || nativeFailed
        ? "failure"
        : this.terminalResult?.state === "success"
          ? "success"
          : "unknown"

    return {
      type: "trellage.result",
      schemaVersion: 1,
      profile: this.profile,
      harness: this.harness,
      runtime: this.runtime,
      eventContract: claudeStreamJsonV1,
      outcome,
      sessionId: this.authoritativeSessionId,
      expectedSessionId: this.expectedSessionId ?? null,
      expectedSessionIdMatches,
      sessionIdConsistent,
      finalText: this.terminalResult?.finalText ?? null,
      model: this.initializedModel,
      usage: this.terminalResult?.usage ?? null,
      costUsd: this.terminalResult?.costUsd ?? null,
      changedFiles: gitEvidence.changedFiles,
      changedFilesSource: gitEvidence.changedFilesSource,
      exitCode: termination.exitCode,
      signal: termination.signal,
      nativeResultSubtype: this.terminalResult?.subtype ?? null,
      nativeIsError: this.terminalResult?.isError ?? null,
      nativeError: this.terminalResult?.error ?? null,
      nativeMalformedLineCount: this.malformedLineCount,
      spawnError: termination.spawnError,
    }
  }
}

class OrderedEventOutput {
  private readonly output: Writable
  private hasOutput = false
  private lineTerminated = true

  constructor(output: Writable) {
    this.output = output
  }

  private write(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      this.output.write(bytes, (error) => {
        if (error === null || error === undefined) resolve()
        else reject(error)
      })
    })
  }

  async native(bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return
    await this.write(bytes)
    this.hasOutput = true
    this.lineTerminated = bytes[bytes.length - 1] === 0x0a
  }

  async event(event: TrellageSessionEventV1 | TrellageResultEventV1): Promise<void> {
    if (this.hasOutput && !this.lineTerminated) await this.write(Buffer.from("\n"))
    await this.write(Buffer.from(`${JSON.stringify(event)}\n`, "utf8"))
    this.hasOutput = true
    this.lineTerminated = true
  }
}

const nativeLineContent = (line: Buffer): Buffer => {
  let end = line.length
  if (end > 0 && line[end - 1] === 0x0a) end -= 1
  if (end > 0 && line[end - 1] === 0x0d) end -= 1
  return line.subarray(0, end)
}

const pumpNativeStdout = async (
  stdout: Readable,
  observer: ClaudeStreamObserver,
  output: OrderedEventOutput,
): Promise<void> => {
  let pending = Buffer.alloc(0)
  for await (const chunk of stdout) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    pending = pending.length === 0 ? Buffer.from(bytes) : Buffer.concat([pending, bytes])
    let lineEnd = pending.indexOf(0x0a)
    while (lineEnd >= 0) {
      const line = pending.subarray(0, lineEnd + 1)
      await output.native(line)
      const sessionEvent = observer.observe(nativeLineContent(line))
      if (sessionEvent !== null) await output.event(sessionEvent)
      pending = pending.subarray(lineEnd + 1)
      lineEnd = pending.indexOf(0x0a)
    }
  }
  if (pending.length > 0) {
    await output.native(pending)
    const sessionEvent = observer.observe(nativeLineContent(pending))
    if (sessionEvent !== null) await output.event(sessionEvent)
  }
}

const safeCapture = async (
  capture: (gitRoot: string) => Promise<GitEvidenceSnapshot | null>,
  gitRoot: string,
): Promise<GitEvidenceSnapshot | null> => {
  try {
    return await capture(gitRoot)
  } catch {
    return null
  }
}

const safeCompare = async (
  compare: (
    before: GitEvidenceSnapshot | null,
    after: GitEvidenceSnapshot | null,
  ) => GitChangedFilesEvidence | Promise<GitChangedFilesEvidence>,
  before: GitEvidenceSnapshot | null,
  after: GitEvidenceSnapshot | null,
): Promise<GitChangedFilesEvidence> => {
  try {
    return await compare(before, after)
  } catch {
    return { changedFiles: null, changedFilesSource: null }
  }
}

const installSignalForwarding = (child: ReturnType<typeof spawn>): (() => void) => {
  const installed: Array<readonly [NodeJS.Signals, () => void]> = []
  for (const signal of forwardedSignals) {
    const handler = (): void => {
      try {
        child.kill(signal)
      } catch {
        // The child can exit between signal delivery and forwarding.
      }
    }
    try {
      process.on(signal, handler)
      installed.push([signal, handler])
    } catch {
      // Some signals are not available on every Node platform.
    }
  }
  return () => {
    for (const [signal, handler] of installed) process.off(signal, handler)
  }
}

export const runHeadlessEventBridge = async (
  options: HeadlessEventBridgeOptions,
  dependencies: HeadlessEventBridgeDependencies = {},
): Promise<HeadlessEventBridgeRun> => {
  if (options.eventContract !== claudeStreamJsonV1) {
    throw new HeadlessEventBridgeUsageError(`unsupported event contract: ${String(options.eventContract)}`)
  }
  validateIdentifier("--profile", options.profile)
  validateIdentifier("--harness", options.harness)
  validateIdentifier("--runtime", options.runtime)
  const capture = dependencies.captureGitSnapshot ?? captureGitEvidenceSnapshot
  const compare = dependencies.compareGitSnapshots ?? compareGitEvidenceSnapshots
  const output = new OrderedEventOutput(dependencies.output ?? process.stdout)
  const observer = new ClaudeStreamObserver(options)
  const before = await safeCapture(capture, options.gitRoot)
  const [command, ...arguments_] = options.command
  const child = spawn(command, arguments_, {
    shell: false,
    stdio: ["inherit", "pipe", "inherit"],
  })
  const removeSignalForwarding =
    dependencies.forwardSignals === false ? () => undefined : installSignalForwarding(child)

  let spawnError: string | null = null
  const terminationPromise = new Promise<ChildTermination>((resolve) => {
    child.once("error", (error) => {
      spawnError = error.message
    })
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode: spawnError === null ? exitCode : null, signal, spawnError })
    })
  })

  try {
    const [termination] = await Promise.all([terminationPromise, pumpNativeStdout(child.stdout, observer, output)])
    const after = await safeCapture(capture, options.gitRoot)
    const result = observer.result(termination, await safeCompare(compare, before, after))
    await output.event(result)
    return { termination, result }
  } finally {
    removeSignalForwarding()
  }
}

const optionValue = (arguments_: ReadonlyArray<string>, index: number, option: string): string => {
  const value = arguments_[index + 1]
  if (value === undefined || value.length === 0) throw new HeadlessEventBridgeUsageError(`${option} requires a value`)
  return value
}

function validateIdentifier(option: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /\s/u.test(value)) {
    throw new HeadlessEventBridgeUsageError(`${option} requires a non-empty identifier`)
  }
}

export const parseHeadlessEventBridgeArgs = (arguments_: ReadonlyArray<string>): HeadlessEventBridgeOptions => {
  let eventContract: string | undefined
  let gitRoot: string | undefined
  let profile: string | undefined
  let harness: string | undefined
  let runtime: string | undefined
  let expectedSessionId: string | undefined
  let command: ReadonlyArray<string> | undefined

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!
    if (argument === "--") {
      command = arguments_.slice(index + 1)
      break
    }
    if (argument === "--event-contract") {
      if (eventContract !== undefined) throw new HeadlessEventBridgeUsageError("--event-contract was specified twice")
      eventContract = optionValue(arguments_, index, argument)
      index += 1
      continue
    }
    if (argument === "--git-root") {
      if (gitRoot !== undefined) throw new HeadlessEventBridgeUsageError("--git-root was specified twice")
      gitRoot = optionValue(arguments_, index, argument)
      index += 1
      continue
    }
    if (argument === "--profile") {
      if (profile !== undefined) throw new HeadlessEventBridgeUsageError("--profile was specified twice")
      profile = optionValue(arguments_, index, argument)
      index += 1
      continue
    }
    if (argument === "--harness") {
      if (harness !== undefined) throw new HeadlessEventBridgeUsageError("--harness was specified twice")
      harness = optionValue(arguments_, index, argument)
      index += 1
      continue
    }
    if (argument === "--runtime") {
      if (runtime !== undefined) throw new HeadlessEventBridgeUsageError("--runtime was specified twice")
      runtime = optionValue(arguments_, index, argument)
      index += 1
      continue
    }
    if (argument === "--expected-session-id") {
      if (expectedSessionId !== undefined) {
        throw new HeadlessEventBridgeUsageError("--expected-session-id was specified twice")
      }
      expectedSessionId = optionValue(arguments_, index, argument)
      index += 1
      continue
    }
    throw new HeadlessEventBridgeUsageError(`unknown option: ${argument}`)
  }

  if (eventContract === undefined) throw new HeadlessEventBridgeUsageError("--event-contract is required")
  if (eventContract !== claudeStreamJsonV1) {
    throw new HeadlessEventBridgeUsageError(`unsupported event contract: ${eventContract}`)
  }
  if (gitRoot === undefined) throw new HeadlessEventBridgeUsageError("--git-root is required")
  if (profile === undefined) throw new HeadlessEventBridgeUsageError("--profile is required")
  if (harness === undefined) throw new HeadlessEventBridgeUsageError("--harness is required")
  if (runtime === undefined) throw new HeadlessEventBridgeUsageError("--runtime is required")
  validateIdentifier("--profile", profile)
  validateIdentifier("--harness", harness)
  validateIdentifier("--runtime", runtime)
  if (command === undefined || command.length === 0 || command[0]!.length === 0) {
    throw new HeadlessEventBridgeUsageError("a child command is required after --")
  }

  return {
    eventContract,
    gitRoot,
    profile,
    harness,
    runtime,
    ...(expectedSessionId === undefined ? {} : { expectedSessionId }),
    command: command as [string, ...Array<string>],
  }
}

export const executeHeadlessEventBridge = (
  arguments_: ReadonlyArray<string>,
  dependencies: HeadlessEventBridgeDependencies = {},
): Promise<HeadlessEventBridgeRun> => runHeadlessEventBridge(parseHeadlessEventBridgeArgs(arguments_), dependencies)

const signalExitCode = (signal: NodeJS.Signals): number => 128 + (os.constants.signals[signal] ?? 0)

const mirrorTermination = (termination: ChildTermination): void => {
  if (termination.exitCode !== null) {
    process.exitCode = termination.exitCode
    return
  }
  if (termination.signal !== null) {
    try {
      process.kill(process.pid, termination.signal)
      return
    } catch {
      process.exitCode = signalExitCode(termination.signal)
      return
    }
  }
  process.exitCode = 1
}

export const headlessEventBridgeMain = async (
  arguments_: ReadonlyArray<string> = process.argv.slice(2),
): Promise<void> => {
  try {
    const run = await executeHeadlessEventBridge(arguments_)
    mirrorTermination(run.termination)
  } catch (error) {
    const usageError = error instanceof HeadlessEventBridgeUsageError
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`headless-event-bridge: ${message}\n`)
    process.exitCode = usageError ? 2 : 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(path.resolve(invokedPath)).href === import.meta.url) {
  void headlessEventBridgeMain()
}
