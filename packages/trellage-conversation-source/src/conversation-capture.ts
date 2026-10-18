import { createHash, randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import path from "node:path"

import { sourceWorkingDirectory } from "./source-context.ts"
import { getAgent, getProcessInfo } from "./herdr.ts"
import {
  ConversationAgent, ConversationSurface, type ConversationSnapshot, type ConversationSource,
} from "@trellage/guide-core/conversation"
import { conversationCapturePolicy, type ConversationCapturePolicy } from "./conversation-policy.ts"
import { parseConversationRecords } from "./conversation-parser.ts"
import { ConversationSourceError, readStableConversationRecords } from "./conversation-reader.ts"
import {
  exactSessionIdFromProcessInfo, findFocusedTranscript, sessionIdFromAgentSession,
  type FocusedTranscript,
} from "./transcripts.ts"
import { trellageSessionIdentity, type TrellageNativeSessionIdentity } from "./trellage-session.ts"
import { parseConversationSnapshot } from "./conversation-validation.ts"
import type { JsonRecord } from "./records.ts"

export interface FocusedConversationContext {
  readonly workspaceId: string
  readonly paneId: string
  readonly cwd: string
  readonly tabId?: string
  readonly agent?: string
  readonly binding?: FocusedConversationBinding
  readonly expectedSource?: ConversationSource
}

export interface FocusedConversationBinding extends Omit<ConversationSource, "sessionId"> {
  readonly sessionId?: string
  readonly transcriptPath?: string
}

export interface FocusedCaptureDependencies {
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly getAgentForPane?: typeof getAgent
  readonly processReader?: typeof getProcessInfo
  readonly serverIdentifier?: (env: NodeJS.ProcessEnv) => Promise<string>
  readonly transcriptResolver?: typeof findFocusedTranscript
  readonly recordReader?: typeof readStableConversationRecords
  readonly policy?: ConversationCapturePolicy
  readonly signal?: AbortSignal | undefined
  readonly now?: () => Date
  readonly createId?: () => string
}

const supportedAgent = (value: unknown): ConversationSource["agent"] => {
  if (value === ConversationAgent.Copilot || value === ConversationAgent.Codex || value === ConversationAgent.Claude) {
    return value
  }
  throw new ConversationSourceError("The focused pane is not a supported Copilot, Codex, or Claude conversation.")
}

const checkedServerSocket = (status: Stats) => {
  if (!status.isSocket() || status.isSymbolicLink() ||
    (process.getuid !== undefined && status.uid !== process.getuid())) {
    throw new ConversationSourceError("The Herdr server connection is not an owned local socket.")
  }
}

export const conversationServerId = async (env: NodeJS.ProcessEnv): Promise<string> => {
  const socket = env.HERDR_SOCKET_PATH
  if (typeof socket !== "string" || !path.isAbsolute(socket) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(socket)) {
    throw new ConversationSourceError("The focused conversation has no valid Herdr server connection.")
  }
  const status = await lstat(socket)
  checkedServerSocket(status)
  // Bun 1.4.2 on macOS cannot realpath the verified socket leaf.
  const canonicalSocket = path.join(await realpath(path.dirname(socket)), path.basename(socket))
  const current = await lstat(canonicalSocket)
  checkedServerSocket(current)
  if (status.dev !== current.dev || status.ino !== current.ino || status.birthtimeMs !== current.birthtimeMs) {
    throw new ConversationSourceError("The Herdr server connection changed while its identity was being verified.")
  }
  return `herdr-${createHash("sha256").update(JSON.stringify([
    canonicalSocket, status.dev, status.ino, status.birthtimeMs,
  ])).digest("hex")}`
}

const checkedContext = (context: FocusedConversationContext) => {
  const identifiers = [context.workspaceId, context.paneId, context.tabId, context.agent]
  if (identifiers.some((value) => value !== undefined &&
    (typeof value !== "string" || value.length === 0 || value.length > 256 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value))) ||
    typeof context.workspaceId !== "string" || typeof context.paneId !== "string" ||
    typeof context.cwd !== "string" || !path.isAbsolute(context.cwd) ||
    context.cwd.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(context.cwd)) {
    throw new ConversationSourceError("The original focused-pane context is invalid.")
  }
  return context
}

const checkedAgent = (agentInfo: JsonRecord, processInfo: JsonRecord, context: FocusedConversationContext) => {
  if (agentInfo.workspace_id !== context.workspaceId || agentInfo.pane_id !== context.paneId ||
    (context.tabId !== undefined && agentInfo.tab_id !== context.tabId) ||
    (processInfo.pane_id !== undefined && processInfo.pane_id !== context.paneId)) {
    throw new ConversationSourceError("The original focused pane is no longer available in the same workspace and tab.")
  }
  const agent = supportedAgent(agentInfo.agent)
  if (context.agent !== undefined && agent !== context.agent) {
    throw new ConversationSourceError("The harness in the original focused pane changed.")
  }
  const cwd = path.resolve(sourceWorkingDirectory(context, agentInfo))
  if (path.resolve(cwd) !== path.resolve(context.cwd)) {
    throw new ConversationSourceError("The original focused pane working directory changed.")
  }
  return { agent, cwd }
}


const sourceFields = [
  "serverId", "surface", "agent", "sessionId", "workspaceId", "paneId", "cwd", "tabId", "profile",
] as const

export const sameConversationSource = (left: ConversationSource, right: ConversationSource) =>
  sourceFields.every((key) => left[key] === right[key])

const assertBinding = (expected: FocusedConversationBinding | undefined, current: FocusedConversationBinding) => {
  if (expected === undefined) return
  const changed = sourceFields.some((key) => expected[key] !== current[key])
  if (changed || (expected.transcriptPath !== undefined && expected.transcriptPath !== current.transcriptPath)) {
    throw new ConversationSourceError("The original focused conversation identity changed. Open the source picker again.")
  }
}

type SourceBindingBase = Pick<ConversationSource, "serverId" | "agent" | "cwd" | "workspaceId" | "paneId" | "tabId">


interface BoundLocalSource {
  readonly binding: FocusedConversationBinding
  readonly transcript: FocusedTranscript
}


const makeLocalBinding = (
  base: SourceBindingBase, identity: TrellageNativeSessionIdentity | undefined, transcript: FocusedTranscript,
): FocusedConversationBinding => ({
  ...base,
  surface: identity === undefined ? ConversationSurface.Host : ConversationSurface.Native,
  sessionId: transcript.id,
  transcriptPath: transcript.path,
  ...(transcript.profile === undefined ? {} : { profile: transcript.profile }),
})

const bindFocusedSource = async (
  input: FocusedConversationContext,
  dependencies: FocusedCaptureDependencies,
) => {
  const context = checkedContext(input)
  const env = dependencies.env ?? process.env
  dependencies.signal?.throwIfAborted()
  const requestOptions = { socketPath: env.HERDR_SOCKET_PATH, signal: dependencies.signal }
  const [agentInfo, processInfo, serverId] = await Promise.all([
    (dependencies.getAgentForPane ?? getAgent)(context.paneId, requestOptions),
    (dependencies.processReader ?? getProcessInfo)(context.paneId, requestOptions),
    (dependencies.serverIdentifier ?? conversationServerId)(env),
  ])
  const { agent, cwd } = checkedAgent(agentInfo, processInfo, context)
  const identity = trellageSessionIdentity({ agent, tokens: agentInfo.tokens, processInfo })
  const base = {
    serverId, agent, cwd, workspaceId: context.workspaceId, paneId: context.paneId,
    ...(context.tabId === undefined ? {} : { tabId: context.tabId }),
  }
  const transcript = await (dependencies.transcriptResolver ?? findFocusedTranscript)({
    agent, cwd, agentSession: agentInfo.agent_session, processInfo,
    tokens: agentInfo.tokens, env,
  })
  const bound: BoundLocalSource = {
    binding: makeLocalBinding(base, identity, transcript),
    transcript,
  }
  assertBinding(context.binding, bound.binding)
  assertBinding(context.expectedSource, bound.binding)
  dependencies.signal?.throwIfAborted()
  return bound
}

export const bindFocusedConversation = async (
  context: FocusedConversationContext,
  dependencies: FocusedCaptureDependencies = {},
): Promise<FocusedConversationBinding> => (await bindFocusedSource(context, dependencies)).binding

const snapshotSource = (binding: FocusedConversationBinding, sessionId: string): ConversationSource => {
  const { transcriptPath: _path, ...source } = binding
  return { ...source, sessionId }
}


const captureBoundLocal = async (bound: BoundLocalSource, dependencies: FocusedCaptureDependencies) => {
  const policy = dependencies.policy ?? conversationCapturePolicy
  const read = await (dependencies.recordReader ?? readStableConversationRecords)(
    bound.transcript.path, bound.transcript.roots, { policy, signal: dependencies.signal },
  )
  const source = snapshotSource(bound.binding, bound.transcript.id)
  const normalized = parseConversationRecords(source.agent, read.records, {
    sessionId: source.sessionId, cwd: source.cwd, policy,
  })
  normalized.coverage.notices.push(...read.notices)
  return { source, normalized }
}

export const captureFocusedConversation = async (
  context: FocusedConversationContext,
  dependencies: FocusedCaptureDependencies = {},
): Promise<ConversationSnapshot> => {
  const bound = await bindFocusedSource(context, dependencies)
  const { source, normalized } = await captureBoundLocal(bound, dependencies)
  if (context.expectedSource !== undefined && !sameConversationSource(context.expectedSource, source)) {
    throw new ConversationSourceError("The original focused conversation identity changed. Open the source picker again.")
  }
  await bindFocusedConversation({ ...context, binding: bound.binding }, dependencies)
  return parseConversationSnapshot({
    schemaVersion: 1,
    id: (dependencies.createId ?? randomUUID)(),
    source,
    capturedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    cutoff: normalized.cutoff,
    revision: normalized.revision,
    messages: normalized.messages,
    coverage: normalized.coverage,
  })
}
