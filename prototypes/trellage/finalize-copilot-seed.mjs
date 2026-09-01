#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

const outputNames = [
  "managed-settings.json",
  "managed-files.txt",
  "managed.sha256",
  "managed-lock.json",
]
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const dangerousIdentifiers = new Set(["__proto__", "prototype", "constructor"])
const lockName = ".finalize.lock"
const recoveryName = ".finalize.recovery"
const copilotPluginLockName = "installed-plugins.lock"
const stagePrefix = ".finalize-stage-"
const privateLockPrefix = ".copilot-finalize-lock-"
const privateRecoveryPrefix = ".copilot-finalize-recovery-"
const privateStagePrefix = ".copilot-finalize-stage-"
const stagePhases = new Set([
  "staged",
  "published-settings",
  "published-files",
  "published-hashes",
  "published-marker",
  "removed-settings",
  "removed-config",
])
const controlCharacterPattern = /[\u0000-\u001f\u007f]/
const maxJsonCharacters = 1_000_000
const maxJsonDepth = 128
const authoritativeManifests = new Set([
  path.join(".github", "plugin", "plugin.json"),
  "plugin.json",
])
const unsupportedAlternateManifests = [
  path.join(".copilot", "plugin.json"),
  path.join(".claude-plugin", "plugin.json"),
]
const knownBuildOnlyPaths = [
  "/src/build-support",
  "/src/finalize-copilot-seed.mjs",
  "/src/mise.lock",
  "/src/mise.toml",
  "/src/oci",
  "/src/profile.lock.toml",
  "/src/runtime-copilot-entry.sh",
  "/src/workspace.keep",
]

const fail = (message) => {
  throw new Error(message)
}

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

const safeIdentifier = (value, label) => {
  if (!identifierPattern.test(value) || dangerousIdentifiers.has(value) || Object.hasOwn(Object.prototype, value)) {
    fail(`unsafe ${label} identifier`)
  }
}

const sha256 = (content) => createHash("sha256").update(content).digest("hex")
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0
const modeString = (mode) => (mode & 0o777).toString(8).padStart(4, "0")

const isMissing = (error) => error && typeof error === "object" && "code" in error && error.code === "ENOENT"
const isAlreadyExists = (error) => error && typeof error === "object" && "code" in error && error.code === "EEXIST"

const pathIsMissing = async (file) => {
  try {
    await lstat(file)
    return false
  } catch (error) {
    if (isMissing(error)) return true
    throw error
  }
}

const optionalStatus = async (file) => {
  try {
    return await lstat(file)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

const optionalRegularFile = async (file, label) => {
  try {
    const status = await lstat(file)
    if (!status.isFile() || status.isSymbolicLink()) fail(`${label} must be a regular file`)
    return { file, mode: status.mode & 0o777 }
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

const canonicalJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(lexical).map((key) => [key, canonicalJson(value[key])]))
  }
  return value
}

const assertExactJson = (actual, expected, label) => {
  if (JSON.stringify(canonicalJson(actual)) !== JSON.stringify(canonicalJson(expected))) {
    fail(`${label} does not match the locked managed state`)
  }
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === "object" && "code" in error && error.code === "EPERM"
  }
}

const sameKeys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort(lexical)) === JSON.stringify([...expected].sort(lexical))

const sameIdentity = (left, right) => left?.path === right.path && left?.dev === right.dev && left?.ino === right.ino

const identityOf = async (directory) => {
  const status = await lstat(directory)
  return { path: await realpath(directory), dev: String(status.dev), ino: String(status.ino) }
}

const readStrictJson = async (handle, message) => {
  try {
    return JSON.parse(await handle.readFile("utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) fail(message)
    throw error
  }
}

const skipJsonWhitespace = (parser) => {
  while (
    parser.index < parser.source.length
    && /[\u0020\u0009\u000a\u000d]/.test(parser.source[parser.index])
  ) {
    parser.index += 1
  }
}

const jsonEscapeEnd = (source, cursor, message) => {
  const escape = source[cursor]
  if (escape === undefined) fail(message)
  if (escape === "u") {
    if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor + 1, cursor + 5))) fail(message)
    return cursor + 5
  }
  if (!'"\\/bfnrt'.includes(escape)) fail(message)
  return cursor + 1
}

const readJsonStringToken = (parser, message) => {
  if (parser.source[parser.index] !== '"') fail(message)
  let cursor = parser.index + 1
  while (cursor < parser.source.length) {
    const character = parser.source[cursor]
    if (character === '"') {
      const end = cursor + 1
      return { value: JSON.parse(parser.source.slice(parser.index, end)), end }
    }
    if (character.charCodeAt(0) < 0x20) fail(message)
    cursor = character === "\\"
      ? jsonEscapeEnd(parser.source, cursor + 1, message)
      : cursor + 1
  }
  fail(message)
}

const pushJsonFrame = (parser, kind, state, message) => {
  if (parser.frames.length >= maxJsonDepth) fail(message)
  parser.frames.push(kind === "object"
    ? { kind, keys: new Set(), state }
    : { kind, state })
  parser.index += 1
}

const readJsonValue = (parser, message) => {
  const character = parser.source[parser.index]
  if (character === "{") return pushJsonFrame(parser, "object", "keyOrEnd", message)
  if (character === "[") return pushJsonFrame(parser, "array", "valueOrEnd", message)
  if (character === '"') {
    parser.index = readJsonStringToken(parser, message).end
    return
  }
  for (const literal of ["true", "false", "null"]) {
    if (parser.source.startsWith(literal, parser.index)) {
      parser.index += literal.length
      return
    }
  }
  const number = parser.source.slice(parser.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0]
  if (number === undefined) fail(message)
  parser.index += number.length
}

const closeJsonFrame = (parser) => {
  parser.index += 1
  parser.frames.pop()
}

const readJsonObjectKey = (parser, frame, allowEnd, message) => {
  if (parser.source[parser.index] === "}") {
    if (!allowEnd) fail(message)
    closeJsonFrame(parser)
    return
  }
  const key = readJsonStringToken(parser, message)
  if (frame.keys.has(key.value)) fail(`${message}: duplicate JSON key`)
  frame.keys.add(key.value)
  frame.state = "colon"
  parser.index = key.end
}

const readJsonObjectEnd = (parser, frame, message) => {
  if (parser.source[parser.index] === ",") {
    parser.index += 1
    frame.state = "key"
    return
  }
  if (parser.source[parser.index] !== "}") fail(message)
  closeJsonFrame(parser)
}

const advanceJsonObject = (parser, frame, message) => {
  switch (frame.state) {
    case "keyOrEnd":
      return readJsonObjectKey(parser, frame, true, message)
    case "key":
      return readJsonObjectKey(parser, frame, false, message)
    case "colon":
      if (parser.source[parser.index] !== ":") fail(message)
      parser.index += 1
      frame.state = "value"
      return
    case "value":
      frame.state = "commaOrEnd"
      return readJsonValue(parser, message)
    default:
      return readJsonObjectEnd(parser, frame, message)
  }
}

const readJsonArrayValue = (parser, frame, allowEnd, message) => {
  if (parser.source[parser.index] === "]") {
    if (!allowEnd) fail(message)
    closeJsonFrame(parser)
    return
  }
  frame.state = "commaOrEnd"
  readJsonValue(parser, message)
}

const readJsonArrayEnd = (parser, frame, message) => {
  if (parser.source[parser.index] === ",") {
    parser.index += 1
    frame.state = "value"
    return
  }
  if (parser.source[parser.index] !== "]") fail(message)
  closeJsonFrame(parser)
}

const advanceJsonArray = (parser, frame, message) => {
  switch (frame.state) {
    case "valueOrEnd":
      return readJsonArrayValue(parser, frame, true, message)
    case "value":
      return readJsonArrayValue(parser, frame, false, message)
    default:
      return readJsonArrayEnd(parser, frame, message)
  }
}

const assertNoDuplicateJsonKeys = (source, message) => {
  if (source.length > maxJsonCharacters) fail(message)
  const parser = { source, index: 0, frames: [], rootState: "value" }
  while (true) {
    skipJsonWhitespace(parser)
    const frame = parser.frames.at(-1)
    if (frame !== undefined) {
      if (frame.kind === "object") advanceJsonObject(parser, frame, message)
      else advanceJsonArray(parser, frame, message)
      continue
    }
    if (parser.rootState === "end") {
      if (parser.index !== source.length) fail(message)
      return
    }
    parser.rootState = "end"
    readJsonValue(parser, message)
  }
}

const readOptionalJson = async (handle) => {
  try {
    return JSON.parse(await handle.readFile("utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

const stableFileStatus = (opened, expected) =>
  opened.isFile() && opened.dev === expected.dev && opened.ino === expected.ino

const lockPrefix = (kind) => kind === "main" ? privateLockPrefix : privateRecoveryPrefix

const validLockOwner = (record, kind) =>
  sameKeys(record, ["schema", "kind", "pid", "nonce", "seed", "private"])
  && record.schema === 1
  && record.kind === kind
  && Number.isSafeInteger(record.pid)
  && record.pid > 0
  && typeof record.nonce === "string"
  && /^[A-Za-z0-9-]+$/.test(record.nonce)

const validLockSeed = (record, seedIdentity) =>
  sameKeys(record.seed, ["path", "dev", "ino"]) && sameIdentity(record.seed, seedIdentity)

const validLockPrivateReference = (record, prefix, name, status) =>
  sameKeys(record.private, ["name", "dev", "ino"])
  && record.private.name === name
  && name === `${prefix}${record.nonce}`
  && record.private.dev === String(status.dev)
  && record.private.ino === String(status.ino)

const validOwnedLockRecord = (record, kind, seedIdentity, status) =>
  validLockOwner(record, kind)
  && validLockSeed(record, seedIdentity)
  && validLockPrivateReference(record, lockPrefix(kind), record.private?.name, status)

const lockWasReleased = async (error, publicPath, label) => {
  if (!isMissing(error)) throw error
  if (await pathIsMissing(publicPath)) return true
  fail(`invalid ${label}`)
}

const openOwnedPublicLock = async (publicPath, label) => {
  const status = await optionalStatus(publicPath)
  if (status === undefined) return undefined
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 2) fail(`invalid ${label}`)
  try {
    return {
      status,
      handle: await open(publicPath, constants.O_RDONLY | constants.O_NOFOLLOW),
    }
  } catch (error) {
    if (await lockWasReleased(error, publicPath, label)) return undefined
    return undefined
  }
}

const validateOpenedOwnedLock = async (opened, expected, publicPath, label) => {
  if (!stableFileStatus(opened, expected)) fail(`invalid ${label}`)
  if (opened.nlink === 2) return true
  if (await pathIsMissing(publicPath)) return false
  fail(`invalid ${label}`)
}

const validateOwnedPrivateLock = async (privatePath, opened, publicPath, label) => {
  const status = await lstat(privatePath)
  if (!stableFileStatus(status, opened) || status.isSymbolicLink()) fail(`invalid ${label}`)
  if (status.nlink === 2) return true
  if (await pathIsMissing(publicPath)) return false
  fail(`invalid ${label}`)
}

const readOwnedLock = async (publicPath, kind, seedIdentity, buildRoot) => {
  const label = `${kind} lock`
  const publicLock = await openOwnedPublicLock(publicPath, label)
  if (publicLock === undefined) return undefined
  try {
    const opened = await publicLock.handle.stat()
    if (!await validateOpenedOwnedLock(opened, publicLock.status, publicPath, label)) return undefined
    const record = await readStrictJson(publicLock.handle, `invalid ${label}`)
    if (!validOwnedLockRecord(record, kind, seedIdentity, opened)) fail(`invalid ${label}`)
    const privatePath = path.join(buildRoot, record.private.name)
    if (!await validateOwnedPrivateLock(privatePath, opened, publicPath, label)) return undefined
    return { publicPath, privatePath, record }
  } catch (error) {
    if (await lockWasReleased(error, publicPath, label)) return undefined
    return undefined
  } finally {
    await publicLock.handle.close()
  }
}

const createOwnedLock = async (publicPath, kind, seedIdentity, buildRoot, nonce) => {
  const prefix = kind === "main" ? privateLockPrefix : privateRecoveryPrefix
  const privatePath = path.join(buildRoot, `${prefix}${nonce}`)
  let linked = false
  const handle = await open(
    privatePath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const status = await handle.stat()
    const record = {
      schema: 1,
      kind,
      pid: process.pid,
      nonce,
      seed: seedIdentity,
      private: { name: path.basename(privatePath), dev: String(status.dev), ino: String(status.ino) },
    }
    await handle.writeFile(json(record))
    await handle.chmod(0o600)
    await handle.sync()
    try {
      await link(privatePath, publicPath)
      linked = true
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return undefined
      throw error
    }
    return { publicPath, privatePath, record }
  } finally {
    await handle.close()
    if (!linked) await rm(privatePath, { force: true })
  }
}

const removeOwnedLock = async (owned, kind, seedIdentity, buildRoot) => {
  const current = await readOwnedLock(owned.publicPath, kind, seedIdentity, buildRoot)
  if (current === undefined || current.record.nonce !== owned.record.nonce) fail(`lost ${kind} lock ownership`)
  await rm(owned.publicPath)
  await rm(owned.privatePath)
}

const releaseOwnedLock = async (owned, kind, seedIdentity, buildRoot) => {
  try {
    const current = await readOwnedLock(owned.publicPath, kind, seedIdentity, buildRoot)
    if (current !== undefined && current.record.nonce === owned.record.nonce) await rm(owned.publicPath)
  } finally {
    await rm(owned.privatePath, { force: true })
  }
}

const privateLockDescriptor = (name) => {
  if (name.startsWith(privateLockPrefix)) return { kind: "main", prefix: privateLockPrefix }
  if (name.startsWith(privateRecoveryPrefix)) {
    return { kind: "recovery", prefix: privateRecoveryPrefix }
  }
  return undefined
}

const openOrphanPrivateLock = async (privatePath) => {
  const status = await optionalStatus(privatePath)
  if (status === undefined || !status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    return undefined
  }
  let handle
  try {
    handle = await open(privatePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  return { handle, status }
}

const readOrphanPrivateLock = async (privatePath) => {
  const openedPrivate = await openOrphanPrivateLock(privatePath)
  if (openedPrivate === undefined) return undefined
  try {
    const opened = await openedPrivate.handle.stat()
    if (!stableFileStatus(opened, openedPrivate.status) || opened.nlink !== 1) return undefined
    const record = await readOptionalJson(openedPrivate.handle)
    return record === undefined ? undefined : { opened, record }
  } finally {
    await openedPrivate.handle.close()
  }
}

const validOrphanPrivateLock = (record, descriptor, name, opened, seedIdentity) =>
  validLockOwner(record, descriptor.kind)
  && validLockSeed(record, seedIdentity)
  && validLockPrivateReference(record, descriptor.prefix, name, opened)
  && !processIsAlive(record.pid)

const removeConfirmedOrphanPrivateLock = async (privatePath, opened) => {
  const confirmed = await lstat(privatePath)
  if (stableFileStatus(confirmed, opened) && confirmed.nlink === 1) await rm(privatePath)
}

const cleanupOrphanPrivateLock = async (buildRoot, seedIdentity, name) => {
  const descriptor = privateLockDescriptor(name)
  if (descriptor === undefined) return
  const privatePath = path.join(buildRoot, name)
  const orphan = await readOrphanPrivateLock(privatePath)
  if (orphan === undefined) return
  if (!validOrphanPrivateLock(orphan.record, descriptor, name, orphan.opened, seedIdentity)) return
  await removeConfirmedOrphanPrivateLock(privatePath, orphan.opened)
}

const cleanupOrphanPrivateLocks = async (buildRoot, seedIdentity) => {
  const names = await readdir(buildRoot)
  for (const name of names.sort(lexical)) {
    await cleanupOrphanPrivateLock(buildRoot, seedIdentity, name)
  }
}

const validStageOwner = (record) =>
  sameKeys(record, ["schema", "seed", "pid", "nonce", "stage", "phase"])
  && record.schema === 1
  && Number.isSafeInteger(record.pid)
  && record.pid > 0
  && typeof record.nonce === "string"
  && /^[A-Za-z0-9-]+$/.test(record.nonce)

const validStageSeed = (record, seedIdentity) =>
  sameKeys(record.seed, ["path", "dev", "ino"]) && sameIdentity(record.seed, seedIdentity)

const validStageLocation = (record, name, prefix, status) =>
  name === `${prefix}${record.nonce}`
  && sameKeys(record.stage, ["dev", "ino"])
  && record.stage.dev === String(status.dev)
  && record.stage.ino === String(status.ino)

const validStageRecord = (record, seedIdentity, name, prefix, status) =>
  validStageOwner(record)
  && validStageSeed(record, seedIdentity)
  && validStageLocation(record, name, prefix, status)
  && typeof record.phase === "string"
  && stagePhases.has(record.phase)

const openOptionalStageState = async (statePath, stateStatus) => {
  let handle
  try {
    handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    const opened = await handle.stat()
    if (!stableFileStatus(opened, stateStatus) || opened.nlink !== 1) return undefined
    return await readOptionalJson(handle)
  } finally {
    await handle.close()
  }
}

const privateStageEntriesAreValid = async (stage) => {
  const allowed = new Set(["state.json", "state.next.json", ...outputNames])
  for (const entry of await readdir(stage)) {
    if (!allowed.has(entry)) return false
    const status = await lstat(path.join(stage, entry))
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) return false
  }
  return true
}

const readPrivateStageState = async (buildRoot, seedIdentity, name) => {
  const stage = path.join(buildRoot, name)
  const status = await optionalStatus(stage)
  if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) return undefined
  const statePath = path.join(stage, "state.json")
  const stateStatus = await optionalStatus(statePath)
  if (stateStatus === undefined || !stateStatus.isFile() || stateStatus.isSymbolicLink() || stateStatus.nlink !== 1) {
    return undefined
  }
  const record = await openOptionalStageState(statePath, stateStatus)
  if (!validStageRecord(record, seedIdentity, name, privateStagePrefix, status)) return undefined
  if (!await privateStageEntriesAreValid(stage)) return undefined
  return { stage, status, record }
}

const cleanupOrphanPrivateStages = async (buildRoot, seedIdentity) => {
  const names = (await readdir(buildRoot))
    .filter((name) => name.startsWith(privateStagePrefix))
    .sort(lexical)
  for (const name of names) {
    const owned = await readPrivateStageState(buildRoot, seedIdentity, name)
    if (owned === undefined || processIsAlive(owned.record.pid)) continue
    const confirmed = await lstat(owned.stage)
    if (confirmed.isDirectory() && !confirmed.isSymbolicLink()
      && confirmed.dev === owned.status.dev && confirmed.ino === owned.status.ino) {
      await rm(owned.stage, { recursive: true })
    }
  }
}

const clearStaleRecoveryLock = async (seed, seedIdentity, buildRoot) => {
  const recovery = await readOwnedLock(path.join(seed, recoveryName), "recovery", seedIdentity, buildRoot)
  if (recovery === undefined) return true
  if (processIsAlive(recovery.record.pid)) return false
  await removeOwnedLock(recovery, "recovery", seedIdentity, buildRoot)
  return true
}

const acquireRecoveryLock = async (seed, seedIdentity, buildRoot, deadline) => {
  const recoveryPath = path.join(seed, recoveryName)
  while (Date.now() < deadline) {
    if (!await clearStaleRecoveryLock(seed, seedIdentity, buildRoot)) {
      await pause(20)
      continue
    }
    const owned = await createOwnedLock(
      recoveryPath,
      "recovery",
      seedIdentity,
      buildRoot,
      `${process.pid}-${randomUUID()}`,
    )
    if (owned !== undefined) return owned
    await pause(20)
  }
  fail("timed out waiting for Copilot seed recovery lock")
}

const recoverExistingLock = async (seed, seedIdentity, buildRoot, deadline) => {
  const recovery = await acquireRecoveryLock(seed, seedIdentity, buildRoot, deadline)
  try {
    const currentRecovery = await readOwnedLock(recovery.publicPath, "recovery", seedIdentity, buildRoot)
    if (currentRecovery === undefined || currentRecovery.record.nonce !== recovery.record.nonce) {
      fail("lost recovery lock ownership")
    }
    const lock = await readOwnedLock(path.join(seed, lockName), "main", seedIdentity, buildRoot)
    if (lock === undefined) return true
    if (processIsAlive(lock.record.pid)) return false
    const confirmedRecovery = await readOwnedLock(recovery.publicPath, "recovery", seedIdentity, buildRoot)
    if (confirmedRecovery === undefined || confirmedRecovery.record.nonce !== recovery.record.nonce) {
      fail("lost recovery lock ownership")
    }
    await removeOwnedLock(lock, "main", seedIdentity, buildRoot)
    return true
  } finally {
    await releaseOwnedLock(recovery, "recovery", seedIdentity, buildRoot)
  }
}

const acquireLock = async (seed, seedIdentity, buildRoot) => {
  const lockPath = path.join(seed, lockName)
  const deadline = Date.now() + 10_000
  await cleanupOrphanPrivateStages(buildRoot, seedIdentity)
  await cleanupOrphanPrivateLocks(buildRoot, seedIdentity)
  while (Date.now() < deadline) {
    if (!await clearStaleRecoveryLock(seed, seedIdentity, buildRoot)) {
      await pause(20)
      continue
    }
    const owned = await createOwnedLock(lockPath, "main", seedIdentity, buildRoot, `${process.pid}-${randomUUID()}`)
    if (owned !== undefined) return owned
    await recoverExistingLock(seed, seedIdentity, buildRoot, deadline)
    await pause(20)
  }
  fail("timed out waiting for Copilot seed finalization lock")
}

const validatePluginManifest = (content, plugin, expectedVersion) => {
  const source = content.toString("utf8")
  assertNoDuplicateJsonKeys(source, "installed plugin manifest is invalid")
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    if (error instanceof SyntaxError) fail("installed plugin manifest is invalid")
    throw error
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("installed plugin manifest is invalid")
  if (parsed.name !== plugin) fail("installed plugin name mismatch")
  if (parsed.version !== expectedVersion) fail("installed plugin version mismatch")
}

const recordManagedDirectory = async (context, absolute, relative, status) => {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isDirectory() || opened.dev !== status.dev || opened.ino !== status.ino) {
      fail(`managed directory changed during inventory: ${relative}`)
    }
    if ((opened.mode & 0o7000) !== 0) {
      fail(`managed directory has special permission bits: ${relative}`)
    }
    context.managedEntries.push({
      path: relative,
      kind: "directory",
      mode: modeString(opened.mode),
    })
  } finally {
    await handle.close()
  }
}

const managedFileUnchanged = (after, opened) =>
  stableFileStatus(after, opened)
  && after.nlink === 1
  && after.size === opened.size
  && after.mtimeMs === opened.mtimeMs

const readManagedFile = async (absolute, relative, status) => {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!stableFileStatus(opened, status)) fail(`managed file changed during inventory: ${relative}`)
    if ((opened.mode & 0o7000) !== 0) fail(`managed file has special permission bits: ${relative}`)
    if (opened.nlink !== 1) fail(`managed file must have exactly one link: ${relative}`)
    const content = await handle.readFile()
    if (!managedFileUnchanged(await handle.stat(), opened)) {
      fail(`managed file changed during inventory: ${relative}`)
    }
    return { content, opened }
  } finally {
    await handle.close()
  }
}

const recordManagedFile = async (context, entry) => {
  const { content, opened } = await readManagedFile(entry.absolute, entry.relative, entry.status)
  if (context.forbiddenBuildPaths.some((candidate) => content.includes(Buffer.from(candidate)))) {
    fail(`temporary build root leaked in managed content: ${entry.relative}`)
  }
  if (authoritativeManifests.has(entry.installedRelative)) {
    if (context.foundManifest !== undefined) {
      fail(`ambiguous plugin manifest: ${entry.installedRelative}`)
    }
    validatePluginManifest(content, context.plugin, context.expectedVersion)
    context.foundManifest = entry.installedRelative
  }
  context.managedEntries.push({
    path: entry.relative,
    kind: "file",
    mode: modeString(opened.mode),
    sha256: sha256(content),
  })
}

const registerManagedPath = (context, relative, installedRelative) => {
  if (controlCharacterPattern.test(relative)) {
    fail(`control character in managed path: ${JSON.stringify(relative)}`)
  }
  if (unsupportedAlternateManifests.includes(installedRelative)) {
    fail(`ambiguous plugin manifest: ${installedRelative}`)
  }
  const normalized = relative.normalize("NFC")
  if (context.seen.has(normalized)) fail(`duplicate managed path: ${relative}`)
  context.seen.add(normalized)
}

const readManagedEntry = async (context, directory, entry) => {
  const absolute = path.join(directory, entry.name)
  const relative = path.relative(context.seed, absolute).split(path.sep).join("/")
  const installedRelative = path.relative(context.installed, absolute)
  registerManagedPath(context, relative, installedRelative)
  const status = await lstat(absolute)
  if (status.isSymbolicLink()) fail(`symlink rejected: ${relative}`)
  if (!inside(context.installed, await realpath(absolute))) {
    fail(`managed path escapes installed plugin: ${relative}`)
  }
  if (context.forbiddenBuildPaths.some((candidate) => relative.includes(candidate))) {
    fail(`temporary build root leaked in path: ${relative}`)
  }
  return { absolute, relative, installedRelative, status }
}

const inventoryManagedEntry = async (context, directory, child) => {
  const entry = await readManagedEntry(context, directory, child)
  if (entry.status.isDirectory()) {
    await recordManagedDirectory(context, entry.absolute, entry.relative, entry.status)
    await inventoryManagedDirectory(context, entry.absolute)
    return
  }
  if (!entry.status.isFile()) fail(`special file rejected: ${entry.relative}`)
  await recordManagedFile(context, entry)
}

const inventoryManagedDirectory = async (context, directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => lexical(left.name, right.name))
  for (const entry of entries) await inventoryManagedEntry(context, directory, entry)
}

const inventoryPlugin = async (seed, installed, forbiddenBuildPaths, plugin, expectedVersion) => {
  const context = {
    seed,
    installed,
    forbiddenBuildPaths,
    plugin,
    expectedVersion,
    seen: new Set(),
    managedEntries: [],
    foundManifest: undefined,
  }
  const installedStatus = await lstat(installed)
  if (!installedStatus.isDirectory() || installedStatus.isSymbolicLink()) fail("installed plugin path must be a directory")
  const installedRelative = path.relative(seed, installed).split(path.sep).join("/")
  context.seen.add(installedRelative.normalize("NFC"))
  await recordManagedDirectory(context, installed, installedRelative, installedStatus)
  await inventoryManagedDirectory(context, installed)
  if (context.foundManifest === undefined) fail("installed plugin manifest is missing")
  context.managedEntries.sort((left, right) => lexical(left.path, right.path))
  return context.managedEntries
}

const validateGenericSkillPath = (relative) => {
  if (controlCharacterPattern.test(relative)) fail(`unsafe generic skill path: ${relative}`)
  if (relative.includes("\\")) fail(`unsafe generic skill path: ${relative}`)
  for (const segment of relative.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      fail(`unsafe generic skill path: ${relative}`)
    }
  }
}

const recordGenericSkillFile = async (context, absolute, relative, status) => {
  const content = await readFile(absolute)
  if (context.forbiddenBuildPaths.some((candidate) => content.includes(Buffer.from(candidate)))) {
    fail(`temporary build root leaked in generic skill: ${relative}`)
  }
  context.entries.push({
    path: path.posix.join("skills", relative),
    kind: "file",
    mode: modeString(status.mode),
    sha256: sha256(content),
  })
}

const inventoryGenericSkillEntry = async (context, directory, relativeDirectory, child) => {
  const absolute = path.join(directory, child.name)
  const relative = path.posix.join(relativeDirectory, child.name)
  validateGenericSkillPath(relative)
  const status = await lstat(absolute)
  if (status.isSymbolicLink()) fail(`generic skill symlink rejected: ${relative}`)
  if (!inside(context.root, await realpath(absolute))) {
    fail(`generic skill path escapes seed: ${relative}`)
  }
  if (status.isDirectory()) {
    await inventoryGenericSkillDirectory(context, absolute, relative)
    return
  }
  if (status.isFile()) {
    await recordGenericSkillFile(context, absolute, relative, status)
    return
  }
  fail(`unsupported generic skill entry: ${relative}`)
}

const inventoryGenericSkillDirectory = async (context, directory, relativeDirectory) => {
  const children = await readdir(directory, { withFileTypes: true })
  children.sort((left, right) => lexical(left.name, right.name))
  for (const child of children) {
    await inventoryGenericSkillEntry(context, directory, relativeDirectory, child)
  }
}

const inventoryGenericSkills = async (seed, forbiddenBuildPaths) => {
  const skills = path.join(seed, "skills")
  if (await pathIsMissing(skills)) return []
  const rootStatus = await lstat(skills)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) fail("generic skills path must be a directory")
  const root = await realpath(skills)
  const context = { root, forbiddenBuildPaths, entries: [] }
  for (const name of await readdir(skills)) safeIdentifier(name, "generic skill")
  await inventoryGenericSkillDirectory(context, skills, "")
  return context.entries
}

const instructionFilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*\.instructions\.md$/

const inventoryInstructionFiles = async (seed, forbiddenBuildPaths) => {
  const directory = path.join(seed, "instructions")
  if (await pathIsMissing(directory)) return []
  const rootStatus = await lstat(directory)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) fail("instructions path must be a directory")
  const root = await realpath(directory)
  const entries = []
  const children = await readdir(directory, { withFileTypes: true })
  children.sort((left, right) => lexical(left.name, right.name))
  for (const child of children) {
    if (!instructionFilePattern.test(child.name)) fail(`unsafe instruction path: ${child.name}`)
    const absolute = path.join(directory, child.name)
    const status = await lstat(absolute)
    if (status.isSymbolicLink() || !status.isFile()) fail(`instruction symlink rejected: ${child.name}`)
    if (!inside(root, await realpath(absolute))) fail(`instruction path escapes seed: ${child.name}`)
    const content = await readFile(absolute)
    if (forbiddenBuildPaths.some((candidate) => content.includes(Buffer.from(candidate)))) {
      fail(`temporary build root leaked in instruction: ${child.name}`)
    }
    entries.push({
      path: path.posix.join("instructions", child.name),
      kind: "file",
      mode: modeString(status.mode),
      sha256: sha256(content),
    })
  }
  return entries
}

const inventoryGenericInstructions = async (seed, forbiddenBuildPaths) => {
  const instructions = path.join(seed, "copilot-instructions.md")
  if (await pathIsMissing(instructions)) return []
  const status = await lstat(instructions)
  if (!status.isFile() || status.isSymbolicLink()) fail("generic Copilot instructions must be a regular file")
  const content = await readFile(instructions)
  if (forbiddenBuildPaths.some((candidate) => content.includes(Buffer.from(candidate)))) {
    fail("temporary build root leaked in generic Copilot instructions")
  }
  return [{
    path: "copilot-instructions.md",
    kind: "file",
    mode: modeString(status.mode),
    sha256: sha256(content),
  }]
}

const invalidStage = (name) => fail(`invalid finalization stage: ${name}`)

const readRequiredStageRecord = async (stage, name) => {
  const statePath = path.join(stage, "state.json")
  try {
    const stateStatus = await lstat(statePath)
    if (!stateStatus.isFile() || stateStatus.isSymbolicLink() || stateStatus.nlink !== 1) {
      invalidStage(name)
    }
    const handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!stableFileStatus(opened, stateStatus) || opened.nlink !== 1) invalidStage(name)
      return await readStrictJson(handle, `invalid finalization stage: ${name}`)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isMissing(error)) invalidStage(name)
    throw error
  }
}

const validatePublicStageEntries = async (stage, name) => {
  const allowed = new Set(["state.json", "state.next.json", ...outputNames])
  for (const entry of await readdir(stage)) {
    if (!allowed.has(entry)) invalidStage(name)
    const status = await lstat(path.join(stage, entry))
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) invalidStage(name)
  }
}

const readStageState = async (seed, seedIdentity, name) => {
  const stage = path.join(seed, name)
  const status = await lstat(stage)
  if (!status.isDirectory() || status.isSymbolicLink()) invalidStage(name)
  const record = await readRequiredStageRecord(stage, name)
  if (!validStageRecord(record, seedIdentity, name, stagePrefix, status)) invalidStage(name)
  await validatePublicStageEntries(stage, name)
  return { stage, record }
}

const recoverStages = async (seed, seedIdentity) => {
  const names = await readdir(seed)
  for (const name of names.filter((candidate) => candidate.startsWith(stagePrefix)).sort(lexical)) {
    if (controlCharacterPattern.test(name)) fail(`control character in finalization stage path: ${JSON.stringify(name)}`)
    const { stage, record } = await readStageState(seed, seedIdentity, name)
    if (processIsAlive(record.pid)) fail(`live finalization stage: ${name}`)
    await rm(stage, { recursive: true, force: true })
  }
}

const removeEmptyCopilotPluginLock = async (seed) => {
  const lockPath = path.join(seed, copilotPluginLockName)
  let status
  try {
    status = await lstat(lockPath)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size !== 0) {
    fail(`${copilotPluginLockName} must be an empty regular file`)
  }
  await rm(lockPath)
}

const nativeMarketplacePath = (settings, marketplace) => {
  const localSource = settings?.extraKnownMarketplaces?.[marketplace]?.source
  if (localSource?.source !== "directory") fail("native marketplace source is not local")
  if (
    typeof localSource.path !== "string" ||
    !path.isAbsolute(localSource.path) ||
    path.resolve(localSource.path) !== localSource.path
  ) {
    fail("native marketplace directory path is unsafe")
  }
  return localSource.path
}

const validateNativeMarketplacePath = async (localPath, expectedSourceArgument, expectedSource, seed) => {
  if (path.resolve(localPath) !== expectedSourceArgument) {
    fail("marketplace directory must equal materialized hve-core source")
  }
  const sourceStatus = await lstat(localPath)
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    fail("native marketplace path must be a directory")
  }
  const source = await realpath(localPath)
  if (source !== expectedSource || inside(seed, source)) {
    fail("native marketplace directory escapes build root")
  }
}

const validateNativePluginRegistration = async (
  settingsPath,
  marketplace,
  plugin,
  expectedSourceArgument,
  expectedSource,
  seed,
) => {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"))
  const localPath = nativeMarketplacePath(settings, marketplace)
  await validateNativeMarketplacePath(localPath, expectedSourceArgument, expectedSource, seed)
  if (settings?.enabledPlugins?.[`${plugin}@${marketplace}`] !== true) {
    fail("native plugin is not enabled")
  }
}

const readMarketplaceManifest = async (expectedSource) => {
  const manifestPath = path.join(expectedSource, ".github", "plugin", "marketplace.json")
  const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const status = await handle.stat()
    if (!status.isFile()) fail("native marketplace manifest must be a regular file")
    const source = await handle.readFile("utf8")
    assertNoDuplicateJsonKeys(source, "native marketplace manifest is invalid")
    let manifest
    try {
      manifest = JSON.parse(source)
    } catch (error) {
      if (error instanceof SyntaxError) fail("native marketplace manifest is invalid")
      throw error
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      fail("native marketplace manifest is invalid")
    }
    return manifest
  } finally {
    await handle.close()
  }
}

const marketplacePluginEntry = (manifest, marketplace, plugin, expectedVersion) => {
  if (manifest.name !== marketplace || !Array.isArray(manifest.plugins)) {
    fail("native marketplace manifest does not match the selected marketplace")
  }
  const matches = manifest.plugins.filter(
    (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && entry.name === plugin,
  )
  if (matches.length !== 1) fail("native marketplace plugin source is missing or ambiguous")
  if (matches[0].version !== expectedVersion) fail("native marketplace plugin version does not match the lock")
  return matches[0]
}

const marketplacePluginRootSegments = (metadata) => {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("native marketplace metadata is invalid")
  }
  const pluginRoot = metadata.pluginRoot
  if (pluginRoot === undefined) return []
  if (
    typeof pluginRoot !== "string" ||
    pluginRoot.length === 0 ||
    controlCharacterPattern.test(pluginRoot) ||
    pluginRoot.includes("\\") ||
    path.posix.isAbsolute(pluginRoot) ||
    path.win32.isAbsolute(pluginRoot)
  ) {
    fail("native marketplace pluginRoot is unsafe")
  }
  const relative = pluginRoot.startsWith("./") ? pluginRoot.slice(2) : pluginRoot
  const segments = relative.split("/")
  if (segments.length === 0 || segments.some((segment) => !identifierPattern.test(segment))) {
    fail("native marketplace pluginRoot is unsafe")
  }
  return segments
}

const marketplacePluginSourceSegments = (source) => {
  if (source === ".") return []
  if (
    typeof source !== "string" ||
    !identifierPattern.test(source) ||
    path.posix.isAbsolute(source) ||
    path.win32.isAbsolute(source) ||
    source.includes("/") ||
    source.includes("\\")
  ) {
    fail("native marketplace plugin source is unsafe")
  }
  return [source]
}

const resolveMarketplacePluginSource = async (expectedSource, marketplace, plugin, expectedVersion) => {
  const manifest = await readMarketplaceManifest(expectedSource)
  const entry = marketplacePluginEntry(manifest, marketplace, plugin, expectedVersion)
  const candidate = path.join(
    expectedSource,
    ...marketplacePluginRootSegments(manifest.metadata),
    ...marketplacePluginSourceSegments(entry.source),
  )
  const sourceStatus = await lstat(candidate)
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    fail("live plugin source must be a directory")
  }
  const resolved = await realpath(candidate)
  if (!inside(expectedSource, resolved)) fail("live plugin source escapes the marketplace")
  return resolved
}

const ensureDirectory = async (directory, label) => {
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }
  const status = await lstat(directory)
  if (!status.isDirectory() || status.isSymbolicLink()) fail(`${label} must be a directory`)
}

const beginDereferencedDirectory = async (directory, allowedRoot, ancestors, visited) => {
  const resolved = await realpath(directory)
  if (!inside(allowedRoot, resolved)) {
    fail("live plugin symlink target escapes the marketplace")
  }
  if (ancestors.has(resolved)) fail("live plugin symlink cycle rejected")
  if (visited.has(resolved)) return undefined
  visited.add(resolved)
  return new Set(ancestors).add(resolved)
}

const validateDereferencedSymlink = async (absolute, context) => {
  const target = await realpath(absolute)
  if (!inside(context.allowedRoot, target)) {
    fail("live plugin symlink target escapes the marketplace")
  }
  const status = await lstat(target)
  if (status.isDirectory()) {
    await validateDereferencedDirectory(
      target,
      context.allowedRoot,
      context.ancestors,
      context.visited,
    )
    return
  }
  if (!status.isFile()) fail("live plugin symlink target must be a regular file or directory")
}

const validateDereferencedEntry = async (absolute, status, context) => {
  if (status.isSymbolicLink()) {
    await validateDereferencedSymlink(absolute, context)
    return
  }
  if (status.isDirectory()) {
    await validateDereferencedDirectory(
      absolute,
      context.allowedRoot,
      context.ancestors,
      context.visited,
    )
    return
  }
  if (!status.isFile()) fail("live plugin source contains an unsupported path")
}

const validateDereferencedDirectory = async (
  directory,
  allowedRoot,
  ancestors,
  visited,
) => {
  const nextAncestors = await beginDereferencedDirectory(
    directory,
    allowedRoot,
    ancestors,
    visited,
  )
  if (nextAncestors === undefined) return
  const context = { allowedRoot, ancestors: nextAncestors, visited }
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    await validateDereferencedEntry(absolute, await lstat(absolute), context)
  }
}

const validateDereferencedPlugin = async (sourcePlugin, allowedRoot) => {
  await validateDereferencedDirectory(sourcePlugin, allowedRoot, new Set(), new Set())
}

const normalizeCopiedPluginDirectory = async (directory) => {
  await chmod(directory, 0o755)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    const status = await lstat(absolute)
    if (status.isDirectory() && !status.isSymbolicLink()) {
      await normalizeCopiedPluginDirectory(absolute)
      continue
    }
    if (!status.isFile() || status.isSymbolicLink()) {
      fail("copied live plugin contains an unsupported path")
    }
    await chmod(absolute, status.mode & 0o111 ? 0o755 : 0o644)
  }
}

const materializeLivePlugin = async (seed, expectedSource, marketplace, plugin, expectedVersion) => {
  const installedRoot = path.join(seed, "installed-plugins")
  const marketplaceRoot = path.join(installedRoot, marketplace)
  const installed = path.join(marketplaceRoot, plugin)
  const sourcePluginReal = await resolveMarketplacePluginSource(
    expectedSource,
    marketplace,
    plugin,
    expectedVersion,
  )
  try {
    await lstat(installed)
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  await validateDereferencedPlugin(sourcePluginReal, expectedSource)

  await ensureDirectory(installedRoot, "installed-plugins")
  await ensureDirectory(marketplaceRoot, `installed-plugins/${marketplace}`)
  const temporary = path.join(marketplaceRoot, `.trellage-live-plugin-${randomUUID()}`)
  try {
    await cp(sourcePluginReal, temporary, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    })
    await normalizeCopiedPluginDirectory(temporary)
    await rename(temporary, installed)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const requireExactDirectory = async (directory, expected, label) => {
  const status = await lstat(directory)
  if (!status.isDirectory() || status.isSymbolicLink()) fail(`${label} must be a directory`)
  const actual = (await readdir(directory)).sort(lexical)
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(lexical))) {
    fail(`${label} contains unexpected paths`)
  }
}

const seedDirectoryNames = new Set(["installed-plugins", "skills", "instructions"])
const allowedSeedNames = new Set([
  "settings.json",
  "config.json",
  ...seedDirectoryNames,
  "copilot-instructions.md",
  ...outputNames,
  lockName,
  recoveryName,
])

const validateSeedEntryName = (name) => {
  if (controlCharacterPattern.test(name)) {
    fail(`control character in seed path: ${JSON.stringify(name)}`)
  }
  if (!allowedSeedNames.has(name)) fail(`unexpected seed path: ${name}`)
}

const readSeedEntryStatus = async (seed, name) => {
  try {
    return await lstat(path.join(seed, name))
  } catch (error) {
    if (name === recoveryName && isMissing(error)) return undefined
    throw error
  }
}

const validateSeedDirectory = (name, status) => {
  if (!status.isDirectory() || status.isSymbolicLink()) fail(`${name} must be a directory`)
}

const expectedSeedLinks = (name) => name === lockName || name === recoveryName ? 2 : 1

const validateRetainedSeedFile = async (absolute, name, forbiddenBuildPaths) => {
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const content = await handle.readFile()
    if (forbiddenBuildPaths.some((candidate) => content.includes(Buffer.from(candidate)))) {
      fail(`temporary build root leaked in retained file: ${name}`)
    }
  } finally {
    await handle.close()
  }
}

const validateSeedFile = async (absolute, name, status, forbiddenBuildPaths) => {
  if (!status.isFile() || status.isSymbolicLink()) fail(`${name} must be a regular file`)
  const expectedLinks = expectedSeedLinks(name)
  if (status.nlink !== expectedLinks) fail(`${name} must have exactly ${expectedLinks} links`)
  if (outputNames.includes(name)) {
    await validateRetainedSeedFile(absolute, name, forbiddenBuildPaths)
  }
}

const validateSeedEntry = async (seed, name, forbiddenBuildPaths) => {
  validateSeedEntryName(name)
  const status = await readSeedEntryStatus(seed, name)
  if (status === undefined) return
  if (seedDirectoryNames.has(name)) {
    validateSeedDirectory(name, status)
    return
  }
  await validateSeedFile(path.join(seed, name), name, status, forbiddenBuildPaths)
}

const validateInstalledPluginTree = async (seed, marketplace, plugin) => {
  const installedRoot = path.join(seed, "installed-plugins")
  const marketplaceRoot = path.join(installedRoot, marketplace)
  const installed = path.join(marketplaceRoot, plugin)
  await requireExactDirectory(installedRoot, [marketplace], "installed-plugins")
  await requireExactDirectory(marketplaceRoot, [plugin], `installed-plugins/${marketplace}`)
  const status = await lstat(installed)
  if (!status.isDirectory() || status.isSymbolicLink()) {
    fail("installed plugin path must be a directory")
  }
  return installed
}

const validateSeedTree = async (seed, marketplace, plugin, forbiddenBuildPaths) => {
  const names = await readdir(seed)
  for (const name of names) await validateSeedEntry(seed, name, forbiddenBuildPaths)
  return validateInstalledPluginTree(seed, marketplace, plugin)
}

const prepareInstalledPlugin = async ({
  seed,
  marketplace,
  plugin,
  forbiddenBuildPaths,
  expectedSourceArgument,
  expectedSource,
  expectedVersion,
  managed,
}) => {
  const settingsPath = path.join(seed, "settings.json")
  const configPath = path.join(seed, "config.json")
  const settingsFile = await optionalRegularFile(settingsPath, "settings.json")
  await optionalRegularFile(configPath, "config.json")
  if (settingsFile !== undefined) {
    await validateNativePluginRegistration(
      settingsPath,
      marketplace,
      plugin,
      expectedSourceArgument,
      expectedSource,
      seed,
    )
    await materializeLivePlugin(seed, expectedSource, marketplace, plugin, expectedVersion)
  }
  const installed = await validateSeedTree(seed, marketplace, plugin, forbiddenBuildPaths)
  if (settingsFile === undefined) {
    for (const name of outputNames) {
      const output = await optionalRegularFile(path.join(seed, name), name)
      if (output === undefined) fail(`finalized seed is missing ${name}`)
    }
    assertExactJson(JSON.parse(await readFile(path.join(seed, "managed-settings.json"), "utf8")), managed, "managed-settings.json")
  }
  return { installed, settingsFile }
}

const writeStageState = async (stage, seedIdentity, stageIdentity, owner, phase) => {
  const temporary = path.join(stage, "state.next.json")
  await writeFile(temporary, json({
    schema: 1,
    seed: seedIdentity,
    pid: owner.pid,
    nonce: owner.nonce,
    stage: stageIdentity,
    phase,
  }), { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path.join(stage, "state.json"))
}

const publishFinalizedSeed = async (seed, buildRoot, seedIdentity, owner, buffers) => {
  const stage = path.join(seed, `${stagePrefix}${owner.nonce}`)
  const privateStage = path.join(buildRoot, `${privateStagePrefix}${owner.nonce}`)
  await mkdir(privateStage, { mode: 0o700 })
  const privateStageStatus = await lstat(privateStage)
  const stageIdentity = { dev: String(privateStageStatus.dev), ino: String(privateStageStatus.ino) }
  let published = false
  try {
    await writeStageState(privateStage, seedIdentity, stageIdentity, owner, "staged")
    if (process.env.NODE_ENV === "test" && process.env.TRELLAGE_TEST_FINALIZER_STOP_AFTER_PRIVATE_STAGE === "1") {
      process.kill(process.pid, "SIGSTOP")
    }
    await rename(privateStage, stage)
    published = true
    for (const name of outputNames) {
      const target = path.join(stage, name)
      await writeFile(target, buffers[name], { mode: 0o644, flag: "wx" })
      await chmod(target, 0o644)
    }
    const phases = ["published-settings", "published-files", "published-hashes", "published-marker"]
    for (let index = 0; index < outputNames.length; index += 1) {
      const name = outputNames[index]
      await rename(path.join(stage, name), path.join(seed, name))
      await writeStageState(stage, seedIdentity, stageIdentity, owner, phases[index])
    }
    await rm(path.join(seed, "settings.json"), { force: true })
    await writeStageState(stage, seedIdentity, stageIdentity, owner, "removed-settings")
    await rm(path.join(seed, "config.json"), { force: true })
    await writeStageState(stage, seedIdentity, stageIdentity, owner, "removed-config")
  } finally {
    await rm(published ? stage : privateStage, { recursive: true, force: true })
  }
}

const main = async () => {
  const args = process.argv.slice(2)
  if (args.length !== 4) fail("expected exactly 4 arguments: seed marketplace plugin expected-version")
  const [seedArgument, marketplace, plugin, expectedVersion] = args
  if (!path.isAbsolute(seedArgument)) fail("seed path must be absolute")
  if (path.resolve(seedArgument) !== seedArgument || seedArgument === path.parse(seedArgument).root) fail("seed path is unsafe")
  safeIdentifier(marketplace, "marketplace")
  safeIdentifier(plugin, "plugin")
  if (!versionPattern.test(expectedVersion)) fail("expected plugin version is unsafe")

  const seedStatus = await lstat(seedArgument)
  if (!seedStatus.isDirectory() || seedStatus.isSymbolicLink()) fail("seed path must be a directory")
  const seed = await realpath(seedArgument)
  const buildRootArgument = path.dirname(seedArgument)
  const buildRoot = await realpath(buildRootArgument)
  const expectedSourceArgument = path.join(buildRootArgument, "hve-core")
  const expectedSource = await realpath(expectedSourceArgument)
  const forbiddenBuildPaths = [...new Set([
    ...knownBuildOnlyPaths,
    seedArgument,
    seed,
    expectedSourceArgument,
    expectedSource,
  ])].filter((value) => value.length > 1)
  const seedIdentity = await identityOf(seed)
  const finalizationLock = await acquireLock(seed, seedIdentity, buildRoot)
  try {
    await cleanupOrphanPrivateStages(buildRoot, seedIdentity)
    await recoverStages(seed, seedIdentity)
    await removeEmptyCopilotPluginLock(seed)
    const managed = {
      extraKnownMarketplaces: {
        [marketplace]: { source: { source: "github", repo: "microsoft/hve-core" } },
      },
      enabledPlugins: { [`${plugin}@${marketplace}`]: true },
    }
    const { installed, settingsFile } = await prepareInstalledPlugin({
      seed,
      marketplace,
      plugin,
      forbiddenBuildPaths,
      expectedSourceArgument,
      expectedSource,
      expectedVersion,
      managed,
    })

    const installedReal = await realpath(installed)
    if (!inside(seed, installedReal)) fail("installed plugin path escapes seed")
    const pluginEntries = await inventoryPlugin(seed, installedReal, forbiddenBuildPaths, plugin, expectedVersion)
    const genericEntries = [
      ...await inventoryGenericSkills(seed, forbiddenBuildPaths),
      ...await inventoryGenericInstructions(seed, forbiddenBuildPaths),
      ...await inventoryInstructionFiles(seed, forbiddenBuildPaths),
    ]
    const managedEntries = [...pluginEntries, ...genericEntries].sort((left, right) => lexical(left.path, right.path))
    const marker = {
      schema: 1,
      marketplace,
      plugin,
      version: expectedVersion,
      files: managedEntries,
    }
    if (settingsFile === undefined) {
      assertExactJson(JSON.parse(await readFile(path.join(seed, "managed-lock.json"), "utf8")), marker, "managed-lock.json")
    }

    const settingsBuffer = json(managed)
    const lockBuffer = json(marker)
    const pluginFiles = managedEntries.filter((entry) => entry.kind === "file")
    const managedFiles = [
      ...pluginFiles.map((entry) => entry.path),
      "managed-lock.json",
      "managed-settings.json",
    ].sort(lexical)
    const filesBuffer = Buffer.from(`${managedFiles.join("\n")}\n`)
    const hashes = [
      ...pluginFiles.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
      { path: "managed-lock.json", sha256: sha256(lockBuffer) },
      { path: "managed-settings.json", sha256: sha256(settingsBuffer) },
    ].sort((left, right) => lexical(left.path, right.path))
    const hashesBuffer = Buffer.from(`${hashes.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`)

    await publishFinalizedSeed(seed, buildRoot, seedIdentity, finalizationLock.record, {
      "managed-settings.json": settingsBuffer,
      "managed-files.txt": filesBuffer,
      "managed.sha256": hashesBuffer,
      "managed-lock.json": lockBuffer,
    })
  } finally {
    await releaseOwnedLock(finalizationLock, "main", seedIdentity, buildRoot)
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
