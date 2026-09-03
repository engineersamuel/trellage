import { constants, rmSync } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import properLockfile from "proper-lockfile"

const maximumStateFileBytes = 512 * 1024
const staleGuideIntentAgeMs = 24 * 60 * 60 * 1000
const staleCaptureQueueLockAgeMs = 5 * 60 * 1000
const captureQueueLockUpdateMs = 30 * 1000
const captureQueueLockRetries = {
  retries: 100,
  factor: 1,
  minTimeout: 25,
  maxTimeout: 50,
  randomize: true,
}
const maximumCaptureQueueCharacters = 60_000
const pluginId = "trellage.guide-handoff"
const identifierControls = /[\u0000-\u001f\u007f-\u009f]/u
const sourceIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const choiceTokenPrefix = "trellage-guide-choice:v1:"
const choiceTokenPattern =
  /^trellage-guide-choice:v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u
const guideIntentFilenamePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/u

const stateRoot = (value) => {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("HERDR_PLUGIN_STATE_DIR must be an absolute path")
  }
  return value
}

const ensurePrivateDirectory = async (directory) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const status = await lstat(directory)
  if (!status.isDirectory() || (process.getuid !== undefined && status.uid !== process.getuid())) {
    throw new Error(`Plugin state directory is unsafe: ${directory}`)
  }
  await chmod(directory, 0o700)
}

const writePrivateFile = async (directory, filename, content) => {
  await ensurePrivateDirectory(directory)
  const target = path.join(directory, filename)
  const temporary = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    await chmod(target, 0o600)
    return target
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

const writePrivateJson = async (directory, filename, value) =>
  writePrivateFile(directory, filename, `${JSON.stringify(value)}\n`)

const readPrivateJson = async (target, missingIsNull) => {
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (missingIsNull && error?.code === "ENOENT") return null
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maximumStateFileBytes) throw new Error("Plugin state file is invalid")
    return JSON.parse(await handle.readFile("utf8"))
  } finally {
    await handle.close()
  }
}

const paneKey = (paneId) => createHash("sha256").update(paneId).digest("hex")

const captureQueuePath = (stateDir) => path.join(stateRoot(stateDir), "capture-queue.json")
const captureQueueLockPath = (stateDir) => path.join(stateRoot(stateDir), "capture-queue.lock")

const emptyCaptureQueue = () => ({ schemaVersion: 1, entries: [] })

const queueOrigin = (value) => {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Capture queue origin is invalid")
  }
  const string = (key, maximum, required = true) => {
    const field = value[key]
    if (!required && field === undefined) return undefined
    if (
      typeof field !== "string" ||
      field.length === 0 ||
      field.length > maximum ||
      identifierControls.test(field)
    ) {
      throw new Error("Capture queue origin is invalid")
    }
    return field
  }
  const surface = string("surface", 64)
  const workspaceId = string("workspaceId", 256)
  const tabId = string("tabId", 256)
  const paneId = string("paneId", 256)
  const cwd = string("cwd", 4096)
  const capturedAt = string("capturedAt", 64)
  const agent = string("agent", 256, false)
  const paneTitle = string("paneTitle", 512, false)
  if (
    !sourceIdentifierPattern.test(workspaceId) ||
    !sourceIdentifierPattern.test(tabId) ||
    !sourceIdentifierPattern.test(paneId) ||
    !path.isAbsolute(cwd) ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    throw new Error("Capture queue origin is invalid")
  }
  return {
    surface,
    workspaceId,
    tabId,
    paneId,
    cwd,
    capturedAt,
    ...(agent === undefined ? {} : { agent }),
    ...(paneTitle === undefined ? {} : { paneTitle }),
  }
}

const validatedCaptureQueue = (value) => {
  if (value === null) return emptyCaptureQueue()
  if (value?.schemaVersion !== 1 || !Array.isArray(value.entries)) {
    throw new Error("Capture queue is invalid")
  }
  return {
    schemaVersion: 1,
    entries: value.entries.map((entry) => {
      if (
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        entry.id.length > 256 ||
        identifierControls.test(entry.id) ||
        typeof entry.answer !== "string"
      ) {
        throw new Error("Capture queue is invalid")
      }
      const origin = queueOrigin(entry.origin)
      return { ...entry, ...(origin === undefined ? {} : { origin }) }
    }),
  }
}

const captureQueueLockOptions = (stateDir, options, onCompromised) => ({
  stale: options?.stale ?? staleCaptureQueueLockAgeMs,
  update: options?.update ?? captureQueueLockUpdateMs,
  retries: options?.retries ?? captureQueueLockRetries,
  realpath: false,
  lockfilePath: captureQueueLockPath(stateDir),
  onCompromised,
})

export const withCaptureQueueLock = async (stateDir, operation, options) => {
  const root = stateRoot(stateDir)
  await ensurePrivateDirectory(root)
  let compromised
  const release = await properLockfile.lock(
    captureQueuePath(root),
    captureQueueLockOptions(root, options, (error) => {
      compromised = error
    }),
  )
  const assertHealthy = () => {
    if (compromised !== undefined) {
      throw new Error("Capture queue lock was compromised", { cause: compromised })
    }
  }
  let result
  let operationError
  try {
    assertHealthy()
    result = await operation(assertHealthy)
    assertHealthy()
  } catch (error) {
    operationError = error
  }
  let releaseError
  try {
    await release()
  } catch (error) {
    releaseError = error
  }
  assertHealthy()
  if (operationError !== undefined) throw operationError
  if (releaseError !== undefined) throw releaseError
  return result
}

const completionPath = (stateDir, paneId) =>
  path.join(stateRoot(stateDir), "completed", `${paneKey(paneId)}.json`)

const oneUsePath = (stateDir, directoryName, value, label, filenamePattern = /^[0-9a-f-]+\.json$/u) => {
  const directory = path.join(stateRoot(stateDir), directoryName)
  const resolved = path.resolve(value)
  if (path.dirname(resolved) !== directory || !filenamePattern.test(path.basename(resolved))) {
    throw new Error(`${label} path is outside plugin state`)
  }
  return resolved
}

const consumePrivateJson = async (stateDir, directoryName, value, label) => {
  const target = oneUsePath(stateDir, directoryName, value, label)
  try {
    return await readPrivateJson(target, false)
  } finally {
    await rm(target, { force: true })
  }
}

const choiceId = (token) => {
  if (typeof token !== "string") throw new Error("Choice token is invalid")
  const match = token.match(choiceTokenPattern)
  if (match === null) throw new Error("Choice token is invalid")
  return match[1]
}

const choicePath = (stateDir, token) =>
  path.join(stateRoot(stateDir), "choices", `${choiceId(token)}.json`)

export const resolvePluginStateDirectory = (env = process.env) => {
  if (env.HERDR_PLUGIN_STATE_DIR !== undefined) return stateRoot(env.HERDR_PLUGIN_STATE_DIR)
  if (env.XDG_STATE_HOME !== undefined) {
    return path.join(stateRoot(env.XDG_STATE_HOME), "herdr", "plugins", pluginId)
  }
  return path.join(stateRoot(env.HOME), ".local", "state", "herdr", "plugins", pluginId)
}

export const writeCompletionMarker = async (stateDir, marker) =>
  writePrivateJson(path.join(stateRoot(stateDir), "completed"), `${paneKey(marker.paneId)}.json`, marker)

export const readCompletionMarker = async (stateDir, paneId) =>
  readPrivateJson(completionPath(stateDir, paneId), true)

export const removeCompletionMarker = async (stateDir, paneId) => {
  await rm(completionPath(stateDir, paneId), { force: true })
}

export const readCaptureQueue = async (stateDir) =>
  validatedCaptureQueue(await readPrivateJson(captureQueuePath(stateDir), true))

export const captureQueueIntent = (queue) => {
  const validated = validatedCaptureQueue(queue)
  if (validated.entries.length === 0) throw new Error("Capture queue is empty")
  return validated.entries
    .map((entry, index) => {
      if (entry.origin === undefined) return `## Captured item ${index + 1}\n\n${entry.answer}`
      const label = entry.origin.paneTitle ?? entry.origin.agent ?? entry.origin.paneId
      const source = [
        entry.origin.workspaceId,
        entry.origin.tabId,
        entry.origin.paneId,
        entry.origin.cwd,
        entry.origin.capturedAt,
      ].join(" · ")
      return `## Captured item ${index + 1} — ${label}\n\n_Source: ${source}_\n\n${entry.answer}`
    })
    .join("\n\n---\n\n")
}

export const appendCaptureQueue = async (stateDir, entry, lockOptions) =>
  withCaptureQueueLock(
    stateDir,
    async (assertLockOwned) => {
      const queue = await readCaptureQueue(stateDir)
      const id = entry.id ?? randomUUID()
      if (queue.entries.some((candidate) => candidate.id === id)) return queue
      const next = {
        schemaVersion: 1,
        entries: [...queue.entries, { ...entry, id }],
      }
      if ([...captureQueueIntent(next)].length > maximumCaptureQueueCharacters) {
        throw new Error(`Capture queue exceeds trx guide's ${maximumCaptureQueueCharacters}-character intent limit`)
      }
      await assertLockOwned()
      await writePrivateJson(stateRoot(stateDir), "capture-queue.json", next)
      return next
    },
    lockOptions,
  )

export const clearCaptureQueue = async (stateDir, lockOptions) =>
  withCaptureQueueLock(
    stateDir,
    async (assertLockOwned) => {
      await assertLockOwned()
      await rm(captureQueuePath(stateDir), { force: true })
    },
    lockOptions,
  )

export const removeCaptureQueueEntry = async (stateDir, id, lockOptions) =>
  withCaptureQueueLock(
    stateDir,
    async (assertLockOwned) => {
      const queue = await readCaptureQueue(stateDir)
      const next = { schemaVersion: 1, entries: queue.entries.filter((entry) => entry.id !== id) }
      if (next.entries.length === queue.entries.length) throw new Error("Queued capture was not found")
      await assertLockOwned()
      if (next.entries.length === 0) await rm(captureQueuePath(stateDir), { force: true })
      else await writePrivateJson(stateRoot(stateDir), "capture-queue.json", next)
      return next
    },
    lockOptions,
  )

export const removeCaptureQueueEntries = async (stateDir, ids, lockOptions) => {
  const removedIds = new Set(ids)
  if (
    removedIds.size === 0 ||
    [...removedIds].some((id) => typeof id !== "string" || id.length === 0)
  ) {
    throw new Error("Queued capture ids are invalid")
  }
  return withCaptureQueueLock(
    stateDir,
    async (assertLockHealthy) => {
      const queue = await readCaptureQueue(stateDir)
      const next = {
        schemaVersion: 1,
        entries: queue.entries.filter((entry) => !removedIds.has(entry.id)),
      }
      if (next.entries.length === queue.entries.length) return queue
      assertLockHealthy()
      if (next.entries.length === 0) await rm(captureQueuePath(stateDir), { force: true })
      else await writePrivateJson(stateRoot(stateDir), "capture-queue.json", next)
      return next
    },
    lockOptions,
  )
}

export const writeInvocation = async (stateDir, invocation) =>
  writePrivateJson(path.join(stateRoot(stateDir), "invocations"), `${randomUUID()}.json`, invocation)

export const consumeInvocation = async (stateDir, invocationPath) =>
  consumePrivateJson(stateDir, "invocations", invocationPath, "Guide invocation")

export const removeInvocation = async (invocationPath) => {
  await rm(invocationPath, { force: true })
}

const guideIntentPath = (stateDir, intentPath) =>
  oneUsePath(
    stateDir,
    "guide-intents",
    intentPath,
    "Guide intent",
    guideIntentFilenamePattern,
  )

export const cleanupStaleGuideIntents = async (stateDir, now = Date.now()) => {
  const directory = path.join(stateRoot(stateDir), "guide-intents")
  await ensurePrivateDirectory(directory)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!guideIntentFilenamePattern.test(entry.name)) continue
    const target = path.join(directory, entry.name)
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
      now - status.mtimeMs < staleGuideIntentAgeMs
    ) {
      continue
    }
    await rm(target, { force: true })
  }
}

export const writeGuideIntent = async (stateDir, intent) => {
  await cleanupStaleGuideIntents(stateDir)
  return writePrivateFile(path.join(stateRoot(stateDir), "guide-intents"), `${randomUUID()}.txt`, intent)
}

export const removeGuideIntent = async (stateDir, intentPath) => {
  await rm(guideIntentPath(stateDir, intentPath), { force: true })
}

export const removeGuideIntentSync = (stateDir, intentPath) => {
  rmSync(guideIntentPath(stateDir, intentPath), { force: true })
}

export const writeChoice = async (stateDir, choice) => {
  const id = randomUUID()
  await writePrivateJson(path.join(stateRoot(stateDir), "choices"), `${id}.json`, choice)
  return `${choiceTokenPrefix}${id}`
}

export const consumeChoice = async (stateDir, token) =>
  consumePrivateJson(stateDir, "choices", choicePath(stateDir, token), "Choice")

export const removeChoice = async (stateDir, token) => {
  await rm(choicePath(stateDir, token), { force: true })
}
