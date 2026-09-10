#!/usr/bin/env node

import { constants } from "node:fs"
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const fail = (message) => {
  throw new Error(message)
}

export const statusIfPresent = async (candidate) => {
  try {
    return await lstat(candidate)
  } catch (error) {
    if (error.code === "ENOENT") return undefined
    throw error
  }
}

const requireOwnedEntry = (candidate, status) => {
  if (status.isSymbolicLink()) fail(`unsafe skills path (symlink): ${candidate}`)
  if (status.uid !== process.getuid()) fail(`skills path is not owned by the current user: ${candidate}`)
  if ((status.mode & 0o022) !== 0) fail(`skills path is writable by another user: ${candidate}`)
  if (status.isFile() && status.nlink !== 1) fail(`unsafe hard-linked skills file: ${candidate}`)
}

const expectedDirectoryPath = async (candidate) => {
  const home = process.env.HOME
  if (home === undefined || !path.isAbsolute(home)) return candidate
  const homePath = path.resolve(home)
  if (candidate !== homePath && !candidate.startsWith(`${homePath}${path.sep}`)) return candidate
  const status = await lstat(homePath)
  requireOwnedEntry(homePath, status)
  if (!status.isDirectory()) fail(`HOME is not a directory: ${homePath}`)
  // Native wrappers permit OS aliases above HOME, but never redirected paths inside it.
  return path.join(await realpath(homePath), path.relative(homePath, candidate))
}

export const requireDirectory = async (candidate, label) => {
  if (!path.isAbsolute(candidate)) fail(`${label} must be an absolute path: ${candidate}`)
  const resolved = path.resolve(candidate)
  const status = await statusIfPresent(resolved)
  if (status === undefined) fail(`${label} is missing: ${resolved}`)
  requireOwnedEntry(resolved, status)
  if (!status.isDirectory()) fail(`${label} is not a directory: ${resolved}`)
  const expected = await expectedDirectoryPath(resolved)
  if ((await realpath(resolved)) !== expected) fail(`unsafe redirected ${label}: ${resolved}`)
  return expected
}

export const requireFile = async (candidate) => {
  const status = await statusIfPresent(candidate)
  if (status === undefined) fail(`skills file is missing: ${candidate}`)
  requireOwnedEntry(candidate, status)
  if (!status.isFile()) fail(`skills path is not a regular file: ${candidate}`)
}

const requireManagedTree = async (candidate) => {
  const status = await lstat(candidate)
  requireOwnedEntry(candidate, status)
  if (status.isFile()) return
  if (!status.isDirectory()) fail(`unsupported skills entry: ${candidate}`)
  for (const name of await readdir(candidate)) {
    await requireManagedTree(path.join(candidate, name))
  }
}

const readSnapshotNames = async (cache) => {
  const manifest = path.join(cache, "managed-skills.txt")
  await requireFile(manifest)
  const names = (await readFile(manifest, "utf8")).split("\n").filter(Boolean)
  if (names.length === 0 || names.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) {
    fail(`invalid skill snapshot manifest: ${manifest}`)
  }
  const sorted = [...new Set(names)].sort((left, right) => left.localeCompare(right, "en"))
  if (JSON.stringify(names) !== JSON.stringify(sorted)) fail(`invalid skill snapshot manifest: ${manifest}`)
  return names
}

// Preflight every snapshot before publishing any target (OMP has two).
const requireSnapshot = async (cache) => {
  const names = await readSnapshotNames(cache)
  const skills = await requireDirectory(path.join(cache, "skills"), "snapshot skills directory")
  const entries = (await readdir(skills)).sort((left, right) => left.localeCompare(right, "en"))
  if (JSON.stringify(entries) !== JSON.stringify(names)) fail(`skill snapshot does not match its manifest: ${cache}`)
  await requireFile(path.join(cache, "always-on.md"))
  for (const name of names) {
    const directory = await requireDirectory(path.join(skills, name), "snapshot skill directory")
    await requireManagedTree(directory)
    const skillFile = path.join(directory, "SKILL.md")
    await requireFile(skillFile)
    if ((await readFile(skillFile, "utf8")).includes("\r")) fail(`skill SKILL.md must use LF line endings: ${name}`)
  }
  return names
}

const requireTarget = async (target, names) => {
  const managed = await targetManagedNames(target)
  for (const name of managed) {
    const candidate = path.join(target, name)
    if (await statusIfPresent(candidate)) {
      await requireDirectory(candidate, "managed skill directory")
      await requireManagedTree(candidate)
    }
  }
  for (const name of names) {
    const candidate = path.join(target, name)
    if (!managed.includes(name) && (await statusIfPresent(candidate))) {
      fail(`refusing to replace unmanaged skill: ${candidate}`)
    }
  }
}

const readManagedManifest = async (candidate, legacy = false) => {
  if (!(await statusIfPresent(candidate))) return []
  await requireFile(candidate)
  const lines = (await readFile(candidate, "utf8")).split("\n").filter(Boolean)
  if (legacy && !/^[0-9a-f]{40}$/.test(lines.shift() ?? "")) {
    fail(`invalid legacy managed skill manifest: ${candidate}`)
  }
  if (lines.length === 0 || lines.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) {
    fail(`invalid managed skill manifest: ${candidate}`)
  }
  if (new Set(lines).size !== lines.length) fail(`invalid managed skill manifest: ${candidate}`)
  return lines
}

const legacyShowMe = async (target) => {
  const directory = path.join(target, "show-me")
  const status = await statusIfPresent(directory)
  if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) return []
  const marker = path.join(directory, ".managed-by-trellage-picx-profiles")
  if (!(await statusIfPresent(marker))) return []
  await requireFile(marker)
  if ((await readFile(marker, "utf8")) !== "trellage-picx-profile-v2\n") {
    fail(`invalid legacy managed skill marker: ${marker}`)
  }
  return ["show-me"]
}

const targetManagedNames = async (target) => {
  const current = await readManagedManifest(path.join(target, ".trellage-managed-skills"))
  const legacy = await readManagedManifest(path.join(target, ".trellage-engineersamuel-skills"), true)
  const names = current.length > 0 ? current : [...new Set([...legacy, ...(await legacyShowMe(target))])]
  if (names.length === 0) fail(`profile skills are not managed: ${target}; run the profile setup command first`)
  return names
}

const requireTargetLock = async (target) => {
  const lock = path.join(target, ".trellage-floating-skills.lock")
  if (!(await statusIfPresent(lock))) return
  await requireDirectory(lock, "skill lock")
  const pidFile = path.join(lock, "pid")
  await requireFile(pidFile)
  const entries = await readdir(lock)
  const pid = await readFile(pidFile, "utf8")
  if (entries.length !== 1 || entries[0] !== "pid") fail(`invalid skill lock: ${lock}`)
  if (!/^[1-9][0-9]*\n?$/.test(pid) || !Number.isSafeInteger(Number(pid))) fail(`invalid skill lock: ${lock}`)
}

const preflightPair = async (cachePath, targetPath, excluded, manager) => {
  let cache
  try {
    cache = await requireDirectory(cachePath, "skill cache")
  } catch (error) {
    fail(`${error.message}; run trx skills update first`)
  }
  const snapshotNames = await requireSnapshot(cache)
  const names = excluded.length === 0 ? snapshotNames : manager.selectTargetSkills(snapshotNames, excluded)
  await requireDirectory(path.dirname(targetPath), "profile home")
  const target = await requireDirectory(targetPath, "profile skills directory")
  await requireTarget(target, names)
  await requireTargetLock(target)
  if (excluded.length > 0) await manager.verifyTargetExclusions(target, excluded, true)
  return { cache, target, excluded }
}

export const syncCachedSkills = async (managerPath, pairs, checkOnly = false) => {
  const resolvedManager = path.resolve(managerPath)
  await requireFile(resolvedManager)
  if ((await realpath(resolvedManager)) !== resolvedManager) fail(`unsafe skills manager: ${managerPath}`)
  const manager = await import(pathToFileURL(resolvedManager).href)
  const validated = []
  for (const [cache, target, excluded = []] of pairs) {
    validated.push(await preflightPair(cache, target, excluded, manager))
  }
  if (checkOnly) return
  for (const { cache, target, excluded } of validated) {
    await preflightPair(cache, target, excluded, manager)
    await manager.syncSnapshot(cache, target, excluded)
    await manager.verifyTarget(cache, target, excluded)
  }
}

const bundlesForCache = (cache) => {
  switch (path.basename(cache)) {
    case "skills": return ["native-common"]
    case "cdx-skills": return ["native-common", "codex-common"]
    case "cdx-youtube-pro-skills": return ["native-common", "codex-common", "youtube"]
    case "omp-community-skills": return ["omp-community"]
    case "guide-prompt-master-skills": return ["guide-prompt-master"]
    default: fail(`unknown skill cache variant: ${cache}`)
  }
}

const targetMatches = async (manager, snapshot, target, excluded) => {
  try {
    await manager.verifyTarget(snapshot, target, excluded)
    return true
  } catch (error) {
    if (error instanceof manager.FloatingSkillsError && /^managed skills? differ/.test(error.message)) return false
    throw error
  }
}

export const checkFreshSkills = async (managerPath, catalogPath, pairs, signal) => {
  await syncCachedSkills(managerPath, pairs, true)
  await requireFile(catalogPath)
  const manager = await import(pathToFileURL(path.resolve(managerPath)).href)
  if (manager.readOnlyStageSupported !== true) fail("refresh the floating-skills runtime to enable read-only checks")
  const catalog = await manager.readCatalog(catalogPath)
  const stage = path.join(process.cwd(), `.trellage-skills-check.${randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  try {
    let current = true
    const snapshots = new Map()
    for (const [cache, target, excluded = []] of pairs) {
      signal?.throwIfAborted()
      const bundles = bundlesForCache(cache)
      const key = bundles.join("+")
      let snapshot = snapshots.get(key)
      if (snapshot === undefined) {
        snapshot = path.join(stage, key)
        await manager.stageLatest({ catalog, bundleIds: bundles, destination: snapshot, readOnly: true, signal })
        snapshots.set(key, snapshot)
      }
      await preflightPair(cache, target, excluded, manager)
      if (!(await targetMatches(manager, snapshot, target, excluded))) current = false
    }
    signal?.throwIfAborted()
    return { kind: current ? "current" : "available" }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

const installHelper = async (runtimeRoot, includeManual = false) => {
  const root = await requireDirectory(runtimeRoot, "Native runtime")
  const sourceRoot = path.dirname(fileURLToPath(import.meta.url))
  const helpers = includeManual ? ["native-skills.mjs", "manual-skills.mjs"] : ["native-skills.mjs"]
  for (const name of helpers) {
    await requireFile(path.join(sourceRoot, name))
    if (await statusIfPresent(path.join(root, name))) await requireFile(path.join(root, name))
  }
  for (const name of helpers) {
    const stage = path.join(root, `.${name}.${randomUUID()}`)
    let staged = false
    try {
      await copyFile(path.join(sourceRoot, name), stage, constants.COPYFILE_EXCL)
      staged = true
      await chmod(stage, 0o644)
      await rename(stage, path.join(root, name))
    } finally {
      if (staged) {
        await unlink(stage).catch((error) => {
          if (error.code !== "ENOENT") throw error
        })
      }
    }
  }
}

const main = async (args) => {
  if (args.length === 2 && ["--install", "--install-manual"].includes(args[0])) {
    return installHelper(args[1], args[0] === "--install-manual")
  }
  const [manager, command, ...remaining] = args
  const catalog = command === "--fresh" ? remaining.shift() : undefined
  const paths = remaining
  if (!["--sync", "--check", "--fresh"].includes(command) || paths.length === 0 || paths.length % 2 !== 0) {
    fail("usage: native-skills.mjs MANAGER --sync|--check|--fresh [CATALOG] CACHE TARGET [CACHE TARGET...]")
  }
  const pairs = []
  for (let index = 0; index < paths.length; index += 2) pairs.push(paths.slice(index, index + 2))
  if (command === "--fresh") {
    const controller = new AbortController()
    const abort = () => controller.abort(new Error("Skills check cancelled."))
    process.once("SIGTERM", abort)
    process.once("SIGINT", abort)
    try {
      process.stdout.write(`${JSON.stringify(await checkFreshSkills(manager, catalog, pairs, controller.signal))}\n`)
    } finally {
      process.removeListener("SIGTERM", abort)
      process.removeListener("SIGINT", abort)
    }
    return
  }
  await syncCachedSkills(manager, pairs, command === "--check")
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`native skills update: ${error.message}\n`)
    process.exitCode = 1
  })
}
