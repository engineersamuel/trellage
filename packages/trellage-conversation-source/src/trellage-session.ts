import { ConversationSurface } from "@trellage/guide-core/conversation"
import { isRecord, type JsonRecord } from "./records.ts"

interface SessionIdentityBase {
  readonly agent: string
  readonly profile: string
  readonly processGroup: number
}

export interface TrellageNativeSessionIdentity extends SessionIdentityBase, FirstmateSessionMetadata {
  readonly surface: ConversationSurface.Native
  readonly sessionId: string
}

export interface TrellageSandboxSessionIdentity extends SessionIdentityBase {
  readonly surface: ConversationSurface.Sandbox
  readonly invocationId: string
  readonly containerId: string
}

export type TrellageSessionIdentity = TrellageNativeSessionIdentity | TrellageSandboxSessionIdentity

import {
  FIRSTMATE_MAX_RESPONSE_BYTES,
  parseFirstmateInstanceControlContextV1,
  type FirstmateInstanceControlContextV1,
  type FirstmateInstanceReferenceV1,
} from "@trellage/guide-core"

const tokenText = (tokens: JsonRecord, name: string) => {
  const value = tokens?.[name]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const safeName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value)
const safeSessionId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value)
const safeInvocationId = (value: string) => /^[a-f0-9]{32}$/u.test(value)
const safeContainerId = (value: string) => /^[a-f0-9]{64}$/u.test(value)
const safeProcessGroup = (value: string) => /^[1-9][0-9]{0,15}$/u.test(value)
const safeInstanceId = (value: string): boolean =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)

interface FirstmateSessionMetadata {
  readonly firstmateInstanceId?: string
  readonly launchOrigin?: FirstmateInstanceControlContextV1
}

export class TrellageSessionIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrellageSessionIdentityError"
  }
}

export const hasFirstmateSessionTokens = (tokens: unknown): tokens is Record<string, unknown> =>
  tokens !== null && typeof tokens === "object" && !Array.isArray(tokens) &&
  ["trellage_firstmate_instance_id", "trellage_firstmate_launch_origin"].some((name) => Object.hasOwn(tokens, name))

const firstmateMetadata = (base: SessionIdentityBase & { readonly surface: string }, tokens: JsonRecord): FirstmateSessionMetadata => {
  if (!hasFirstmateSessionTokens(tokens)) return {}
  if (base.surface !== "native" || base.agent !== "claude") {
    throw new TrellageSessionIdentityError("Firstmate metadata requires a Native Claude supervisor.")
  }
  const instanceId = tokenText(tokens, "trellage_firstmate_instance_id")
  if (instanceId === undefined || !safeInstanceId(instanceId)) {
    throw new TrellageSessionIdentityError("Firstmate metadata has no valid instance UUID.")
  }
  if (!Object.hasOwn(tokens, "trellage_firstmate_launch_origin")) return { firstmateInstanceId: instanceId }
  const source = tokenText(tokens, "trellage_firstmate_launch_origin")
  if (source === undefined || Buffer.byteLength(source, "utf8") > FIRSTMATE_MAX_RESPONSE_BYTES) {
    throw new TrellageSessionIdentityError("Firstmate launch origin is missing or exceeds its size limit.")
  }
  let launchOrigin: FirstmateInstanceControlContextV1
  try {
    launchOrigin = parseFirstmateInstanceControlContextV1(JSON.parse(source))
  } catch (error) {
    throw new TrellageSessionIdentityError(
      `Firstmate launch origin is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (launchOrigin.reference.instanceId !== instanceId || launchOrigin.reference.profile !== base.profile) {
    throw new TrellageSessionIdentityError("Firstmate launch origin does not match the focused profile and instance.")
  }
  return { firstmateInstanceId: instanceId, launchOrigin }
}

export const firstmateSessionReference = (
  identity: FirstmateSessionMetadata | TrellageSessionIdentity | undefined,
): FirstmateInstanceReferenceV1 | undefined => {
  if (identity === undefined || !("firstmateInstanceId" in identity) || identity.firstmateInstanceId === undefined) return undefined
  if (identity.launchOrigin === undefined) {
    throw new TrellageSessionIdentityError("Firstmate metadata has no instance root reference. No other profile home was selected.")
  }
  return identity.launchOrigin.reference
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
  return { ...base, surface: ConversationSurface.Native, sessionId, ...firstmateMetadata({ ...base, surface: ConversationSurface.Native }, tokens) }
}

const sandboxIdentity = (base: SessionIdentityBase, tokens: JsonRecord): TrellageSandboxSessionIdentity => {
  firstmateMetadata({ ...base, surface: ConversationSurface.Sandbox }, tokens)
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
