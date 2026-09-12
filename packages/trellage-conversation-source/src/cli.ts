#!/usr/bin/env bun
import path from "node:path"
import { pathToFileURL } from "node:url"
import { bunExecutable } from "@trellage/runtime"

import type { ConversationSnapshot } from "@trellage/guide-core/conversation"

import { captureFocusedConversation, sameConversationSource } from "./conversation-capture.ts"
import { readConversationRequest, writeConversationRequest } from "./conversation-state.ts"

export interface ConversationSourceDependencies {
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly readRequest?: typeof readConversationRequest
  readonly capture?: typeof captureFocusedConversation
  readonly stageRequest?: typeof writeConversationRequest
  readonly signal?: AbortSignal | undefined
}

const sameHistoryPrefix = (previous: ConversationSnapshot, current: ConversationSnapshot) =>
  previous.messages.every((message, index) => {
    const candidate = current.messages[index]
    return candidate !== undefined && candidate.id === message.id && candidate.role === message.role &&
      candidate.recordIndex === message.recordIndex && candidate.text === message.text
  })

export const checkConversationSource = async (
  previous: ConversationSnapshot,
  { env = process.env, capture = captureFocusedConversation, signal }: Pick<
    ConversationSourceDependencies, "env" | "capture" | "signal"
  > = {},
) => {
  signal?.throwIfAborted()
  try {
    const current = await capture({ ...previous.source, expectedSource: previous.source }, { env, signal })
    signal?.throwIfAborted()
    if (!sameConversationSource(previous.source, current.source) || !sameHistoryPrefix(previous, current)) {
      return {
        sameSource: false, revision: previous.revision, advanced: false,
        message: "The original conversation identity or captured history changed. Open the source picker again.",
      }
    }
    const advanced = current.revision !== previous.revision
    return {
      sameSource: true, revision: current.revision, advanced,
      ...(advanced ? { message: "The focused conversation has newer user-visible activity. Review or analyze the latest snapshot before launch." } : {}),
    }
  } catch (error) {
    if (signal?.aborted || error instanceof AggregateError) throw error
    return {
      sameSource: false, revision: previous.revision, advanced: false,
      message: "The original focused conversation cannot be verified. No other source was selected.",
    }
  }
}

export const main = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
  {
    env = process.env, readRequest = readConversationRequest,
    capture = captureFocusedConversation, stageRequest = writeConversationRequest, signal,
  }: ConversationSourceDependencies = {},
) => {
  signal?.throwIfAborted()
  const [operation, requestPath] = args
  if (args.length !== 2 || (operation !== "--check" && operation !== "--refresh") ||
    requestPath === undefined || !env.HERDR_PLUGIN_STATE_DIR) {
    throw new Error("Use conversation-source.ts --check SNAPSHOT_PATH or --refresh SNAPSHOT_PATH with plugin state.")
  }
  const previous = await readRequest(env.HERDR_PLUGIN_STATE_DIR, requestPath)
  signal?.throwIfAborted()
  if (operation === "--check") return checkConversationSource(previous, { env, capture, signal })
  const current = await capture({ ...previous.source, expectedSource: previous.source }, { env, signal })
  signal?.throwIfAborted()
  if (!sameConversationSource(previous.source, current.source)) {
    throw new Error("The original focused conversation identity changed.")
  }
  const refreshedRequestPath = await stageRequest(env.HERDR_PLUGIN_STATE_DIR, current)
  signal?.throwIfAborted()
  return { requestPath: refreshedRequestPath }
}

const captureTermination = () => {
  const controller = new AbortController()
  let exitCode: number | undefined
  const handlers = new Map<NodeJS.Signals, () => void>()
  const signals: ReadonlyArray<readonly [NodeJS.Signals, number]> = [
    ["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143],
  ]
  for (const [signal, code] of signals) {
    const handler = () => {
      if (controller.signal.aborted) return
      exitCode = code
      controller.abort(new DOMException("Conversation capture was aborted.", "AbortError"))
    }
    handlers.set(signal, handler)
    process.once(signal, handler)
  }
  return {
    signal: controller.signal,
    get exitCode() { return exitCode },
    dispose: () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler)
    },
  }
}

const cleanCancellation = (error: unknown, signal: AbortSignal) => {
  if (!signal.aborted || !(error instanceof Error) || error.name !== "AbortError") return false
  if (!("cleanupFailures" in error)) return true
  return Array.isArray(error.cleanupFailures) && error.cleanupFailures.length === 0
}

export const runConversationSourceCli = async (
  args: ReadonlyArray<string> = process.argv.slice(2),
  dependencies: ConversationSourceDependencies = {},
) => {
  const termination = captureTermination()
  const signal = dependencies.signal === undefined
    ? termination.signal
    : AbortSignal.any([termination.signal, dependencies.signal])
  try {
    const result = await main(args, { ...dependencies, signal })
    signal.throwIfAborted()
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    if (cleanCancellation(error, signal)) return termination.exitCode ?? 130
    if (signal.aborted || error instanceof AggregateError) {
      console.error("Conversation capture or cancellation cleanup failed. The private draft was preserved.")
      return 1
    }
    if (args[0] === "--check") {
      process.stdout.write(`${JSON.stringify({
        sameSource: false, revision: "0".repeat(64), advanced: false,
        message: "The private conversation request or original source could not be verified.",
      })}\n`)
      return 0
    }
    console.error("The focused conversation could not be refreshed. No other source was selected.")
    return 1
  } finally {
    termination.dispose()
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bunExecutable()
  process.exitCode = await runConversationSourceCli()
}
