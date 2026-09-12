#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

import { execFile, spawn } from "node:child_process"
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { bunArguments, bunExecutable } from "@trellage/runtime"

export enum SkillAdapter {
  Generic = "generic",
  OmpNative = "omp-native",
}

export interface SkillSource {
  readonly id: string
  readonly repository: string
  readonly select: readonly string[]
  readonly exclude: readonly string[]
  readonly required: readonly string[]
  readonly adapter: SkillAdapter
  readonly alwaysOn: boolean
  readonly allowExecutables: boolean
}

export interface SkillCatalog {
  readonly schema: 1
  readonly sources: Readonly<Record<string, SkillSource>>
  readonly bundles: Readonly<Record<string, readonly string[]>>
}

interface SkillOptions {
  readonly catalog: SkillCatalog
  readonly bundleIds: readonly string[]
  readonly skillsCli?: string | undefined
}

export interface StageOptions extends SkillOptions {
  readonly destination: string
  readonly readOnly?: boolean | undefined
  readonly signal?: AbortSignal | undefined
}

export interface NativeOptions extends SkillOptions {
  readonly cache: string
}

export enum SkillCurrency {
  Current = "current",
  Available = "available",
  Unknown = "unknown",
}

export type SkillCheck =
  | { readonly kind: SkillCurrency.Current | SkillCurrency.Available; readonly diagnostic?: string }
  | { readonly kind: SkillCurrency.Unknown; readonly diagnostic: string }

interface SharedVariant {
  readonly name: string
  readonly bundles: readonly string[]
  readonly cache: string
}

interface CommandOptions {
  bundles: string[]
  excluded: string[]
  catalog?: string
  output?: string
  target?: string
  cache?: string
  skills_cli?: string
}

interface RunOptions {
  readonly cwd?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly signal?: AbortSignal | undefined
}

interface AlwaysOnSkill {
  readonly name: string
  readonly instructions: string
}

const execFilePromise = promisify(execFile)
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const safeRepository = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/
const maxSkills = 200
const maxSnapshotBytes = 100 * 1024 * 1024
export const readOnlyStageSupported = true

export class FloatingSkillsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "FloatingSkillsError"
  }
}

function fail(message: string, cause?: unknown): never {
  throw new FloatingSkillsError(message, cause === undefined ? undefined : { cause })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const assertStringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string")) {
    fail(`${label} must be a non-empty string array`)
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`)
  return value
}

const parseBooleanPolicy = (candidate: Record<string, unknown>, key: string, id: string) => {
  const value = candidate[key]
  if (value !== undefined && typeof value !== "boolean") fail(`invalid ${key} policy: ${id}`)
  return value === true
}

const parseOptionalSkillNames = (
  candidate: Record<string, unknown>,
  key: string,
  label: string,
  id: string,
): string[] => {
  const names = candidate[key] ?? []
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !safeName.test(name))) {
    fail(`${label} must be a string array: ${id}`)
  }
  if (new Set(names).size !== names.length) fail(`${label} contain duplicates: ${id}`)
  return names
}

const assertKnownSourcePolicy = (id: string, candidate: Record<string, unknown>) => {
  const allowedKeys = new Set([
    "repository",
    "select",
    "exclude",
    "required",
    "adapter",
    "alwaysOn",
    "allowExecutables",
    "allowWildcard",
  ])
  const unknownKey = Object.keys(candidate).find((key) => !allowedKeys.has(key))
  if (unknownKey !== undefined) fail(`unknown skill source policy ${unknownKey}: ${id}`)
}

const parseSourceSelections = (id: string, candidate: Record<string, unknown>) => {
  const select = assertStringArray(candidate.select, `skill source selections: ${id}`)
  if (select.some((name) => name !== "*" && !safeName.test(name))) fail(`unsafe selected skill: ${id}`)
  const exclude = parseOptionalSkillNames(candidate, "exclude", "skill source exclusions", id)
  const required = parseOptionalSkillNames(candidate, "required", "required skills", id)
  const allowWildcard = parseBooleanPolicy(candidate, "allowWildcard", id)
  if (select.includes("*") && !allowWildcard) fail(`wildcard selection is not allowed: ${id}`)
  if (select.includes("*") && select.length !== 1) fail(`wildcard selection must be the only selection: ${id}`)
  if (exclude.length > 0 && !select.includes("*")) fail(`skill exclusions require wildcard selection: ${id}`)
  if (required.length > 0 && !select.includes("*")) fail(`required skills require wildcard selection: ${id}`)
  const excludedRequired = required.find((name) => exclude.includes(name))
  if (excludedRequired !== undefined) fail(`required skill is excluded: ${id}/${excludedRequired}`)
  return { select, exclude, required }
}

const parseSource = (id: string, candidate: unknown): SkillSource => {
  if (!safeName.test(id) || !isRecord(candidate)) fail(`invalid skill source: ${id}`)
  assertKnownSourcePolicy(id, candidate)
  if (typeof candidate.repository !== "string" || !safeRepository.test(candidate.repository)) {
    fail(`invalid skill repository: ${id}`)
  }
  const { select, exclude, required } = parseSourceSelections(id, candidate)
  const allowExecutables = parseBooleanPolicy(candidate, "allowExecutables", id)
  const alwaysOn = parseBooleanPolicy(candidate, "alwaysOn", id)
  const adapter = candidate.adapter ?? SkillAdapter.Generic
  if (adapter !== SkillAdapter.Generic && adapter !== SkillAdapter.OmpNative) fail(`invalid skill adapter: ${id}`)
  if (adapter !== SkillAdapter.Generic && alwaysOn) fail(`always-on is supported only for generic skills: ${id}`)
  return Object.freeze({
    id,
    repository: candidate.repository,
    select: Object.freeze([...select]),
    exclude: Object.freeze([...exclude]),
    required: Object.freeze([...required]),
    adapter,
    alwaysOn,
    allowExecutables,
  })
}

const parseSources = (raw: Record<string, unknown>) =>
  Object.freeze(Object.fromEntries(Object.entries(raw).map(([id, candidate]) => [id, parseSource(id, candidate)])))

const parseBundles = (raw: Record<string, unknown>, sources: SkillCatalog["sources"]) => {
  const bundles: Record<string, readonly string[]> = {}
  for (const [id, candidate] of Object.entries(raw)) {
    if (!safeName.test(id)) fail(`invalid skill bundle: ${id}`)
    const sourceIds = assertStringArray(candidate, `skill bundle sources: ${id}`)
    const unknown = sourceIds.find((sourceId) => sources[sourceId] === undefined)
    if (unknown !== undefined) fail(`unknown skill source in bundle ${id}: ${unknown}`)
    bundles[id] = Object.freeze([...sourceIds])
  }
  return Object.freeze(bundles)
}

export const parseCatalog = (source: string): SkillCatalog => {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (cause) {
    fail("skill catalog is not valid JSON", cause)
  }
  if (!isRecord(raw) || raw.schema !== 1 || !isRecord(raw.sources) || !isRecord(raw.bundles)) {
    fail("skill catalog must contain schema 1, sources, and bundles")
  }
  if (Object.keys(raw).some((key) => !["schema", "sources", "bundles"].includes(key))) {
    fail("skill catalog contains an unknown field")
  }
  const sources = parseSources(raw.sources)
  return Object.freeze({ schema: 1, sources, bundles: parseBundles(raw.bundles, sources) })
}

export const readCatalog = async (catalogPath: string) => {
  try {
    return parseCatalog(await readFile(catalogPath, "utf8"))
  } catch (cause) {
    if (cause instanceof FloatingSkillsError) throw cause
    fail(`cannot read skill catalog: ${catalogPath}`, cause)
  }
}

export const resolvePlan = (catalog: SkillCatalog, bundleIds: readonly string[]) => {
  if (bundleIds.length === 0) fail("at least one skill bundle is required")
  const sourceIds: string[] = []
  const seen = new Set<string>()
  for (const bundleId of bundleIds) {
    if (!safeName.test(bundleId)) fail(`invalid skill bundle: ${bundleId}`)
    const bundle = catalog.bundles[bundleId]
    if (bundle === undefined) fail(`unknown skill bundle: ${bundleId}`)
    for (const sourceId of bundle) {
      if (seen.has(sourceId)) continue
      seen.add(sourceId)
      sourceIds.push(sourceId)
    }
  }
  return sourceIds.map((sourceId) => {
    const source = catalog.sources[sourceId]
    if (source === undefined) fail(`unknown skill source: ${sourceId}`)
    return source
  })
}

const run = async (command: string, args: readonly string[], options: RunOptions = {}) => {
  try {
    return await execFilePromise(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      env: options.env,
      signal: options.signal,
    })
  } catch (cause) {
    const detail =
      isRecord(cause) && typeof cause.stderr === "string" && cause.stderr.trim().length > 0
        ? `: ${cause.stderr.trim()}`
        : ""
    fail(`command failed: ${command}${detail}`, cause)
  }
}

const runInteractive = (command: string, args: readonly string[], cwd: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        CI: "1",
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        npm_config_ignore_scripts: "true",
      },
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) resolve()
      else reject(new FloatingSkillsError(`skills generator failed (${signal ?? code ?? "unknown"})`))
    })
  })

const localSkillsCli = async () => {
  let candidate: string
  try {
    candidate = fileURLToPath(import.meta.resolve("skills/bin/cli.mjs"))
  } catch (cause) {
    if (isRecord(cause) && ["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(String(cause.code))) {
      return undefined
    }
    throw cause
  }
  const status = await lstat(candidate)
  if (!status.isFile() || status.isSymbolicLink()) {
    fail(`installed skills CLI is not a regular file: ${candidate}`)
  }
  return candidate
}

const generateGenericSkills = async (
  source: SkillSource,
  checkout: string,
  destination: string,
  skillsCli: string | undefined,
  readOnly = false,
  signal?: AbortSignal,
) => {
  await mkdir(destination, { recursive: true })
  const args = ["add", checkout, "--skill", ...source.select, "--agent", "codex", "--copy", "--yes"]
  const local = skillsCli ?? (await localSkillsCli())
  if (readOnly && local === undefined)
    fail("read-only skills check requires the installed skills CLI; no packages were installed")
  if (local === undefined) fail("skills CLI is missing; run bun install --frozen-lockfile in the source workspace")
  if (readOnly) {
    await run(bunExecutable(), bunArguments(local, args), {
      cwd: destination,
      signal,
      env: {
        ...process.env,
        HOME: destination,
        XDG_STATE_HOME: path.join(destination, ".state"),
        XDG_CONFIG_HOME: path.join(destination, ".config"),
        XDG_CACHE_HOME: path.join(destination, ".cache"),
        XDG_DATA_HOME: path.join(destination, ".data"),
        CODEX_HOME: path.join(destination, ".codex"),
        NODE_DISABLE_COMPILE_CACHE: "1",
        TMPDIR: destination,
        CI: "1",
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        npm_config_ignore_scripts: "true",
      },
    })
    return path.join(destination, ".agents", "skills")
  }
  await runInteractive(bunExecutable(), bunArguments(local, args), destination)
  return path.join(destination, ".agents", "skills")
}

const checkoutLatest = async (
  repository: string,
  destination: string,
  signal: AbortSignal | undefined,
  readOnly: boolean,
) => {
  const options = readOnly
    ? { signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", TMPDIR: path.dirname(destination) } }
    : { signal }
  const gitOptions = readOnly ? ["-c", "credential.helper=", "-c", "core.askPass="] : []
  await mkdir(destination)
  await run("git", [...gitOptions, "init", "--quiet", destination], options)
  await run("git", [...gitOptions, "-C", destination, "remote", "add", "origin", repository], options)
  await run("git", [...gitOptions, "-C", destination, "fetch", "--quiet", "--depth", "1", "origin", "HEAD"], options)
  await run("git", [...gitOptions, "-C", destination, "checkout", "--quiet", "--detach", "FETCH_HEAD"], options)
  await rm(path.join(destination, ".git"), { recursive: true, force: true })
}

const validateSkillDirectory = async (skillRoot: string, name: string, allowExecutables: boolean) => {
  if (!safeName.test(name)) fail(`unsafe generated skill name: ${name}`)
  let bytes = 0
  const visit = async (candidate: string): Promise<void> => {
    const status = await lstat(candidate)
    if (status.isSymbolicLink()) fail(`skill contains a symlink: ${name}`)
    if (status.isDirectory()) {
      const entries = await readdir(candidate)
      entries.sort((left, right) => left.localeCompare(right, "en"))
      for (const entry of entries) await visit(path.join(candidate, entry))
      return
    }
    if (!status.isFile()) fail(`skill contains an unsupported entry: ${name}`)
    if (!allowExecutables && (status.mode & 0o111) !== 0) {
      fail(`skill contains executable content without permission: ${name}`)
    }
    bytes += status.size
  }
  const directory = path.join(skillRoot, name)
  await visit(directory)
  const skillFile = path.join(directory, "SKILL.md")
  const skillStatus = await lstat(skillFile).catch(() => undefined)
  if (skillStatus === undefined || !skillStatus.isFile() || skillStatus.isSymbolicLink()) {
    fail(`skill has no regular SKILL.md: ${name}`)
  }
  const instructions = await readFile(skillFile, "utf8")
  if (instructions.includes("\r")) fail(`skill SKILL.md must use LF line endings: ${name}`)
  return { bytes, instructions }
}

const publishDirectory = async (stage: string, destination: string) => {
  const parent = path.dirname(destination)
  await mkdir(parent, { recursive: true })
  const status = await lstat(destination).catch(() => undefined)
  if (status?.isSymbolicLink()) fail(`refusing to replace symlinked destination: ${destination}`)
  if (status !== undefined && !status.isDirectory()) fail(`destination is not a directory: ${destination}`)
  const backup = `${stage}.old`
  if (status !== undefined) await rename(destination, backup)
  try {
    await rename(stage, destination)
    await rm(backup, { recursive: true, force: true })
  } catch (cause) {
    await rename(backup, destination).catch(() => undefined)
    throw cause
  }
}

const generatedSkillRoot = (
  source: SkillSource,
  sourceRoot: string,
  temporary: string,
  skillsCli: string | undefined,
  readOnly: boolean,
  signal: AbortSignal | undefined,
) =>
  source.adapter === SkillAdapter.OmpNative
    ? Promise.resolve(path.join(sourceRoot, ".omp", "skills"))
    : generateGenericSkills(
        source,
        sourceRoot,
        path.join(temporary, `generated-${source.id}`),
        skillsCli,
        readOnly,
        signal,
      )

const selectedSkillNames = async (source: SkillSource, generatedRoot: string) => {
  const entries = await readdir(generatedRoot, { withFileTypes: true }).catch((cause) => {
    fail(`cannot enumerate generated skills: ${source.id}`, cause)
  })
  const actual = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"))
  const expected = [...source.select].sort((left, right) => left.localeCompare(right, "en"))
  if (expected.includes("*")) {
    const missingRequired = (source.required ?? []).find((name) => !actual.includes(name))
    if (missingRequired !== undefined) fail(`required skill is missing from ${source.id}: ${missingRequired}`)
    const excluded = new Set(source.exclude)
    const included = actual.filter((name) => !excluded.has(name))
    if (included.length === 0) fail(`generated skills do not match selections: ${source.id}`)
    return included
  }
  const missing = expected.find((name) => !actual.includes(name))
  if (missing !== undefined) fail(`generated skill is missing from ${source.id}: ${missing}`)
  return expected
}

const materializeSource = async ({
  source,
  temporary,
  snapshotSkills,
  names,
  skillsCli,
  readOnly,
  signal,
}: {
  source: SkillSource
  temporary: string
  snapshotSkills: string
  names: Set<string>
  skillsCli: string | undefined
  readOnly: boolean
  signal: AbortSignal | undefined
}) => {
  const sourceRoot = path.join(temporary, `source-${source.id}`)
  await checkoutLatest(source.repository, sourceRoot, signal, readOnly)
  const generatedRoot = await generatedSkillRoot(source, sourceRoot, temporary, skillsCli, readOnly, signal)
  const actual = await selectedSkillNames(source, generatedRoot)
  let bytes = 0
  const alwaysOn: AlwaysOnSkill[] = []
  for (const name of actual) {
    if (names.has(name)) fail(`duplicate generated skill: ${name}`)
    names.add(name)
    if (names.size > maxSkills) fail(`skill snapshot exceeds ${maxSkills} skills`)
    const validation = await validateSkillDirectory(generatedRoot, name, source.allowExecutables)
    bytes += validation.bytes
    await cp(path.join(generatedRoot, name), path.join(snapshotSkills, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    })
    if (source.alwaysOn) alwaysOn.push({ name, instructions: validation.instructions })
  }
  return { bytes, alwaysOn }
}

export const stageLatest = async ({
  catalog,
  bundleIds,
  destination,
  skillsCli,
  readOnly = false,
  signal,
}: StageOptions) => {
  const plan = resolvePlan(catalog, bundleIds)
  const parent = path.dirname(path.resolve(destination))
  await mkdir(parent, { recursive: true })
  const temporary = await mkdtemp(path.join(parent, ".trellage-floating-skills."))
  const snapshot = path.join(temporary, "snapshot")
  const snapshotSkills = path.join(snapshot, "skills")
  await mkdir(snapshotSkills, { recursive: true })
  const names = new Set<string>()
  const alwaysOn: AlwaysOnSkill[] = []
  let totalBytes = 0
  try {
    for (const source of plan) {
      signal?.throwIfAborted()
      const materialized = await materializeSource({
        source,
        temporary,
        snapshotSkills,
        names,
        skillsCli,
        readOnly,
        signal,
      })
      totalBytes += materialized.bytes
      if (totalBytes > maxSnapshotBytes) fail(`skill snapshot exceeds ${maxSnapshotBytes} bytes`)
      alwaysOn.push(...materialized.alwaysOn)
    }
    const sortedNames = [...names].sort((left, right) => left.localeCompare(right, "en"))
    alwaysOn.sort((left, right) => left.name.localeCompare(right.name, "en"))
    await writeFile(path.join(snapshot, "managed-skills.txt"), sortedNames.map((name) => `${name}\n`).join(""))
    await writeFile(
      path.join(snapshot, "always-on.md"),
      alwaysOn
        .map(({ name, instructions }) => `# Trellage managed always-on skill: ${name}\n\n${instructions}\n`)
        .join(""),
    )
    await publishDirectory(snapshot, path.resolve(destination))
    return sortedNames
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

const readManagedNames = async (file: string, label: string) => {
  const status = await lstat(file).catch(() => undefined)
  if (status === undefined) return []
  if (!status.isFile() || status.isSymbolicLink()) fail(`invalid ${label}: ${file}`)
  const names = (await readFile(file, "utf8")).split("\n").filter(Boolean)
  if (names.some((name) => !safeName.test(name)) || new Set(names).size !== names.length) {
    fail(`invalid ${label}: ${file}`)
  }
  return names
}

const validateSnapshot = async (snapshotPath: string) => {
  const sourceSkills = path.join(snapshotPath, "skills")
  const sourceStatus = await lstat(sourceSkills).catch(() => undefined)
  if (sourceStatus === undefined || !sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    fail(`invalid skill snapshot: ${snapshotPath}`)
  }
  const sourceNames = await readManagedNames(path.join(snapshotPath, "managed-skills.txt"), "snapshot manifest")
  if (sourceNames.length === 0) fail(`skill snapshot is empty: ${snapshotPath}`)
  const sortedNames = [...sourceNames].sort((left, right) => left.localeCompare(right, "en"))
  if (JSON.stringify(sourceNames) !== JSON.stringify(sortedNames)) {
    fail(`skill snapshot manifest is not sorted: ${snapshotPath}`)
  }
  const actualNames = (await readdir(sourceSkills)).sort((left, right) => left.localeCompare(right, "en"))
  if (JSON.stringify(actualNames) !== JSON.stringify(sortedNames)) {
    fail(`skill snapshot does not match its manifest: ${snapshotPath}`)
  }
  for (const name of sourceNames) await validateSkillDirectory(sourceSkills, name, true)
  const alwaysOn = path.join(snapshotPath, "always-on.md")
  const alwaysOnStatus = await lstat(alwaysOn).catch(() => undefined)
  if (alwaysOnStatus === undefined || !alwaysOnStatus.isFile() || alwaysOnStatus.isSymbolicLink()) {
    fail(`invalid skill snapshot instructions: ${snapshotPath}`)
  }
  return sourceNames
}

const readLegacyManagedNames = async (file: string) => {
  const status = await lstat(file).catch(() => undefined)
  if (status === undefined) return []
  if (!status.isFile() || status.isSymbolicLink()) fail(`invalid legacy managed skill manifest: ${file}`)
  const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean)
  if (!/^[0-9a-f]{40}$/.test(lines[0] ?? "")) fail(`invalid legacy managed skill manifest: ${file}`)
  const names = lines.slice(1)
  if (names.some((name) => !safeName.test(name)) || new Set(names).size !== names.length) {
    fail(`invalid legacy managed skill manifest: ${file}`)
  }
  return names
}

const readLegacyOwnedNames = async (targetPath: string) => {
  const marker = path.join(targetPath, "show-me", ".managed-by-trellage-picx-profiles")
  const status = await lstat(marker).catch(() => undefined)
  if (status === undefined) return []
  if (!status.isFile() || status.isSymbolicLink()) fail(`invalid legacy managed skill marker: ${marker}`)
  if ((await readFile(marker, "utf8")) !== "trellage-picx-profile-v2\n") {
    fail(`invalid legacy managed skill marker: ${marker}`)
  }
  const skill = path.dirname(marker)
  const skillStatus = await lstat(skill)
  if (!skillStatus.isDirectory() || skillStatus.isSymbolicLink()) fail(`invalid managed skill target: ${skill}`)
  return ["show-me"]
}

const readTargetManagedNames = async (targetPath: string) => {
  const currentManaged = await readManagedNames(
    path.join(targetPath, ".trellage-managed-skills"),
    "managed skill manifest",
  )
  if (currentManaged.length > 0) return currentManaged
  const legacyManaged = await readLegacyManagedNames(path.join(targetPath, ".trellage-engineersamuel-skills"))
  const legacyOwned = await readLegacyOwnedNames(targetPath)
  return [...new Set([...legacyManaged, ...legacyOwned])]
}

export const verifyRepairableTarget = async (target: string) => {
  const targetPath = path.resolve(target)
  const targetStatus = await lstat(targetPath).catch(() => undefined)
  if (targetStatus === undefined) return []
  if (!targetStatus.isDirectory() || targetStatus.isSymbolicLink()) fail(`invalid skill target: ${targetPath}`)
  const entries = await readdir(targetPath)

  const managed = await readTargetManagedNames(targetPath)
  for (const name of entries) {
    if (name === ".trellage-managed-skills" || name === ".trellage-engineersamuel-skills") continue
    const candidate = path.join(targetPath, name)
    const status = await lstat(candidate)
    if (!status.isDirectory() || status.isSymbolicLink()) {
      fail(`invalid managed skill target: ${candidate}`)
    }
  }
  return managed
}

const removeAbandonedLock = async (directory: string) => {
  await rm(directory, { recursive: true, force: true }).catch((cause) => {
    if (cause?.code !== "ENOENT") throw cause
  })
}

const tryPublishLock = async (directory: string) => {
  const candidate = await mkdtemp(`${directory}.candidate-`)
  await writeFile(path.join(candidate, "pid"), `${process.pid}\n`)
  try {
    await rename(candidate, directory)
    return true
  } catch (cause) {
    await rm(candidate, { recursive: true, force: true })
    if (!isRecord(cause) || (cause.code !== "EEXIST" && cause.code !== "ENOTEMPTY")) throw cause
    return false
  }
}

const inspectExistingLock = async (directory: string) => {
  const status = await lstat(directory).catch(() => undefined)
  if (status === undefined) return "retry"
  if (!status.isDirectory() || status.isSymbolicLink()) fail(`unsafe skill lock: ${directory}`)
  const pidFile = path.join(directory, "pid")
  const pidStatus = await lstat(pidFile).catch(() => undefined)
  if (pidStatus === undefined || !pidStatus.isFile() || pidStatus.isSymbolicLink()) return "abandoned"
  const pidMatch = /^([1-9][0-9]*)\n?$/.exec(await readFile(pidFile, "utf8").catch(() => ""))
  if (pidMatch === null) return "abandoned"
  const pid = Number.parseInt(pidMatch[1] ?? "", 10)
  if (!Number.isSafeInteger(pid)) return "abandoned"
  try {
    process.kill(pid, 0)
    return "active"
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ESRCH") return "abandoned"
    if (isRecord(cause) && cause.code === "EPERM") return "active"
    throw cause
  }
}

const acquireLock = async (directory: string) => {
  for (let attempt = 0; attempt < 3000; attempt += 1) {
    if (await tryPublishLock(directory)) return
    const state = await inspectExistingLock(directory)
    if (state === "retry") continue
    if (state === "abandoned") {
      await removeAbandonedLock(directory)
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  fail(`timed out waiting for skill lock: ${directory}`)
}

const withLock = async <T>(directory: string, operation: () => Promise<T>) => {
  await mkdir(path.dirname(directory), { recursive: true })
  await acquireLock(directory)
  try {
    return await operation()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const assertNoUnmanagedCollisions = async (
  targetPath: string,
  sourceNames: readonly string[],
  managed: readonly string[],
) => {
  const managedSet = new Set(managed)
  for (const name of sourceNames) {
    const candidate = path.join(targetPath, name)
    const status = await lstat(candidate).catch(() => undefined)
    if (status !== undefined && !managedSet.has(name)) fail(`refusing to replace unmanaged skill: ${candidate}`)
  }
}

const makeCopiedDirectoriesWritable = async (directory: string): Promise<void> => {
  const status = await lstat(directory)
  if (!status.isDirectory() || status.isSymbolicLink()) fail(`invalid copied skill directory: ${directory}`)
  // Image snapshots are read-only. Their private copies must support rename,
  // rollback, and later removal without changing the source snapshot.
  await chmod(directory, (status.mode & 0o777) | 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeCopiedDirectoriesWritable(path.join(directory, entry.name))
  }
}

const stageTargetSkills = async (sourceSkills: string, sourceNames: readonly string[], staged: string) => {
  for (const name of sourceNames) {
    await cp(path.join(sourceSkills, name), path.join(staged, name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    })
    await makeCopiedDirectoriesWritable(path.join(staged, name))
  }
}

const backupManagedSkills = async (
  targetPath: string,
  managed: readonly string[],
  backup: string,
  backedUp: string[],
) => {
  for (const name of managed) {
    const candidate = path.join(targetPath, name)
    const status = await lstat(candidate).catch(() => undefined)
    if (status === undefined) continue
    if (!status.isDirectory() || status.isSymbolicLink()) fail(`invalid managed skill target: ${candidate}`)
    await rename(candidate, path.join(backup, name))
    backedUp.push(name)
  }
}

const publishStagedSkills = async (staged: string, targetPath: string, sourceNames: readonly string[]) => {
  const published: string[] = []
  for (const name of sourceNames) {
    await rename(path.join(staged, name), path.join(targetPath, name))
    published.push(name)
  }
  return published
}

const rollbackTargetSkills = async ({
  targetPath,
  backup,
  manifest,
  manifestBackup,
  backedUp,
  published,
}: {
  targetPath: string
  backup: string
  manifest: string
  manifestBackup: string
  backedUp: readonly string[]
  published: readonly string[]
}) => {
  for (const name of published) await rm(path.join(targetPath, name), { recursive: true, force: true })
  for (const name of backedUp) await rename(path.join(backup, name), path.join(targetPath, name))
  await rm(manifest, { force: true })
  if (await lstat(manifestBackup).catch(() => undefined)) await rename(manifestBackup, manifest)
}

const commitTargetSkills = async ({
  targetPath,
  sourceNames,
  managed,
  transaction,
  staged,
  backup,
  manifest,
  legacyManifest,
}: {
  targetPath: string
  sourceNames: readonly string[]
  managed: readonly string[]
  transaction: string
  staged: string
  backup: string
  manifest: string
  legacyManifest: string
}) => {
  const manifestBackup = path.join(transaction, "old-manifest")
  const backedUp: string[] = []
  const published: string[] = []
  try {
    await backupManagedSkills(targetPath, managed, backup, backedUp)
    published.push(...(await publishStagedSkills(staged, targetPath, sourceNames)))
    if (await lstat(manifest).catch(() => undefined)) await rename(manifest, manifestBackup)
    await writeFile(path.join(transaction, "manifest"), sourceNames.map((name) => `${name}\n`).join(""))
    await rename(path.join(transaction, "manifest"), manifest)
    await rm(legacyManifest, { force: true })
  } catch (cause) {
    await rollbackTargetSkills({ targetPath, backup, manifest, manifestBackup, backedUp, published })
    throw cause
  }
}

const syncSnapshotUnlocked = async (sourceSkills: string, sourceNames: readonly string[], targetPath: string) => {
  const manifest = path.join(targetPath, ".trellage-managed-skills")
  const legacyManifest = path.join(targetPath, ".trellage-engineersamuel-skills")
  const managed = await readTargetManagedNames(targetPath)
  await assertNoUnmanagedCollisions(targetPath, sourceNames, managed)
  const transaction = await mkdtemp(path.join(targetPath, ".trellage-floating-skills."))
  const staged = path.join(transaction, "new")
  const backup = path.join(transaction, "old")
  await mkdir(staged)
  await mkdir(backup)
  try {
    await stageTargetSkills(sourceSkills, sourceNames, staged)
    await commitTargetSkills({
      targetPath,
      sourceNames,
      managed,
      transaction,
      staged,
      backup,
      manifest,
      legacyManifest,
    })
    return sourceNames
  } finally {
    await rm(transaction, { recursive: true, force: true })
  }
}

const validateExcludedSkills = (excluded: readonly string[]) => {
  if (!Array.isArray(excluded)) fail("excluded target skills must be a string array")
  if (excluded.length > 0) assertStringArray(excluded, "excluded target skills")
  if (excluded.some((name) => !safeName.test(name))) fail("unsafe excluded target skill")
}

export const selectTargetSkills = (names: readonly string[], excluded: readonly string[] = []) => {
  validateExcludedSkills(excluded)
  const selected = names.filter((name) => !excluded.includes(name))
  if (selected.length === 0) fail("skill target would be empty")
  return selected
}

const verifyExcludedSkills = async (target: string, excluded: readonly string[], removable: readonly string[] = []) => {
  for (const name of excluded) {
    const candidate = path.join(target, name)
    const status = await lstat(candidate).catch((cause) => {
      if (cause.code === "ENOENT") return undefined
      throw cause
    })
    if (status !== undefined && !removable.includes(name)) {
      fail(`excluded skill remains discoverable: ${candidate}`)
    }
  }
}

export const verifyTargetExclusions = async (target: string, excluded: readonly string[] = [], repairable = false) => {
  validateExcludedSkills(excluded)
  const targetPath = path.resolve(target)
  const removable = repairable ? await readTargetManagedNames(targetPath) : []
  await verifyExcludedSkills(targetPath, excluded, removable)
}

export const syncSnapshot = async (snapshot: string, target: string, excluded: readonly string[] = []) => {
  const snapshotPath = path.resolve(snapshot)
  const targetPath = path.resolve(target)
  const sourceSkills = path.join(snapshotPath, "skills")
  const sourceNames = selectTargetSkills(await validateSnapshot(snapshotPath), excluded)
  await mkdir(targetPath, { recursive: true, mode: 0o700 })
  const targetStatus = await lstat(targetPath)
  if (!targetStatus.isDirectory() || targetStatus.isSymbolicLink()) fail(`invalid skill target: ${targetPath}`)
  return withLock(path.join(targetPath, ".trellage-floating-skills.lock"), async () => {
    await verifyExcludedSkills(targetPath, excluded, await readTargetManagedNames(targetPath))
    return syncSnapshotUnlocked(sourceSkills, sourceNames, targetPath)
  })
}

const compareManagedTree = async (source: string, target: string, skillName: string): Promise<void> => {
  const sourceStatus = await lstat(source)
  const targetStatus = await lstat(target).catch(() => undefined)
  if (targetStatus === undefined || sourceStatus.isSymbolicLink() || targetStatus.isSymbolicLink()) {
    fail(`managed skill differs from the current snapshot: ${skillName}`)
  }
  if (sourceStatus.isDirectory()) {
    if (!targetStatus.isDirectory()) fail(`managed skill differs from the current snapshot: ${skillName}`)
    const sourceEntries = (await readdir(source)).sort((left, right) => left.localeCompare(right, "en"))
    const targetEntries = (await readdir(target)).sort((left, right) => left.localeCompare(right, "en"))
    if (JSON.stringify(sourceEntries) !== JSON.stringify(targetEntries)) {
      fail(`managed skill differs from the current snapshot: ${skillName}`)
    }
    for (const entry of sourceEntries) {
      await compareManagedTree(path.join(source, entry), path.join(target, entry), skillName)
    }
    return
  }
  if (!sourceStatus.isFile() || !targetStatus.isFile()) {
    fail(`managed skill differs from the current snapshot: ${skillName}`)
  }
  const [sourceBytes, targetBytes] = await Promise.all([readFile(source), readFile(target)])
  if (!sourceBytes.equals(targetBytes)) fail(`managed skill differs from the current snapshot: ${skillName}`)
}

export const verifyTarget = async (snapshot: string, target: string, excluded: readonly string[] = []) => {
  const snapshotPath = path.resolve(snapshot)
  const targetPath = path.resolve(target)
  const expected = selectTargetSkills(await validateSnapshot(snapshotPath), excluded)
  await verifyExcludedSkills(targetPath, excluded)
  const managed = await readManagedNames(path.join(targetPath, ".trellage-managed-skills"), "managed skill manifest")
  if (JSON.stringify(managed) !== JSON.stringify(expected)) {
    fail(`managed skills differ from the current snapshot: ${targetPath}`)
  }
  for (const name of expected)
    await compareManagedTree(path.join(snapshotPath, "skills", name), path.join(targetPath, name), name)
  return expected
}

const snapshotsMatch = async (left: string, right: string) => {
  const leftPath = path.resolve(left)
  const rightPath = path.resolve(right)
  const [leftNames, rightNames] = await Promise.all([validateSnapshot(leftPath), validateSnapshot(rightPath)])
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) return false
  try {
    for (const name of leftNames) {
      await compareManagedTree(path.join(leftPath, "skills", name), path.join(rightPath, "skills", name), name)
    }
  } catch (cause) {
    if (cause instanceof FloatingSkillsError && cause.message.startsWith("managed skill differs")) return false
    throw cause
  }
  const [leftAlwaysOn, rightAlwaysOn] = await Promise.all([
    readFile(path.join(leftPath, "always-on.md")),
    readFile(path.join(rightPath, "always-on.md")),
  ])
  return leftAlwaysOn.equals(rightAlwaysOn)
}

export const checkNative = ({ catalog, bundleIds, cache, skillsCli }: NativeOptions) =>
  withLock(`${cache}.lock`, async () => {
    const cachePath = path.resolve(cache)
    const cacheStatus = await lstat(cachePath).catch(() => undefined)
    if (cacheStatus === undefined) return false
    if (!cacheStatus.isDirectory() || cacheStatus.isSymbolicLink()) {
      fail(`invalid skill cache: ${cachePath}`)
    }
    const temporary = await mkdtemp(path.join(path.dirname(cachePath), ".trellage-floating-skills-check."))
    const latest = path.join(temporary, "snapshot")
    try {
      await stageLatest({
        catalog,
        bundleIds,
        destination: latest,
        skillsCli,
      })
      return await snapshotsMatch(latest, cachePath)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })

const checkSharedVariant = async (
  catalog: SkillCatalog,
  variant: SharedVariant,
  stage: string,
  signal?: AbortSignal,
): Promise<SkillCheck> => {
  try {
    signal?.throwIfAborted()
    const status = await lstat(variant.cache)
    if (!status.isDirectory() || status.isSymbolicLink()) fail(`invalid skill cache: ${variant.cache}`)
    await validateSnapshot(variant.cache)
    const latest = path.join(stage, variant.name)
    await stageLatest({ catalog, bundleIds: variant.bundles, destination: latest, readOnly: true, signal })
    return { kind: (await snapshotsMatch(latest, variant.cache)) ? SkillCurrency.Current : SkillCurrency.Available }
  } catch (error) {
    return {
      kind: SkillCurrency.Unknown,
      diagnostic: `${variant.name}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export const checkSharedNative = async ({
  catalog,
  variants,
  signal,
  cwd = process.cwd(),
}: {
  catalog: SkillCatalog
  variants: readonly SharedVariant[]
  signal?: AbortSignal | undefined
  cwd?: string
}): Promise<SkillCheck> => {
  const stage = await mkdtemp(path.join(cwd, ".trellage-shared-skills-check."))
  try {
    const results: SkillCheck[] = []
    for (const variant of variants) results.push(await checkSharedVariant(catalog, variant, stage, signal))
    signal?.throwIfAborted()
    const diagnostic = results
      .filter((result) => result.kind === SkillCurrency.Unknown)
      .map((result) => result.diagnostic)
      .join("; ")
    if (results.some((result) => result.kind === SkillCurrency.Available)) {
      return diagnostic ? { kind: SkillCurrency.Available, diagnostic } : { kind: SkillCurrency.Available }
    }
    if (diagnostic) return { kind: SkillCurrency.Unknown, diagnostic }
    if (results.length === 0) return { kind: SkillCurrency.Unknown, diagnostic: "No shared skill caches were checked." }
    return { kind: SkillCurrency.Current }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

const checkSharedCommand = async (catalog: SkillCatalog) => {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("Shared skills check cancelled."))
  const common = path.join(os.homedir(), ".local", "share", "trellage", "common")
  const variants = [
    { name: "native-common", bundles: ["native-common"], cache: defaultCache() },
    {
      name: "codex",
      bundles: ["native-common", "codex-common"],
      cache: path.join(path.dirname(defaultCache()), "cdx-skills"),
    },
    {
      name: "youtube",
      bundles: ["native-common", "codex-common", "youtube"],
      cache: path.join(path.dirname(defaultCache()), "cdx-youtube-pro-skills"),
    },
    { name: "omp-community", bundles: ["omp-community"], cache: path.join(common, "omp-community-skills") },
    {
      name: "guide-prompt-master",
      bundles: ["guide-prompt-master"],
      cache: path.join(common, "guide-prompt-master-skills"),
    },
  ]
  process.once("SIGTERM", abort)
  process.once("SIGINT", abort)
  try {
    process.stdout.write(
      `${JSON.stringify(await checkSharedNative({ catalog, variants, signal: controller.signal }))}\n`,
    )
  } finally {
    process.removeListener("SIGTERM", abort)
    process.removeListener("SIGINT", abort)
  }
}

const optionalLstat = async (file: string) => {
  try {
    return await lstat(file)
  } catch (cause) {
    if (isRecord(cause) && cause.code === "ENOENT") return undefined
    throw cause
  }
}

const bakedManagedNames = async (target: string, expected: readonly string[]) => {
  const targetStatus = await lstat(target)
  if (!targetStatus.isDirectory() || targetStatus.isSymbolicLink()) fail("baked skills are not a regular directory")
  const marker = path.join(target, ".trellage-floating-skills")
  const markerStatus = await optionalLstat(marker)
  const managed =
    markerStatus === undefined ? undefined : await readManagedNames(marker, "baked floating skill manifest")
  if (managed !== undefined && managed.length === 0) fail("baked floating skill manifest is empty")
  if (managed === undefined && !(await readdir(target)).some((name) => expected.includes(name))) {
    fail("installed image has no identifiable managed floating skill snapshot")
  }
  for (const name of managed ?? expected) {
    const status = await optionalLstat(path.join(target, name))
    if (status !== undefined) await validateSkillDirectory(target, name, true)
  }
  return managed
}

const compareBakedInstructions = async (snapshot: string, target: string): Promise<SkillCheck> => {
  const instructions = path.join(target, ".trellage-floating-always-on.md")
  const status = await optionalLstat(instructions)
  if (status === undefined || !status.isFile() || status.isSymbolicLink())
    fail("baked floating instruction evidence is missing or unsafe")
  const current = (await readFile(instructions)).equals(await readFile(path.join(snapshot, "always-on.md")))
  return { kind: current ? SkillCurrency.Current : SkillCurrency.Available }
}

export const compareBakedSkills = async (snapshot: string, target: string): Promise<SkillCheck> => {
  const expected = await validateSnapshot(snapshot)
  const managed = await bakedManagedNames(target, expected)
  if (managed !== undefined && JSON.stringify([...managed].sort()) !== JSON.stringify([...expected].sort())) {
    return { kind: SkillCurrency.Available }
  }
  try {
    for (const name of expected)
      await compareManagedTree(path.join(snapshot, "skills", name), path.join(target, name), name)
  } catch (error) {
    if (error instanceof FloatingSkillsError && error.message.startsWith("managed skill differs"))
      return { kind: SkillCurrency.Available }
    throw error
  }
  if (managed === undefined) {
    const extra = (await readdir(target)).filter((name) => !expected.includes(name))
    if (extra.length > 0)
      return {
        kind: SkillCurrency.Unknown,
        diagnostic: "Older image has additional skills with no floating ownership manifest.",
      }
    return { kind: SkillCurrency.Unknown, diagnostic: "Older image lacks floating ownership and instruction evidence." }
  }
  return compareBakedInstructions(snapshot, target)
}

const checkContainerCommand = async (catalog: SkillCatalog, bundles: readonly string[], options: CommandOptions) => {
  if (options.target === undefined) fail("check-container requires --target")
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("Container skills check cancelled."))
  process.once("SIGTERM", abort)
  process.once("SIGINT", abort)
  let stage
  try {
    stage = await mkdtemp(path.join(options.output ?? process.cwd(), ".trellage-container-skills-check."))
    const snapshot = path.join(stage, "snapshot")
    await stageLatest({
      catalog,
      bundleIds: bundles,
      destination: snapshot,
      skillsCli: options.skills_cli,
      readOnly: true,
      signal: controller.signal,
    })
    controller.signal.throwIfAborted()
    process.stdout.write(`${JSON.stringify(await compareBakedSkills(snapshot, options.target))}\n`)
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true })
    process.removeListener("SIGTERM", abort)
    process.removeListener("SIGINT", abort)
  }
}

const defaultCatalogPath = async () => {
  for (const candidate of [
    path.join(scriptDirectory, "skills.json"),
    path.join(scriptDirectory, "..", "skills.json"),
  ]) {
    try {
      const status = await lstat(candidate)
      if (status.isFile() && !status.isSymbolicLink()) return candidate
    } catch {
      // Continue to the repository layout.
    }
  }
  fail("cannot locate skills.json")
}

const defaultCache = () =>
  path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "trellage", "common", "skills")

const valueOptionKey = (
  argument: string | undefined,
): keyof Omit<CommandOptions, "bundles" | "excluded"> | undefined => {
  switch (argument) {
    case "--catalog":
      return "catalog"
    case "--output":
      return "output"
    case "--target":
      return "target"
    case "--cache":
      return "cache"
    case "--skills-cli":
      return "skills_cli"
    default:
      return undefined
  }
}

const parseArguments = (arguments_: readonly string[]) => {
  const command = arguments_[0]
  const options: CommandOptions = { bundles: [], excluded: [] }
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    const value = arguments_[index + 1]
    const valueKey = valueOptionKey(argument)
    if (argument === "--bundle" && value !== undefined) {
      options.bundles.push(value)
      index += 1
    } else if (argument === "--exclude-skill" && value !== undefined) {
      options.excluded.push(value)
      index += 1
    } else if (valueKey !== undefined && value !== undefined) {
      options[valueKey] = value
      index += 1
    } else {
      fail(
        "usage: floating-skills.ts <stage|ensure|check|update|status|sync|verify|verify-repairable> [--bundle NAME] [--catalog FILE] [--output DIR] [--target DIR] [--cache DIR] [--skills-cli FILE] [--exclude-skill NAME]",
      )
    }
  }
  return { command, options }
}

const stageCommand = async (catalog: SkillCatalog, bundles: readonly string[], options: CommandOptions) => {
  if (options.output === undefined) fail("stage requires --output")
  const names = await stageLatest({
    catalog,
    bundleIds: bundles,
    destination: options.output,
    skillsCli: options.skills_cli,
  })
  process.stdout.write(`${names.join("\n")}${names.length === 0 ? "" : "\n"}`)
}

const syncCommand = async (options: CommandOptions) => {
  if (options.output === undefined || options.target === undefined) fail("sync requires --output and --target")
  await syncSnapshot(options.output, options.target, options.excluded)
}

const ensureCommand = async (
  catalog: SkillCatalog,
  bundles: readonly string[],
  cache: string,
  options: CommandOptions,
) => {
  if (options.target === undefined) fail("ensure requires --target")
  await ensureNative({
    catalog,
    bundleIds: bundles,
    cache,
    target: options.target,
    skillsCli: options.skills_cli,
  })
}

export const ensureNative = async ({
  catalog,
  bundleIds,
  cache,
  target,
  skillsCli,
}: NativeOptions & { target: string }) => {
  await withLock(`${cache}.lock`, async () => {
    const status = await lstat(cache).catch(() => undefined)
    if (status === undefined) {
      await stageLatest({
        catalog,
        bundleIds,
        destination: cache,
        skillsCli,
      })
    } else if (!status.isDirectory() || status.isSymbolicLink()) {
      fail(`invalid skill cache: ${cache}`)
    }
  })
  await syncSnapshot(cache, target)
}

export const updateNative = ({ catalog, bundleIds, cache, skillsCli }: NativeOptions) =>
  withLock(`${cache}.lock`, () =>
    stageLatest({
      catalog,
      bundleIds,
      destination: cache,
      skillsCli,
    }),
  )

const updateCommand = (catalog: SkillCatalog, bundles: readonly string[], cache: string, options: CommandOptions) =>
  updateNative({
    catalog,
    bundleIds: bundles,
    cache,
    skillsCli: options.skills_cli,
  })

const checkCommand = async (
  catalog: SkillCatalog,
  bundles: readonly string[],
  cache: string,
  options: CommandOptions,
) => {
  const current = await checkNative({
    catalog,
    bundleIds: bundles,
    cache,
    skillsCli: options.skills_cli,
  })
  process.stdout.write(current ? "current\n" : "update available\n")
  if (!current) process.exitCode = 10
}

const statusCommand = async (bundles: readonly string[], cache: string) => {
  const names = await readManagedNames(path.join(cache, "managed-skills.txt"), "snapshot manifest")
  process.stdout.write(`${JSON.stringify({ bundles, installed: names.length > 0, skills: names })}\n`)
}

const verifyCommand = async (cache: string, options: CommandOptions) => {
  if (options.target === undefined) fail("verify requires --target")
  await verifyTarget(cache, options.target, options.excluded)
}

const verifyRepairableCommand = async (options: CommandOptions) => {
  if (options.target === undefined) fail("verify-repairable requires --target")
  await verifyRepairableTarget(options.target)
}

const dispatch = (
  command: string | undefined,
  catalog: SkillCatalog,
  bundles: readonly string[],
  cache: string,
  options: CommandOptions,
) => {
  if (command === "check-container") return checkContainerCommand(catalog, bundles, options)
  if (command === "check-shared") return checkSharedCommand(catalog)
  if (command === "stage") return stageCommand(catalog, bundles, options)
  if (command === "sync") return syncCommand(options)
  if (command === "ensure") return ensureCommand(catalog, bundles, cache, options)
  if (command === "check") return checkCommand(catalog, bundles, cache, options)
  if (command === "update") return updateCommand(catalog, bundles, cache, options)
  if (command === "status") return statusCommand(bundles, cache)
  if (command === "verify") return verifyCommand(cache, options)
  if (command === "verify-repairable") return verifyRepairableCommand(options)
  fail("usage: floating-skills.ts <stage|ensure|check|update|status|sync|verify|verify-repairable>")
}

const main = async () => {
  const { command, options } = parseArguments(process.argv.slice(2))
  const catalogPath = path.resolve(options.catalog ?? (await defaultCatalogPath()))
  const catalog = await readCatalog(catalogPath)
  const bundles = options.bundles.length > 0 ? options.bundles : ["native-common"]
  const cache = path.resolve(options.cache ?? defaultCache())
  await dispatch(command, catalog, bundles, cache, options)
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`floating-skills: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
