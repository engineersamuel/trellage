import { ConversationSurface } from "@trellage/guide-core/conversation"
import { isRecord, type JsonRecord } from "./records.ts"

interface SessionIdentityBase {
  readonly agent: string
  readonly profile: string
  readonly processGroup: number
}

export interface TrellageNativeSessionIdentity extends SessionIdentityBase {
  readonly surface: ConversationSurface.Native
  readonly sessionId: string
}

export interface TrellageSandboxSessionIdentity extends SessionIdentityBase {
  readonly surface: ConversationSurface.Sandbox
  readonly invocationId: string
  readonly containerId: string
}

export type TrellageSessionIdentity = TrellageNativeSessionIdentity | TrellageSandboxSessionIdentity

const tokenText = (tokens: JsonRecord, name: string) => {
  const value = tokens?.[name]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const safeName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value)
const safeSessionId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value)
const safeInvocationId = (value: string) => /^[a-f0-9]{32}$/u.test(value)
const safeContainerId = (value: string) => /^[a-f0-9]{64}$/u.test(value)
const safeProcessGroup = (value: string) => /^[1-9][0-9]{0,15}$/u.test(value)

export class TrellageSessionIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrellageSessionIdentityError"
  }
}

const processGroupIdentity = (agentInfo: JsonRecord, tokens: JsonRecord) => {
  const processGroupText = tokenText(tokens, "trellage_pgrp")
  const processInfo = isRecord(agentInfo.processInfo) ? agentInfo.processInfo : undefined
  const currentProcessGroup = processInfo?.foreground_process_group_id
  if (
    processGroupText === undefined ||
    !safeProcessGroup(processGroupText) ||
    typeof currentProcessGroup !== "number" ||
    !Number.isSafeInteger(currentProcessGroup) ||
    currentProcessGroup <= 0 ||
    Number(processGroupText) !== currentProcessGroup
  ) {
    throw new TrellageSessionIdentityError(
      "Trellage session metadata does not match the focused process.",
    )
  }
  return currentProcessGroup
}

const baseIdentity = (agentInfo: JsonRecord, tokens: JsonRecord, surface: string) => {
  if (surface !== ConversationSurface.Native && surface !== ConversationSurface.Sandbox) {
    throw new TrellageSessionIdentityError("Trellage session metadata has an unsupported surface.")
  }
  const agent = tokenText(tokens, "trellage_agent")
  const profile = tokenText(tokens, "trellage_profile")
  if (agent === undefined || profile === undefined || !safeName(agent) || !safeName(profile)) {
    throw new TrellageSessionIdentityError("Trellage session metadata has an invalid agent or profile.")
  }
  if (agent !== agentInfo.agent) {
    throw new TrellageSessionIdentityError("Trellage session metadata does not match the focused agent.")
  }
  return {
    surface,
    agent,
    profile,
    processGroup: processGroupIdentity(agentInfo, tokens),
  }
}

const nativeIdentity = (base: SessionIdentityBase, tokens: JsonRecord): TrellageNativeSessionIdentity => {
  const sessionId = tokenText(tokens, "trellage_session_id")
  if (sessionId === undefined || !safeSessionId(sessionId)) {
    throw new TrellageSessionIdentityError("The Trellage Native session ID is missing or invalid.")
  }
  return { ...base, surface: ConversationSurface.Native, sessionId }
}

const sandboxIdentity = (base: SessionIdentityBase, tokens: JsonRecord): TrellageSandboxSessionIdentity => {
  const invocationId = tokenText(tokens, "trellage_invocation_id")
  const containerId = tokenText(tokens, "trellage_container_id")
  if (
    invocationId === undefined ||
    containerId === undefined ||
    !safeInvocationId(invocationId) ||
    !safeContainerId(containerId)
  ) {
    throw new TrellageSessionIdentityError("The Trellage Sandbox attachment identity is missing or invalid.")
  }
  return { ...base, surface: ConversationSurface.Sandbox, invocationId, containerId }
}

export const trellageSessionIdentity = (agentInfo: unknown): TrellageSessionIdentity | undefined => {
  if (!isRecord(agentInfo)) return undefined
  const tokens = agentInfo.tokens
  if (!isRecord(tokens)) {
    return undefined
  }

  const surface = tokenText(tokens, "trellage_surface")
  const hasTrellageTokens = Object.keys(tokens).some((name) => name.startsWith("trellage_"))
  if (surface === undefined) {
    if (hasTrellageTokens) {
      throw new TrellageSessionIdentityError("Trellage session metadata is incomplete.")
    }
    return undefined
  }
  const base = baseIdentity(agentInfo, tokens, surface)
  return surface === ConversationSurface.Native ? nativeIdentity(base, tokens) : sandboxIdentity(base, tokens)
}
