#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  checkFreshSkills,
  requireDirectory,
  requireFile,
  statusIfPresent,
  syncCachedSkills,
} from "./native-skills.mjs"

const fail = (message) => {
  throw new Error(message)
}

const requireTargetParent = async (target) => {
  await requireDirectory(path.dirname(target), "profile directory")
  const status = await statusIfPresent(target)
  if (status !== undefined) await requireDirectory(target, "profile skills directory")
}

const loadManualSkillsManager = async ({
  managerPath, catalogPath, cache, library, target, skill, command,
}) => {
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
  const resolvedManager = path.resolve(managerPath)
  await requireFile(resolvedManager)
  if ((await realpath(resolvedManager)) !== resolvedManager) fail(`unsafe skills manager: ${managerPath}`)
  await requireTargetParent(library)
  await requireTargetParent(target)
  const manager = await import(pathToFileURL(resolvedManager).href)
  if (typeof manager.selectTargetSkills !== "function") {
    fail("refresh the floating-skills runtime to enable manual skill isolation")
  }
  return manager
}

const publishManualSkills = async (manager, {
  managerPath, catalogPath, cache, library, target, skill, command,
}) => {
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
    const pairs = [[cache, target, [skill]]]
    if (await statusIfPresent(library)) pairs.push([cache, library])
    await syncCachedSkills(managerPath, pairs, true)
    await manager.syncSnapshot(cache, library)
  }
  await manager.syncSnapshot(cache, target, [skill])
}

const readManualPrompt = async (library, skill) => {
  const file = path.join(library, skill, "SKILL.md")
  const status = await statusIfPresent(file)
  if (status === undefined) {
    fail(`manual skill ${skill} is not cached; run trx skills update, then the profile skills-update command`)
  }
  await requireFile(file)
  return readFile(file, "utf8")
}

export const manageManualSkill = async (options) => {
  const { managerPath, catalogPath, cache, library, target, skill, command, signal } = options
  const manager = await loadManualSkillsManager(options)
  const pairs = [[cache, library], [cache, target, [skill]]]
  if (command === "fresh") return checkFreshSkills(managerPath, catalogPath, pairs, signal)
  if (command === "ensure" || command === "sync") await publishManualSkills(manager, options)
  await manager.verifyTarget(cache, library)
  await manager.verifyTarget(cache, target, [skill])
  if (command === "prompt") return readManualPrompt(library, skill)
}

const main = async (args) => {
  if (args.length !== 7) {
    fail("usage: manual-skills.mjs MANAGER ensure|sync|verify|fresh|prompt CATALOG CACHE LIBRARY TARGET SKILL")
  }
  const [managerPath, command, catalogPath, cache, library, target, skill] = args
  const options = { managerPath, catalogPath, cache, library, target, skill, command }
  if (command !== "fresh") {
    const result = await manageManualSkill(options)
    if (command === "prompt") process.stdout.write(result)
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

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`manual skills: ${error.message}\n`)
    process.exitCode = 1
  })
}
