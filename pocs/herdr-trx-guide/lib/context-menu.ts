import path from "node:path"

import { captureAgentContent, ExactCaptureUnavailableError } from "./capture.ts"
import { completionMarkerFor } from "./capture-options.ts"
import {
  getAgent,
  getProcessInfo,
  readVisibleAgent,
} from "./herdr.ts"
import { captureStrictStructuredFinalMessage, exactSessionIdFromProcessInfo, sessionIdFromAgentSession } from "./transcripts.ts"
import {
  defaultRewriteStyles,
  parseRewriteConfiguration,
  resolveRewriteStyles,
  type RewriteConfiguration,
  type RewriteStyle,
} from "./rewrite-styles.ts"
import { parseInvocationContext, type InvocationContext } from "./context.ts"
import {
  selectLatestVisibleMessage,
  type VisibleMessageRole,
  type VisiblePaneMessage,
  type VisiblePaneSnapshot,
} from "./visible-message.ts"

const maximumRequestBytes = 512 * 1024
const maximumMessageCharacters = 60_000
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const sessionIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const multilineControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

export interface ContextMenuSource {
  readonly workspaceId: string
  readonly tabId: string
  readonly paneId: string
  readonly cwd: string
  readonly agent?: string
}

export interface TranscriptPaneMessage {
  readonly paneId: string
  readonly role: VisibleMessageRole
  readonly text: string
  readonly capturedAt: string
  readonly source: "transcript"
  readonly sessionId: string
}

export type ContextMenuMessage = VisiblePaneMessage | TranscriptPaneMessage

export interface ContextMenuRequest {
  readonly schemaVersion: 1
  readonly kind: "rewrite-output" | "context-menu-error"
  readonly source: ContextMenuSource
  readonly message?: ContextMenuMessage
  readonly styles: ReadonlyArray<RewriteStyle>
  readonly model?: string
  readonly effort?: RewriteConfiguration["effort"]
  readonly timeoutMs?: number
  readonly error?: { readonly code: string; readonly message: string }
}

export interface ContextMenuCaptureDependencies {
  readonly env?: NodeJS.ProcessEnv
  readonly visibleReader?: typeof readVisibleAgent
  readonly agentReader?: typeof getAgent
  readonly processReader?: typeof getProcessInfo
  readonly exactCapture?: typeof captureAgentContent
  readonly now?: () => Date
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const boundedText = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || controls.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

const nonemptyText = (value: unknown, label: string, maximum: number): string => {
  const text = boundedText(value, label, maximum)
  if (text.trim().length === 0) throw new Error(`${label} is invalid`)
  return text
}

const sourceFromContext = (context: InvocationContext): ContextMenuSource => {
  if (context.tabId === undefined) throw new Error("The active Herdr tab is unavailable")
  return {
    workspaceId: context.workspaceId,
    tabId: context.tabId,
    paneId: context.paneId,
    cwd: context.cwd,
    ...(context.agent === undefined ? {} : { agent: context.agent }),
  }
}

const styleForRequest = (value: unknown): RewriteStyle => {
  if (!isRecord(value)) throw new Error("A rewrite style is invalid")
  const id = nonemptyText(value.id, "rewrite style id", 64)
  if (!identifier.test(id)) throw new Error("A rewrite style identifier is invalid")
  const title = nonemptyText(value.title, "rewrite style title", 128)
  const description = nonemptyText(value.description, "rewrite style description", 512)
  const instruction = nonemptyText(value.instruction, "rewrite style instruction", 4_096)
  const skillPath = value.skillPath === undefined
    ? undefined
    : nonemptyText(value.skillPath, "rewrite skill path", 4_096)
  if (skillPath !== undefined && !path.isAbsolute(skillPath)) throw new Error("Rewrite skill paths must be absolute")
  return {
    id,
    title,
    description,
    instruction,
    ...(skillPath === undefined ? {} : { skillPath }),
  }
}

const stylesForRequest = (value: unknown): ReadonlyArray<RewriteStyle> => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("Rewrite styles must contain between one and 32 styles")
  }
  const styles = value.map(styleForRequest)
  if (new Set(styles.map(({ id }) => id)).size !== styles.length) {
    throw new Error("Rewrite style identifiers must be unique")
  }
  return styles
}

const sourceForRequest = (value: unknown): ContextMenuSource => {
  if (!isRecord(value)) throw new Error("The context-menu source is invalid")
  const workspaceId = nonemptyText(value.workspaceId, "context-menu workspace id", 256)
  const tabId = nonemptyText(value.tabId, "context-menu tab id", 256)
  const paneId = nonemptyText(value.paneId, "context-menu pane id", 256)
  const cwd = nonemptyText(value.cwd, "context-menu working directory", 4096)
  if (!path.isAbsolute(cwd)) throw new Error("Context-menu working directory must be absolute")
  const agent = value.agent === undefined ? undefined : nonemptyText(value.agent, "context-menu agent", 256)
  return { workspaceId, tabId, paneId, cwd, ...(agent === undefined ? {} : { agent }) }
}

const messageForRequest = (value: unknown, source: ContextMenuSource): ContextMenuMessage => {
  if (!isRecord(value)) throw new Error("The harness message is missing")
  const paneId = nonemptyText(value.paneId, "message pane id", 256)
  if (paneId !== source.paneId) throw new Error("The message belongs to a different pane")
  const role = nonemptyText(value.role, "message role", 32).toLowerCase()
  if (role !== "harness" && role !== "system") throw new Error("The message is not a harness or system message")
  const text = value.text
  if (typeof text !== "string" || text.trim().length === 0 || text.length > maximumMessageCharacters || multilineControls.test(text)) {
    throw new Error("message text is invalid")
  }
  const capturedAt = nonemptyText(value.capturedAt, "message capture time", 128)
  const messageSource = nonemptyText(value.source, "message source", 32)
  if (messageSource === "visible") return { paneId, role, text, capturedAt, source: "visible" }
  if (messageSource !== "transcript") throw new Error("The selected message has an invalid source")
  const sessionId = nonemptyText(value.sessionId, "message session id", 128)
  if (!sessionIdentifier.test(sessionId)) throw new Error("The message session id is invalid")
  return { paneId, role, text, capturedAt, source: "transcript", sessionId }
}

export const parseContextMenuRequest = (value: unknown): ContextMenuRequest => {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("The context-menu request is invalid")
  const source = sourceForRequest(value.source)
  const kind = value.kind
  if (kind !== "rewrite-output" && kind !== "context-menu-error") throw new Error("The context-menu request kind is invalid")
  const styles = stylesForRequest(value.styles)
  const model = value.model === undefined ? undefined : nonemptyText(value.model, "rewrite model", 128)
  const effort = value.effort === undefined ? undefined : nonemptyText(value.effort, "rewrite effort", 8) as RewriteConfiguration["effort"]
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("Rewrite effort is invalid")
  const timeoutValue = value.timeoutMs
  if (timeoutValue !== undefined && (typeof timeoutValue !== "number" || !Number.isSafeInteger(timeoutValue) || timeoutValue <= 0 || timeoutValue > 300_000)) {
    throw new Error("Rewrite timeout is invalid")
  }
  const timeoutMs = timeoutValue as number | undefined
  const error = value.error === undefined
    ? undefined
    : (() => {
        if (!isRecord(value.error)) throw new Error("The context-menu error is invalid")
        return {
          code: nonemptyText(value.error.code, "context-menu error code", 64),
          message: nonemptyText(value.error.message, "context-menu error message", 512),
        }
      })()
  const message = value.message === undefined ? undefined : messageForRequest(value.message, source)
  if (kind === "rewrite-output" && message === undefined) throw new Error("The visible harness message is missing")
  if (kind === "context-menu-error" && error === undefined) throw new Error("The context-menu error is missing")
  return {
    schemaVersion: 1,
    kind,
    source,
    styles,
    ...(message === undefined ? {} : { message }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(error === undefined ? {} : { error }),
  }
}

export const parseContextMenuRequestJson = (source: string): ContextMenuRequest => {
  if (Buffer.byteLength(source, "utf8") > maximumRequestBytes) throw new Error("The context-menu request is too large")
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("The context-menu request is not valid JSON")
  }
  return parseContextMenuRequest(value)
}

const publicRequestStyles = (styles: ReadonlyArray<RewriteStyle>): ReadonlyArray<RewriteStyle> =>
  styles.map((style) => ({ ...style }))

const requestOptions = (configuration: RewriteConfiguration) => ({
  ...(configuration.model === undefined ? {} : { model: configuration.model }),
  ...(configuration.effort === undefined ? {} : { effort: configuration.effort }),
  ...(configuration.timeoutMs === undefined ? {} : { timeoutMs: configuration.timeoutMs }),
})

export const contextMenuRequest = (
  source: ContextMenuSource,
  styles: ReadonlyArray<RewriteStyle>,
  options: RewriteConfiguration,
  message?: ContextMenuMessage,
  error?: unknown,
): ContextMenuRequest => ({
  schemaVersion: 1,
  kind: error === undefined ? "rewrite-output" : "context-menu-error",
  source,
  styles: publicRequestStyles(styles),
  ...(message === undefined ? {} : { message }),
  ...requestOptions(options),
  ...(error === undefined
    ? {}
    : {
        error: {
          code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unavailable",
          message: error instanceof Error ? error.message : String(error),
        },
      }),
})

const styleOptions = (env: NodeJS.ProcessEnv): { readonly styles: ReadonlyArray<RewriteStyle>; readonly options: RewriteConfiguration; readonly error?: unknown } => {
  try {
    const raw = env.TRELLAGE_GUIDE_REWRITE_CONFIG_JSON
    const configuration = raw === undefined ? {} : parseRewriteConfiguration(JSON.parse(raw))
    return { styles: resolveRewriteStyles(configuration), options: configuration }
  } catch (error) {
    return { styles: defaultRewriteStyles, options: {}, error }
  }
}

const sessionReference = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined
  const agent = typeof value.agent === "string" ? value.agent : undefined
  const kind = typeof value.kind === "string" ? value.kind : undefined
  const reference = typeof value.value === "string" ? value.value : undefined
  return agent === undefined || kind === undefined || reference === undefined
    ? undefined
    : `${agent}:${kind}:${reference}`
}

const trellageIdentityReference = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined
  const fields = [
    "trellage_surface",
    "trellage_session_id",
    "trellage_process_group",
    "trellage_invocation_id",
    "trellage_container_id",
  ]
  const present = fields.map((field) => [field, value[field]] as const).filter(([, item]) => item !== undefined)
  return present.length === 0 ? undefined : JSON.stringify(present)
}

const assertStableAgent = (before: Record<string, unknown>, after: Record<string, unknown>, context: InvocationContext): void => {
  if (before.pane_id !== undefined && after.pane_id !== before.pane_id) throw new Error("The active Herdr pane changed")
  if (before.terminal_id !== undefined && after.terminal_id !== before.terminal_id) throw new Error("The active Herdr agent changed")
  if (after.agent !== before.agent || after.workspace_id !== before.workspace_id || after.tab_id !== before.tab_id) {
    throw new Error("The active Herdr agent changed")
  }
  if (context.tabId !== undefined && after.tab_id !== context.tabId) throw new Error("The active Herdr tab changed")
  if (before.state_change_seq !== undefined && after.state_change_seq !== before.state_change_seq) {
    throw new Error("The active Herdr agent changed while its message was captured")
  }
  if (sessionReference(before.agent_session) !== sessionReference(after.agent_session)) {
    throw new Error("The active Herdr agent session changed")
  }
  if (trellageIdentityReference(before.tokens) !== trellageIdentityReference(after.tokens)) {
    throw new Error("The active Herdr agent session changed")
  }
}

const assertStableProcess = (before: unknown, after: unknown, agent: string, beforeAvailable: boolean): void => {
  if (!isRecord(before)) return
  if (!beforeAvailable) return
  const beforeSession = exactSessionIdFromProcessInfo(agent, before)
  if (!isRecord(after)) {
    if (beforeSession !== undefined) throw new Error("The active Herdr agent session changed")
    return
  }
  if (before.pane_id !== undefined && after.pane_id !== before.pane_id) throw new Error("The active Herdr pane changed")
  const afterSession = exactSessionIdFromProcessInfo(agent, after)
  if (beforeSession !== afterSession) {
    throw new Error("The active Herdr agent session changed")
  }
}

export const captureContextMenuRequest = async ({
  context,
  env = process.env,
  visibleReader = readVisibleAgent,
  agentReader = getAgent,
  processReader = getProcessInfo,
  exactCapture = captureAgentContent,
  now = () => new Date(),
}: ContextMenuCaptureDependencies & { readonly context: InvocationContext }): Promise<ContextMenuRequest> => {
  const source = sourceFromContext(context)
  const configured = styleOptions(env)
  if (configured.error !== undefined) return contextMenuRequest(source, configured.styles, configured.options, undefined, configured.error)
  try {
    const before = await agentReader(context.paneId)
    if (before.pane_id !== undefined && before.pane_id !== context.paneId) throw new Error("The active Herdr pane changed")
    if (before.workspace_id !== undefined && before.workspace_id !== context.workspaceId) throw new Error("The active Herdr workspace changed")
    if (context.tabId !== undefined && before.tab_id !== undefined && before.tab_id !== context.tabId) throw new Error("The active Herdr tab changed")
    if (typeof before.agent !== "string" || before.agent.length === 0) throw new Error("The active pane is not a harness agent")
    if (context.agent !== undefined && before.agent !== context.agent) throw new Error("The active Herdr agent changed")
    let processInfo
    let processInfoAvailable = true
    try {
      processInfo = await processReader(context.paneId)
    } catch {
      processInfoAvailable = false
    }
    try {
      const captured = await exactCapture({
        context,
        agentInfo: before,
        marker: completionMarkerFor(before),
        processInfo,
        onDiagnostic: () => {},
        env,
        structuredLookup: captureStrictStructuredFinalMessage,
        mode: "exact",
      })
      const agent = typeof before.agent === "string" ? before.agent.toLowerCase() : ""
      const expectedSessionId = sessionIdFromAgentSession(agent, before.agent_session) ??
        (processInfo === undefined ? undefined : exactSessionIdFromProcessInfo(agent, processInfo)) ??
        (isRecord(before.tokens) && typeof before.tokens.trellage_session_id === "string"
          ? before.tokens.trellage_session_id
          : undefined)
      const capturedSessionId = "sessionId" in captured ? captured.sessionId : undefined
      if (capturedSessionId === undefined || !sessionIdentifier.test(capturedSessionId)) {
        throw new ExactCaptureUnavailableError("The exact harness message has no session identity")
      }
      if (expectedSessionId !== undefined && capturedSessionId !== expectedSessionId) {
        throw new Error("The active Herdr agent session changed")
      }
      const after = await agentReader(context.paneId)
      assertStableAgent(before, after, context)
      let processAfter
      try {
        processAfter = await processReader(context.paneId)
      } catch {
        processAfter = undefined
      }
      assertStableProcess(processInfo, processAfter, agent, processInfoAvailable)
      const afterSessionId = sessionIdFromAgentSession(agent, after.agent_session) ??
        (processAfter === undefined ? undefined : exactSessionIdFromProcessInfo(agent, processAfter)) ??
        (isRecord(after.tokens) && typeof after.tokens.trellage_session_id === "string"
          ? after.tokens.trellage_session_id
          : undefined)
      if (afterSessionId !== undefined && afterSessionId !== capturedSessionId) throw new Error("The active Herdr agent session changed")
      const message: TranscriptPaneMessage = {
        paneId: context.paneId,
        role: "harness",
        text: captured.answer,
        capturedAt: now().toISOString(),
        source: "transcript",
        sessionId: capturedSessionId,
      }
      return contextMenuRequest(source, configured.styles, configured.options, message)
    } catch (error) {
      if (!(error instanceof ExactCaptureUnavailableError)) throw error
    }
    const read = await visibleReader(context.paneId)
    if (read.paneId !== context.paneId) throw new Error("Herdr returned a different pane")
    if (read.workspaceId !== context.workspaceId) throw new Error("Herdr returned a different workspace")
    if (read.tabId !== context.tabId) throw new Error("Herdr returned a different tab")
    if (read.source !== "visible") throw new Error("Herdr returned a non-visible source")
    if (read.format !== "text") throw new Error("Herdr returned a non-text source")
    const after = await agentReader(context.paneId)
    assertStableAgent(before, after, context)
    const snapshot: VisiblePaneSnapshot = {
      paneId: context.paneId,
      ...(typeof before.agent === "string" ? { agent: before.agent } : {}),
      text: read.text,
      ...(read.capturedAt === undefined ? {} : { capturedAt: read.capturedAt }),
      ...(read.truncated === undefined ? {} : { truncated: read.truncated }),
    }
    return contextMenuRequest(source, configured.styles, configured.options, selectLatestVisibleMessage(snapshot))
  } catch (error) {
    return contextMenuRequest(source, configured.styles, configured.options, undefined, error)
  }
}

export const contextMenuRequestFromChoice = (value: unknown): ContextMenuRequest => {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "context-menu" || value.request === undefined) {
    throw new Error("The context-menu choice is invalid")
  }
  return parseContextMenuRequest(value.request)
}

export const contextMenuSourceMatches = (request: ContextMenuRequest, context: InvocationContext): boolean => {
  if (context.tabId === undefined) return false
  return request.source.workspaceId === context.workspaceId &&
    request.source.tabId === context.tabId &&
    request.source.paneId === context.paneId &&
    request.source.cwd === context.cwd &&
    (request.source.agent === undefined || request.source.agent === context.agent)
}

export { parseInvocationContext }
