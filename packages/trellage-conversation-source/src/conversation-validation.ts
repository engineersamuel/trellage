import path from "node:path"
import { validateConversationSnapshot } from "@trellage/guide-core/conversation"

import type { FocusedConversationBinding } from "./conversation-capture.ts"
import {
  ConversationAgent, ConversationSurface,
  type ConversationSnapshot, type ConversationSource,
} from "@trellage/guide-core/conversation"

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u
const controls = /[\u0000-\u001f\u007f-\u009f]/u
const invalid = () => new Error("The private conversation record is invalid.")

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}

const keys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>) => {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid()
}

const string = (value: unknown, maximum = 256) => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || controls.test(value)) {
    throw invalid()
  }
  return value
}

const id = (value: unknown, maximum = 256) => {
  const result = string(value, maximum)
  if (!idPattern.test(result)) throw invalid()
  return result
}

const optional = (value: unknown, parse = id) => value === undefined ? undefined : parse(value)

const absolute = (value: unknown) => {
  const result = string(value, 4096)
  if (!path.isAbsolute(result) || path.resolve(result) !== result) throw invalid()
  return result
}

const surfaceIdentity = (binding: FocusedConversationBinding) => {
  if (binding.surface === ConversationSurface.Sandbox) {
    if (binding.profile === undefined || !/^[a-f0-9]{64}$/u.test(binding.containerId ?? "") ||
      !/^[a-f0-9]{32}$/u.test(binding.invocationId ?? "") || binding.transcriptPath !== undefined) {
      throw invalid()
    }
    return
  }
  if (binding.sessionId === undefined || binding.containerId !== undefined || binding.invocationId !== undefined ||
    (binding.surface === ConversationSurface.Native && binding.profile === undefined) ||
    (binding.surface === ConversationSurface.Host && binding.profile !== undefined)) {
    throw invalid()
  }
}

export const parseConversationBinding = (value: unknown): FocusedConversationBinding => {
  const source = record(value)
  keys(source, [
    "serverId", "surface", "agent", "sessionId", "workspaceId", "paneId", "cwd",
    "tabId", "profile", "containerId", "invocationId", "transcriptPath",
  ])
  if (!Object.values(ConversationAgent).includes(source.agent as ConversationSource["agent"]) ||
    !Object.values(ConversationSurface).includes(source.surface as ConversationSource["surface"])) throw invalid()
  const binding: FocusedConversationBinding = {
    serverId: id(source.serverId),
    surface: source.surface as ConversationSource["surface"],
    agent: source.agent as ConversationSource["agent"],
    workspaceId: id(source.workspaceId),
    paneId: id(source.paneId),
    cwd: absolute(source.cwd),
    ...Object.fromEntries([
      ["sessionId", optional(source.sessionId, (value) => id(value, 128))],
      ["tabId", optional(source.tabId)],
      ["profile", optional(source.profile, (value) => id(value, 80))],
      ["containerId", optional(source.containerId)],
      ["invocationId", optional(source.invocationId)],
      ["transcriptPath", optional(source.transcriptPath, absolute)],
    ].filter(([, value]) => value !== undefined)),
  }
  surfaceIdentity(binding)
  return binding
}

export const parseConversationSnapshot = (value: unknown): ConversationSnapshot => {
  try {
    return validateConversationSnapshot(value)
  } catch {
    throw invalid()
  }
}
