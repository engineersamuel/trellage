#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
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
const authoritativeManifest = path.join(".github", "plugin", "plugin.json")
const alternateManifests = [
  "plugin.json",
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

const pathIsMissing = async (file) => {
  try {
    await lstat(file)
    return false
  } catch (error) {
    if (isMissing(error)) return true
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

const readOwnedLock = async (publicPath, kind, seedIdentity, buildRoot) => {
  const label = `${kind} lock`
  let foundPublic = false
  try {
    const status = await lstat(publicPath)
    foundPublic = true
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 2) fail(`invalid ${label}`)
    const handle = await open(publicPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) {
        fail(`invalid ${label}`)
      }
      if (opened.nlink !== 2) {
        if (await pathIsMissing(publicPath)) return undefined
        fail(`invalid ${label}`)
      }
      let record
      try {
        record = JSON.parse(await handle.readFile("utf8"))
      } catch (error) {
        if (error instanceof SyntaxError) fail(`invalid ${label}`)
        throw error
      }
      const prefix = kind === "main" ? privateLockPrefix : privateRecoveryPrefix
      if (!sameKeys(record, ["schema", "kind", "pid", "nonce", "seed", "private"])
        || record.schema !== 1 || record.kind !== kind || !Number.isSafeInteger(record.pid) || record.pid <= 0
        || typeof record.nonce !== "string" || !/^[A-Za-z0-9-]+$/.test(record.nonce)
        || !sameKeys(record.seed, ["path", "dev", "ino"]) || !sameIdentity(record.seed, seedIdentity)
        || !sameKeys(record.private, ["name", "dev", "ino"])
        || record.private.name !== `${prefix}${record.nonce}`
        || record.private.dev !== String(opened.dev) || record.private.ino !== String(opened.ino)) {
        fail(`invalid ${label}`)
      }
      const privatePath = path.join(buildRoot, record.private.name)
      const privateStatus = await lstat(privatePath)
      if (!privateStatus.isFile() || privateStatus.isSymbolicLink()
        || privateStatus.dev !== opened.dev || privateStatus.ino !== opened.ino) fail(`invalid ${label}`)
      if (privateStatus.nlink !== 2) {
        if (await pathIsMissing(publicPath)) return undefined
        fail(`invalid ${label}`)
      }
      return { publicPath, privatePath, record }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isMissing(error) && !foundPublic) return undefined
    if (isMissing(error)) {
      if (await pathIsMissing(publicPath)) return undefined
      fail(`invalid ${label}`)
    }
    throw error
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

const cleanupOrphanPrivateLocks = async (buildRoot, seedIdentity) => {
  const names = await readdir(buildRoot)
  for (const name of names.sort(lexical)) {
    const kind = name.startsWith(privateLockPrefix)
      ? "main"
      : name.startsWith(privateRecoveryPrefix) ? "recovery" : undefined
    if (kind === undefined) continue
    const prefix = kind === "main" ? privateLockPrefix : privateRecoveryPrefix
    const privatePath = path.join(buildRoot, name)
    let status
    try {
      status = await lstat(privatePath)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) continue
    const handle = await open(privatePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino || opened.nlink !== 1) continue
      let record
      try {
        record = JSON.parse(await handle.readFile("utf8"))
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
      if (!sameKeys(record, ["schema", "kind", "pid", "nonce", "seed", "private"])
        || record.schema !== 1 || record.kind !== kind || !Number.isSafeInteger(record.pid) || record.pid <= 0
        || typeof record.nonce !== "string" || !/^[A-Za-z0-9-]+$/.test(record.nonce)
        || name !== `${prefix}${record.nonce}` || !sameKeys(record.seed, ["path", "dev", "ino"])
        || !sameIdentity(record.seed, seedIdentity) || !sameKeys(record.private, ["name", "dev", "ino"])
        || record.private.name !== name || record.private.dev !== String(opened.dev)
        || record.private.ino !== String(opened.ino) || processIsAlive(record.pid)) continue
      const confirmed = await lstat(privatePath)
      if (confirmed.dev === opened.dev && confirmed.ino === opened.ino && confirmed.nlink === 1) await rm(privatePath)
    } finally {
      await handle.close()
    }
  }
}

const readPrivateStageState = async (buildRoot, seedIdentity, name) => {
  const stage = path.join(buildRoot, name)
  let status
  try {
    status = await lstat(stage)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (!status.isDirectory() || status.isSymbolicLink()) return undefined
  const statePath = path.join(stage, "state.json")
  let stateStatus
  try {
    stateStatus = await lstat(statePath)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  if (!stateStatus.isFile() || stateStatus.isSymbolicLink() || stateStatus.nlink !== 1) return undefined
  const handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let record
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== stateStatus.dev || opened.ino !== stateStatus.ino || opened.nlink !== 1) {
      return undefined
    }
    try {
      record = JSON.parse(await handle.readFile("utf8"))
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  } finally {
    await handle.close()
  }
  if (!sameKeys(record, ["schema", "seed", "pid", "nonce", "stage", "phase"])
    || record.schema !== 1 || !sameKeys(record.seed, ["path", "dev", "ino"])
    || !sameIdentity(record.seed, seedIdentity) || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || typeof record.nonce !== "string" || !/^[A-Za-z0-9-]+$/.test(record.nonce)
    || name !== `${privateStagePrefix}${record.nonce}` || !sameKeys(record.stage, ["dev", "ino"])
    || record.stage.dev !== String(status.dev) || record.stage.ino !== String(status.ino)
    || typeof record.phase !== "string" || !stagePhases.has(record.phase)) return undefined
  const allowed = new Set(["state.json", "state.next.json", ...outputNames])
  for (const entry of await readdir(stage)) {
    if (!allowed.has(entry)) return undefined
    const entryStatus = await lstat(path.join(stage, entry))
    if (!entryStatus.isFile() || entryStatus.isSymbolicLink() || entryStatus.nlink !== 1) return undefined
  }
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
  let parsed
  try {
    parsed = JSON.parse(content.toString("utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) fail("installed plugin manifest is invalid")
    throw error
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("installed plugin manifest is invalid")
  if (parsed.name !== plugin) fail("installed plugin name mismatch")
  if (parsed.version !== expectedVersion) fail("installed plugin version mismatch")
}

const inventoryPlugin = async (seed, installed, forbiddenBuildPaths, plugin, expectedVersion) => {
  const seen = new Set()
  const managedEntries = []
  let foundManifest = false
  const recordDirectory = async (absolute, relative, status) => {
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isDirectory() || opened.dev !== status.dev || opened.ino !== status.ino) {
        fail(`managed directory changed during inventory: ${relative}`)
      }
      if ((opened.mode & 0o7000) !== 0) fail(`managed directory has special permission bits: ${relative}`)
      managedEntries.push({ path: relative, kind: "directory", mode: modeString(opened.mode) })
    } finally {
      await handle.close()
    }
  }
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => lexical(left.name, right.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(seed, absolute).split(path.sep).join("/")
      const installedRelative = path.relative(installed, absolute)
      if (controlCharacterPattern.test(relative)) fail(`control character in managed path: ${JSON.stringify(relative)}`)
      if (alternateManifests.includes(installedRelative)) fail(`ambiguous plugin manifest: ${installedRelative}`)
      const normalized = relative.normalize("NFC")
      if (seen.has(normalized)) fail(`duplicate managed path: ${relative}`)
      seen.add(normalized)
      const status = await lstat(absolute)
      if (status.isSymbolicLink()) fail(`symlink rejected: ${relative}`)
      const resolved = await realpath(absolute)
      if (!inside(installed, resolved)) fail(`managed path escapes installed plugin: ${relative}`)
      if (forbiddenBuildPaths.some((candidate) => relative.includes(candidate))) {
        fail(`temporary build root leaked in path: ${relative}`)
      }
      if (status.isDirectory()) {
        await recordDirectory(absolute, relative, status)
        await visit(absolute)
        continue
      }
      if (!status.isFile()) fail(`special file rejected: ${relative}`)
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) {
          fail(`managed file changed during inventory: ${relative}`)
        }
        if ((opened.mode & 0o7000) !== 0) fail(`managed file has special permission bits: ${relative}`)
        if (opened.nlink !== 1) fail(`managed file must have exactly one link: ${relative}`)
        const content = await handle.readFile()
        const after = await handle.stat()
        if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
          || after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
          fail(`managed file changed during inventory: ${relative}`)
        }
        if (forbiddenBuildPaths.some((candidate) => content.includes(Buffer.from(candidate)))) {
          fail(`temporary build root leaked in managed content: ${relative}`)
        }
        if (installedRelative === authoritativeManifest) {
          validatePluginManifest(content, plugin, expectedVersion)
          foundManifest = true
        }
        managedEntries.push({
          path: relative,
          kind: "file",
          mode: modeString(opened.mode),
          sha256: sha256(content),
        })
      } finally {
        await handle.close()
      }
    }
  }
  const installedStatus = await lstat(installed)
  if (!installedStatus.isDirectory() || installedStatus.isSymbolicLink()) fail("installed plugin path must be a directory")
  const installedRelative = path.relative(seed, installed).split(path.sep).join("/")
  seen.add(installedRelative.normalize("NFC"))
  await recordDirectory(installed, installedRelative, installedStatus)
  await visit(installed)
  if (!foundManifest) fail(`installed plugin manifest is missing: ${authoritativeManifest}`)
  managedEntries.sort((left, right) => lexical(left.path, right.path))
  return managedEntries
}

const inventoryGenericSkills = async (seed, forbiddenBuildPaths) => {
  const skills = path.join(seed, "skills")
  if (await pathIsMissing(skills)) return []
  const rootStatus = await lstat(skills)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) fail("generic skills path must be a directory")
  const root = await realpath(skills)
  const entries = []
  const visit = async (directory, relativeDirectory) => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => lexical(left.name, right.name))
    for (const child of children) {
      const absolute = path.join(directory, child.name)
      const relative = path.posix.join(relativeDirectory, child.name)
      if (
        controlCharacterPattern.test(relative) ||
        relative.includes("\\") ||
        relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        fail(`unsafe generic skill path: ${relative}`)
      }
      const status = await lstat(absolute)
      if (status.isSymbolicLink()) fail(`generic skill symlink rejected: ${relative}`)
      const resolved = await realpath(absolute)
      if (!inside(root, resolved)) fail(`generic skill path escapes seed: ${relative}`)
      if (status.isDirectory()) {
        await visit(absolute, relative)
      } else if (status.isFile()) {
        const content = await readFile(absolute)
        if (forbiddenBuildPaths.some((candidate) => content.includes(Buffer.from(candidate)))) {
          fail(`temporary build root leaked in generic skill: ${relative}`)
        }
        entries.push({
          path: path.posix.join("skills", relative),
          kind: "file",
          mode: modeString(status.mode),
          sha256: sha256(content),
        })
      } else {
        fail(`unsupported generic skill entry: ${relative}`)
      }
    }
  }
  for (const name of await readdir(skills)) safeIdentifier(name, "generic skill")
  await visit(skills, "")
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

const readStageState = async (seed, seedIdentity, name) => {
  const stage = path.join(seed, name)
  const status = await lstat(stage)
  if (!status.isDirectory() || status.isSymbolicLink()) fail(`invalid finalization stage: ${name}`)
  const statePath = path.join(stage, "state.json")
  let record
  try {
    const stateStatus = await lstat(statePath)
    if (!stateStatus.isFile() || stateStatus.isSymbolicLink() || stateStatus.nlink !== 1) {
      fail(`invalid finalization stage: ${name}`)
    }
    const handle = await open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== stateStatus.dev || opened.ino !== stateStatus.ino || opened.nlink !== 1) {
        fail(`invalid finalization stage: ${name}`)
      }
      try {
        record = JSON.parse(await handle.readFile("utf8"))
      } catch (error) {
        if (error instanceof SyntaxError) fail(`invalid finalization stage: ${name}`)
        throw error
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (isMissing(error)) fail(`invalid finalization stage: ${name}`)
    throw error
  }
  if (!sameKeys(record, ["schema", "seed", "pid", "nonce", "stage", "phase"])
    || record.schema !== 1 || !sameKeys(record.seed, ["path", "dev", "ino"])
    || !sameIdentity(record.seed, seedIdentity) || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || typeof record.nonce !== "string" || !/^[A-Za-z0-9-]+$/.test(record.nonce)
    || name !== `${stagePrefix}${record.nonce}` || !sameKeys(record.stage, ["dev", "ino"])
    || record.stage.dev !== String(status.dev) || record.stage.ino !== String(status.ino)
    || typeof record.phase !== "string" || !stagePhases.has(record.phase)) {
    fail(`invalid finalization stage: ${name}`)
  }
  const allowed = new Set(["state.json", "state.next.json", ...outputNames])
  for (const entry of await readdir(stage)) {
    if (!allowed.has(entry)) fail(`invalid finalization stage: ${name}`)
    const entryStatus = await lstat(path.join(stage, entry))
    if (!entryStatus.isFile() || entryStatus.isSymbolicLink() || entryStatus.nlink !== 1) {
      fail(`invalid finalization stage: ${name}`)
    }
  }
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

const requireExactDirectory = async (directory, expected, label) => {
  const status = await lstat(directory)
  if (!status.isDirectory() || status.isSymbolicLink()) fail(`${label} must be a directory`)
  const actual = (await readdir(directory)).sort(lexical)
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort(lexical))) {
    fail(`${label} contains unexpected paths`)
  }
}

const validateSeedTree = async (seed, marketplace, plugin, forbiddenBuildPaths) => {
  const allowed = new Set([
    "settings.json",
    "config.json",
    "installed-plugins",
    "skills",
    "copilot-instructions.md",
    ...outputNames,
    lockName,
    recoveryName,
  ])
  const names = await readdir(seed)
  for (const name of names) {
    if (controlCharacterPattern.test(name)) fail(`control character in seed path: ${JSON.stringify(name)}`)
    if (!allowed.has(name)) fail(`unexpected seed path: ${name}`)
    const absolute = path.join(seed, name)
    let status
    try {
      status = await lstat(absolute)
    } catch (error) {
      if (name === recoveryName && isMissing(error)) continue
      throw error
    }
    if (name === "installed-plugins" || name === "skills") {
      if (!status.isDirectory() || status.isSymbolicLink()) fail(`${name} must be a directory`)
      continue
    }
    if (!status.isFile() || status.isSymbolicLink()) fail(`${name} must be a regular file`)
    const expectedLinks = name === lockName || name === recoveryName ? 2 : 1
    if (status.nlink !== expectedLinks) fail(`${name} must have exactly ${expectedLinks} links`)
    if (outputNames.includes(name)) {
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
  }
  const marketplaceRoot = path.join(seed, "installed-plugins", marketplace)
  const installed = path.join(marketplaceRoot, plugin)
  await requireExactDirectory(path.join(seed, "installed-plugins"), [marketplace], "installed-plugins")
  await requireExactDirectory(marketplaceRoot, [plugin], `installed-plugins/${marketplace}`)
  const installedStatus = await lstat(installed)
  if (!installedStatus.isDirectory() || installedStatus.isSymbolicLink()) fail("installed plugin path must be a directory")
  return installed
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
    const installed = await validateSeedTree(seed, marketplace, plugin, forbiddenBuildPaths)
    const managed = {
      extraKnownMarketplaces: {
        [marketplace]: { source: { source: "github", repo: "microsoft/hve-core" } },
      },
      enabledPlugins: { [`${plugin}@${marketplace}`]: true },
    }
    const settingsPath = path.join(seed, "settings.json")
    const configPath = path.join(seed, "config.json")
    const settingsFile = await optionalRegularFile(settingsPath, "settings.json")
    await optionalRegularFile(configPath, "config.json")
    if (settingsFile !== undefined) {
      const settings = JSON.parse(await readFile(settingsPath, "utf8"))
      const localSource = settings?.extraKnownMarketplaces?.[marketplace]?.source
      if (localSource?.source !== "directory") fail("native marketplace source is not local")
      if (typeof localSource.path !== "string" || !path.isAbsolute(localSource.path)
        || path.resolve(localSource.path) !== localSource.path) fail("native marketplace directory path is unsafe")
      if (path.resolve(localSource.path) !== expectedSourceArgument) {
        fail("marketplace directory must equal materialized hve-core source")
      }
      const sourceStatus = await lstat(localSource.path)
      if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
        fail("native marketplace path must be a directory")
      }
      const source = await realpath(localSource.path)
      if (source !== expectedSource || inside(seed, source)) {
        fail("native marketplace directory escapes build root")
      }
      if (settings?.enabledPlugins?.[`${plugin}@${marketplace}`] !== true) fail("native plugin is not enabled")
    } else {
      for (const name of outputNames) {
        const output = await optionalRegularFile(path.join(seed, name), name)
        if (output === undefined) fail(`finalized seed is missing ${name}`)
      }
      assertExactJson(JSON.parse(await readFile(path.join(seed, "managed-settings.json"), "utf8")), managed, "managed-settings.json")
    }

    const installedReal = await realpath(installed)
    if (!inside(seed, installedReal)) fail("installed plugin path escapes seed")
    const pluginEntries = await inventoryPlugin(seed, installedReal, forbiddenBuildPaths, plugin, expectedVersion)
    const genericEntries = [
      ...await inventoryGenericSkills(seed, forbiddenBuildPaths),
      ...await inventoryGenericInstructions(seed, forbiddenBuildPaths),
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
