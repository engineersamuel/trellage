const tokenText = (tokens, name) => {
  const value = tokens?.[name]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const safeName = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value)
const safeSessionId = (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u.test(value)
const safeInvocationId = (value) => /^[a-f0-9]{32}$/u.test(value)
const safeContainerId = (value) => /^[a-f0-9]{64}$/u.test(value)
const safeProcessGroup = (value) => /^[1-9][0-9]{0,15}$/u.test(value)

export class TrellageSessionIdentityError extends Error {
  constructor(message) {
    super(message)
    this.name = "TrellageSessionIdentityError"
  }
}

const processGroupIdentity = (agentInfo, tokens) => {
  const processGroupText = tokenText(tokens, "trellage_pgrp")
  const currentProcessGroup = agentInfo.processInfo?.foreground_process_group_id
  if (
    processGroupText === undefined ||
    !safeProcessGroup(processGroupText) ||
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

const baseIdentity = (agentInfo, tokens, surface) => {
  if (surface !== "native" && surface !== "sandbox") {
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

const nativeIdentity = (base, tokens) => {
  const sessionId = tokenText(tokens, "trellage_session_id")
  if (sessionId === undefined || !safeSessionId(sessionId)) {
    throw new TrellageSessionIdentityError("The Trellage Native session ID is missing or invalid.")
  }
  return { ...base, sessionId }
}

const sandboxIdentity = (base, tokens) => {
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
  return { ...base, invocationId, containerId }
}

export const trellageSessionIdentity = (agentInfo) => {
  const tokens = agentInfo?.tokens
  if (tokens === undefined || tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
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
  return surface === "native" ? nativeIdentity(base, tokens) : sandboxIdentity(base, tokens)
}
