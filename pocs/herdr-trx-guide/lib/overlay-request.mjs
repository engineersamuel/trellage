import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rm, unlink } from "node:fs/promises"
import path from "node:path"

import {
  parseInvocationContext,
  validateAnswer,
} from "./context.mjs"

export const overlayInvocationSource = "trellage-guide-overlay"
const maximumRequestBytes = 512 * 1024
const staleRequestAgeMs = 24 * 60 * 60 * 1000
const futureClockSkewMs = 5 * 60 * 1000
const identifierControls = /[\u0000-\u001f\u007f-\u009f]/u
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const tokenPattern =
  /^trellage-guide-overlay-request:v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const exactKeys = (value, allowed, label) => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field`)
  }
}

const requiredString = (value, key, label, maximum) => {
  const field = value[key]
  if (
    typeof field !== "string" ||
    field.length === 0 ||
    field.length > maximum ||
    identifierControls.test(field)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return field
}

const optionalString = (value, key, label, maximum) => {
  if (value[key] === undefined) return undefined
  return requiredString(value, key, label, maximum)
}

const requiredIdentifier = (value, key, label) => {
  const field = requiredString(value, key, label, 256)
  if (!identifierPattern.test(field)) throw new Error(`${label} is invalid`)
  return field
}

const ensurePrivateDirectory = async (directory) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const status = await lstat(directory)
  if (
    !status.isDirectory() ||
    (process.getuid !== undefined && status.uid !== process.getuid())
  ) {
    throw new Error(`Overlay request directory is unsafe: ${directory}`)
  }
  await chmod(directory, 0o700)
}

export const overlayRequestId = (token) => {
  if (typeof token !== "string") throw new Error("Overlay request token is invalid")
  const match = token.match(tokenPattern)
  if (match === null) throw new Error("Overlay request token is invalid")
  return match[1]
}

export const overlayRequestDirectories = (env = process.env) => {
  if (typeof env.HOME !== "string" || !path.isAbsolute(env.HOME)) {
    throw new Error("HOME must be an absolute path")
  }
  const parent = path.join(
    env.HOME,
    "Library",
    "Application Support",
    "Trellage",
    "TRX Guide Overlay",
  )
  return { parent, requests: path.join(parent, "requests") }
}

export const ensureOverlayRequestDirectories = async (env = process.env) => {
  const directories = overlayRequestDirectories(env)
  await ensurePrivateDirectory(directories.parent)
  await ensurePrivateDirectory(directories.requests)
  return directories
}

export const cleanupStaleOverlayRequests = async (env = process.env, now = Date.now()) => {
  const { requests } = await ensureOverlayRequestDirectories(env)
  for (const entry of await readdir(requests, { withFileTypes: true })) {
    if (!uuidPattern.test(entry.name.replace(/\.json$/u, "")) || !entry.name.endsWith(".json")) {
      continue
    }
    const target = path.join(requests, entry.name)
    let status
    try {
      status = await lstat(target)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw error
    }
    if (
      !status.isFile() ||
      (process.getuid !== undefined && status.uid !== process.getuid()) ||
      (status.mode & 0o777) !== 0o600 ||
      status.nlink !== 1 ||
      now - status.mtimeMs < staleRequestAgeMs
    ) {
      continue
    }
    await rm(target, { force: true })
  }
}

export const parseOverlayInvocationContext = (source) => {
  const context = parseInvocationContext(source)
  const raw = JSON.parse(source)
  if (context.invocationSource !== overlayInvocationSource) {
    throw new Error("Overlay invocation source is invalid")
  }
  if (context.tabId === undefined) throw new Error("Overlay tab id is missing")
  if (context.selectedText === undefined) throw new Error("Overlay request token is missing")
  const requestId = overlayRequestId(context.selectedText)
  const correlationId = optionalString(raw, "correlation_id", "Overlay correlation id", 256)
  if (correlationId !== undefined && correlationId !== requestId) {
    throw new Error("Overlay correlation id does not match the request id")
  }
  return { ...context, requestId }
}

const parseCapturedAt = (value, now) => {
  const capturedAt = requiredString(value, "capturedAt", "Overlay capture time", 64)
  const capturedAtMs = Date.parse(capturedAt)
  if (
    !Number.isFinite(capturedAtMs) ||
    now - capturedAtMs > staleRequestAgeMs ||
    capturedAtMs - now > futureClockSkewMs
  ) {
    throw new Error("Overlay capture time is invalid or stale")
  }
  return capturedAt
}

const parseRequestSource = (value, context) => {
  if (!isRecord(value)) throw new Error("Overlay request source is invalid")
  exactKeys(
    value,
    new Set(["workspaceId", "tabId", "paneId", "cwd", "agent", "paneTitle"]),
    "Overlay request source",
  )
  const workspaceId = requiredIdentifier(value, "workspaceId", "Overlay workspace id")
  const tabId = requiredIdentifier(value, "tabId", "Overlay tab id")
  const paneId = requiredIdentifier(value, "paneId", "Overlay pane id")
  const cwd = requiredString(value, "cwd", "Overlay working directory", 4096)
  const agent = optionalString(value, "agent", "Overlay agent", 256)
  const paneTitle = optionalString(value, "paneTitle", "Overlay pane title", 512)
  if (!path.isAbsolute(cwd)) throw new Error("Overlay working directory must be absolute")
  if (
    workspaceId !== context.workspaceId ||
    tabId !== context.tabId ||
    paneId !== context.paneId ||
    cwd !== context.cwd ||
    (agent !== undefined && agent !== context.agent)
  ) {
    throw new Error("Overlay request source does not match the action context")
  }
  return {
    workspaceId,
    tabId,
    paneId,
    cwd,
    ...(agent === undefined ? {} : { agent }),
    ...(paneTitle === undefined ? {} : { paneTitle }),
  }
}

export const parseOverlayRequest = (value, requestId, context, now = Date.now()) => {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Overlay request is invalid")
  exactKeys(
    value,
    new Set(["schemaVersion", "requestId", "selection", "capturedAt", "source"]),
    "Overlay request",
  )
  const parsedRequestId = requiredString(value, "requestId", "Overlay request id", 36)
  if (!uuidPattern.test(parsedRequestId) || parsedRequestId !== requestId) {
    throw new Error("Overlay request id does not match the token")
  }
  return {
    schemaVersion: 1,
    requestId,
    selection: validateAnswer(value.selection, "Overlay selection"),
    capturedAt: parseCapturedAt(value, now),
    source: parseRequestSource(value.source, context),
  }
}

export const consumeOverlayRequest = async (
  env,
  requestId,
  context,
  now = Date.now(),
) => {
  await cleanupStaleOverlayRequests(env, now)
  const { requests } = overlayRequestDirectories(env)
  const target = path.join(requests, `${requestId}.json`)
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("Overlay request must not be a symlink")
    throw error
  }
  try {
    const status = await handle.stat()
    if (
      !status.isFile() ||
      (process.getuid !== undefined && status.uid !== process.getuid()) ||
      (status.mode & 0o777) !== 0o600 ||
      status.nlink !== 1 ||
      status.size === 0 ||
      status.size > maximumRequestBytes ||
      now - status.mtimeMs > staleRequestAgeMs
    ) {
      throw new Error("Overlay request file is unsafe")
    }
    await unlink(target)
    let value
    try {
      value = JSON.parse(await handle.readFile("utf8"))
    } catch {
      throw new Error("Overlay request is not valid JSON")
    }
    return parseOverlayRequest(value, requestId, context, now)
  } finally {
    await handle.close()
  }
}
