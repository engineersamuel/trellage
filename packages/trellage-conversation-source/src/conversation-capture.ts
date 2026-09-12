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
import {
  trellageSessionIdentity, type TrellageNativeSessionIdentity, type TrellageSandboxSessionIdentity,
} from "./trellage-session.ts"
import { parseConversationSnapshot } from "./conversation-validation.ts"
import type { captureSandboxConversation } from "./sandbox-bridge.ts"
import { isRecord, type JsonRecord } from "./records.ts"

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
  readonly sandboxLookup?: typeof captureSandboxConversation
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
  // Bun 1.3.3 on macOS cannot realpath the verified socket leaf.
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

const exactSandboxSessionId = (agent: ConversationAgent, agentInfo: JsonRecord, processInfo: JsonRecord) => {
  const reference = agentInfo.agent_session
  if (reference !== undefined &&
    (!isRecord(reference) || reference.agent !== agent || reference.kind !== "id")) {
    throw new ConversationSourceError("The Sandbox attachment has an unsupported harness session reference.")
  }
  const reported = sessionIdFromAgentSession(agent, reference)
  if (reference !== undefined && reported === undefined) {
    throw new ConversationSourceError("The Sandbox harness session reference is invalid.")
  }
  const processId = exactSessionIdFromProcessInfo(agent, processInfo)
  if (reported !== undefined && processId !== undefined && reported !== processId) {
    throw new ConversationSourceError("Conflicting exact Sandbox session identities were reported.")
  }
  return reported ?? processId
}

const sourceFields = [
  "serverId", "surface", "agent", "sessionId", "workspaceId", "paneId",
  "cwd", "tabId", "profile", "containerId", "invocationId",
] as const

export const sameConversationSource = (left: ConversationSource, right: ConversationSource) =>
  sourceFields.every((key) => left[key] === right[key])

const assertBinding = (expected: FocusedConversationBinding | undefined, current: FocusedConversationBinding) => {
  if (expected === undefined) return
  const changed = sourceFields.some((key) => {
    if (key === "sessionId" && (expected.sessionId === undefined || current.sessionId === undefined) &&
      expected.surface === ConversationSurface.Sandbox) return false
    return expected[key] !== current[key]
  })
  if (changed || (expected.transcriptPath !== undefined && expected.transcriptPath !== current.transcriptPath)) {
    throw new ConversationSourceError("The original focused conversation identity changed. Open the source picker again.")
  }
}

type SourceBindingBase = Pick<ConversationSource, "serverId" | "agent" | "cwd" | "workspaceId" | "paneId" | "tabId">

interface BoundSandboxSource {
  readonly surface: ConversationSurface.Sandbox
  readonly binding: FocusedConversationBinding
  readonly identity: TrellageSandboxSessionIdentity
}

interface BoundLocalSource {
  readonly surface: ConversationSurface.Host | ConversationSurface.Native
  readonly binding: FocusedConversationBinding
  readonly transcript: FocusedTranscript
}

type BoundFocusedSource = BoundSandboxSource | BoundLocalSource

const makeSandboxBinding = (
  base: SourceBindingBase, identity: TrellageSandboxSessionIdentity, agentInfo: JsonRecord, processInfo: JsonRecord,
): FocusedConversationBinding => {
  const sessionId = exactSandboxSessionId(base.agent, agentInfo, processInfo)
  return {
    ...base, surface: ConversationSurface.Sandbox, profile: identity.profile,
    containerId: identity.containerId, invocationId: identity.invocationId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
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
  let bound: BoundFocusedSource
  if (identity?.surface === ConversationSurface.Sandbox) {
    bound = {
      surface: ConversationSurface.Sandbox,
      binding: makeSandboxBinding(base, identity, agentInfo, processInfo),
      identity,
    }
  } else {
    const transcript = await (dependencies.transcriptResolver ?? findFocusedTranscript)({
      agent, cwd, agentSession: agentInfo.agent_session, processInfo,
      tokens: agentInfo.tokens, env,
    })
    bound = {
      surface: identity === undefined ? ConversationSurface.Host : ConversationSurface.Native,
      binding: makeLocalBinding(base, identity, transcript),
      transcript,
    }
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

const defaultSandboxLookup = async (options: Parameters<typeof captureSandboxConversation>[0]) => {
  const bridge = await import("./sandbox-bridge.ts")
  if (typeof bridge.captureSandboxConversation !== "function") {
    throw new ConversationSourceError("This Sandbox session bridge does not support conversation export.")
  }
  return bridge.captureSandboxConversation(options)
}

const captureBoundSandbox = async (
  bound: BoundSandboxSource, dependencies: FocusedCaptureDependencies, env: NodeJS.ProcessEnv,
) => {
  const normalized = await (dependencies.sandboxLookup ?? defaultSandboxLookup)({
    identity: {
      ...bound.identity,
      ...(bound.binding.sessionId === undefined ? {} : { sessionId: bound.binding.sessionId }),
    },
    cwd: bound.binding.cwd, env, signal: dependencies.signal,
  })
  if (typeof normalized.sessionId !== "string" || normalized.sessionId.length === 0 ||
    (bound.binding.sessionId !== undefined && normalized.sessionId !== bound.binding.sessionId)) {
    throw new ConversationSourceError("The Sandbox export does not match the exact focused session.")
  }
  if (!/^[a-f0-9]{64}$/u.test(normalized.revision) || !/^[a-f0-9]{64}$/u.test(normalized.activityRevision)) {
    throw new ConversationSourceError("The Sandbox export has no valid conversation and activity revision.")
  }
  return {
    source: snapshotSource(bound.binding, normalized.sessionId),
    normalized: {
      ...normalized,
      revision: createHash("sha256").update(JSON.stringify([normalized.revision, normalized.activityRevision])).digest("hex"),
    },
  }
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
  const { source, normalized } = bound.surface === ConversationSurface.Sandbox
    ? await captureBoundSandbox(bound, dependencies, dependencies.env ?? process.env)
    : await captureBoundLocal(bound, dependencies)
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
