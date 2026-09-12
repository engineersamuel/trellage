#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  checkFreshSkills,
  loadSkillsManager,
  requireDirectory,
  requireFile,
  statusIfPresent,
  syncCachedSkills,
  type FloatingSkillsManager,
  type SkillPair,
} from "./native-skills.ts"

interface ManualSkillOptions {
  readonly managerPath: string
  readonly catalogPath: string
  readonly cache: string
  readonly library: string
  readonly target: string
  readonly skill: string
  readonly command: string
  readonly signal?: AbortSignal | undefined
}

function fail(message: string): never {
  throw new Error(message)
}

const requireTargetParent = async (target: string) => {
  await requireDirectory(path.dirname(target), "profile directory")
  const status = await statusIfPresent(target)
  if (status !== undefined) await requireDirectory(target, "profile skills directory")
}

const loadManualSkillsManager = async ({
  managerPath,
  catalogPath,
  cache,
  library,
  target,
  skill,
  command,
}: ManualSkillOptions) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skill)) fail(`invalid manual skill: ${skill}`)
  if (!["ensure", "sync", "verify", "fresh", "prompt"].includes(command)) {
    fail(`unknown manual skills command: ${command}`)
  }
  for (const candidate of [managerPath, catalogPath, cache, library, target]) {
    if (!path.isAbsolute(candidate)) fail(`manual skills path must be absolute: ${candidate}`)
  }
  const profileHome = path.dirname(path.resolve(target))
  const libraryPath = path.resolve(library)
  if (libraryPath === profileHome || libraryPath.startsWith(`${profileHome}${path.sep}`)) {
    fail("manual skill library must be outside the harness home")
  }
  if (profileHome.startsWith(`${libraryPath}${path.sep}`)) {
    fail("manual skill library must not contain the harness home")
  }
  const manager = await loadSkillsManager(managerPath)
  await requireTargetParent(library)
  await requireTargetParent(target)
  if (typeof manager.selectTargetSkills !== "function") {
    fail("refresh the floating-skills runtime to enable manual skill isolation")
  }
  return manager
}

const publishManualSkills = async (
  manager: FloatingSkillsManager,
  { managerPath, catalogPath, cache, library, target, skill, command }: ManualSkillOptions,
) => {
  await manager.verifyTargetExclusions(target, [skill], true)
  if (command === "ensure") {
    await requireFile(catalogPath)
    await manager.ensureNative({
      catalog: await manager.readCatalog(catalogPath),
      bundleIds: ["native-common"],
      cache,
      target: library,
    })
  } else {
    const pairs: SkillPair[] = [[cache, target, [skill]]]
    if (await statusIfPresent(library)) pairs.push([cache, library])
    await syncCachedSkills(managerPath, pairs, true)
    await manager.syncSnapshot(cache, library)
  }
  await manager.syncSnapshot(cache, target, [skill])
}

const readManualPrompt = async (library: string, skill: string) => {
  const file = path.join(library, skill, "SKILL.md")
  const status = await statusIfPresent(file)
  if (status === undefined) {
    fail(`manual skill ${skill} is not cached; run trx skills update, then the profile skills-update command`)
  }
  await requireFile(file)
  return readFile(file, "utf8")
}

export const manageManualSkill = async (options: ManualSkillOptions) => {
  const { managerPath, catalogPath, cache, library, target, skill, command, signal } = options
  const manager = await loadManualSkillsManager(options)
  const pairs: SkillPair[] = [
    [cache, library],
    [cache, target, [skill]],
  ]
  if (command === "fresh") return checkFreshSkills(managerPath, catalogPath, pairs, signal)
  if (command === "ensure" || command === "sync") await publishManualSkills(manager, options)
  await manager.verifyTarget(cache, library)
  await manager.verifyTarget(cache, target, [skill])
  if (command === "prompt") return readManualPrompt(library, skill)
}

const main = async (args: readonly string[]) => {
  if (args.length !== 7) {
    fail("usage: manual-skills.ts MANAGER ensure|sync|verify|fresh|prompt CATALOG CACHE LIBRARY TARGET SKILL")
  }
  const [managerPath, command, catalogPath, cache, library, target, skill] = args
  if (
    managerPath === undefined ||
    command === undefined ||
    catalogPath === undefined ||
    cache === undefined ||
    library === undefined ||
    target === undefined ||
    skill === undefined
  ) {
    fail("manual skills requires manager, command, catalog, cache, library, target and skill")
  }
  const options = { managerPath, catalogPath, cache, library, target, skill, command }
  if (command !== "fresh") {
    const result = await manageManualSkill(options)
    if (command === "prompt") {
      if (typeof result !== "string") fail("manual skill prompt is missing")
      process.stdout.write(result)
    }
    return
  }
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("Skills check cancelled."))
  process.once("SIGTERM", abort)
  process.once("SIGINT", abort)
  try {
    const result = await manageManualSkill({ ...options, signal: controller.signal })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    process.removeListener("SIGTERM", abort)
    process.removeListener("SIGINT", abort)
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`manual skills: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
