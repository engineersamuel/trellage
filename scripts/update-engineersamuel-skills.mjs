#!/usr/bin/env node

import { execFile } from "node:child_process"
import { cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)
const repository = "https://github.com/engineersamuel/skills.git"
const refPattern = /^[0-9a-f]{40}$/
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const vendor = path.join(root, "vendor", "engineersamuel-skills")

const run = async (command, arguments_) =>
  execFilePromise(command, arguments_, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })

const collectSkillRoots = async (checkout) => {
  const roots = []
  for (const parent of ["skills", ".agents/skills"]) {
    const directory = path.join(checkout, parent)
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const skill = path.join(directory, entry.name)
      await readFile(path.join(skill, "SKILL.md"), "utf8")
      roots.push({ name: entry.name, path: skill })
    }
  }
  roots.sort((left, right) => left.name.localeCompare(right.name))
  if (roots.length === 0) throw new Error("upstream repository contains no skills")
  if (new Set(roots.map(({ name }) => name)).size !== roots.length) {
    throw new Error("upstream repository contains duplicate skill names")
  }
  return roots
}

const replaceRef = async (file, pattern, ref) => {
  const source = await readFile(file, "utf8")
  const matches = [...source.matchAll(pattern)]
  if (matches.length === 0) throw new Error(`personal skill ref marker is missing: ${path.relative(root, file)}`)
  const updated = source.replace(pattern, `$1${ref}$2`)
  if (updated !== source) await writeFile(file, updated)
}

const updateRefMarkers = async (ref, skillNames) => {
  const profileFiles = []
  for (const directory of await readdir(path.join(root, "profiles"), { withFileTypes: true })) {
    if (directory.isDirectory()) profileFiles.push(path.join(root, "profiles", directory.name, "profile.toml"))
  }
  for (const profile of profileFiles) {
    await replaceRef(
      profile,
      /(repository = "https:\/\/github\.com\/engineersamuel\/skills\.git"\nref = ")[0-9a-f]{40}(")/g,
      ref,
    )
    const source = await readFile(profile, "utf8")
    const select = `select = [${skillNames.map((name) => JSON.stringify(name)).join(", ")}]`
    const pattern =
      /(repository = "https:\/\/github\.com\/engineersamuel\/skills\.git"\nref = "[0-9a-f]{40}"\n)select = \[[^\n]*\]/
    if (!pattern.test(source)) {
      throw new Error(`personal skill selection marker is missing: ${path.relative(root, profile)}`)
    }
    const updated = source.replace(pattern, `$1${select}`)
    if (updated !== source) await writeFile(profile, updated)
  }

  const launcherFiles = []
  for (const directory of await readdir(path.join(root, "prototypes"), { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^trellage-.*-profiles$/.test(directory.name)) continue
    const binDirectory = path.join(root, "prototypes", directory.name, "bin")
    for (const entry of await readdir(binDirectory, { withFileTypes: true })) {
      if (entry.isFile()) launcherFiles.push(path.join(binDirectory, entry.name))
    }
  }
  for (const launcher of launcherFiles) {
    await replaceRef(
      launcher,
      /(readonly engineersamuel_skills_ref=')[0-9a-f]{40}(')/g,
      ref,
    )
  }
}

const publishVendor = async (checkout, ref) => {
  const roots = await collectSkillRoots(checkout)
  await mkdir(path.dirname(vendor), { recursive: true })
  const stage = await mkdtemp(path.join(path.dirname(vendor), ".engineersamuel-skills."))
  const backup = `${stage}.old`
  try {
    for (const skill of roots) {
      await cp(skill.path, path.join(stage, skill.name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      })
    }
    await writeFile(path.join(stage, "REF"), `${ref}\n`)
    await rename(vendor, backup).catch((error) => {
      if (error?.code !== "ENOENT") throw error
    })
    await rename(stage, vendor)
    await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rename(backup, vendor).catch(() => undefined)
    throw error
  } finally {
    await rm(stage, { recursive: true, force: true })
    await rm(backup, { recursive: true, force: true })
  }
  return roots.map(({ name }) => name)
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "trellage-engineersamuel-skills."))
try {
  await run("git", ["init", "-q", temporary])
  await run("git", ["-C", temporary, "remote", "add", "origin", repository])
  await run("git", ["-C", temporary, "fetch", "--depth", "1", "origin", "main"])
  await run("git", ["-C", temporary, "checkout", "--detach", "FETCH_HEAD"])
  const ref = (await run("git", ["-C", temporary, "rev-parse", "HEAD"])).stdout.trim()
  if (!refPattern.test(ref)) throw new Error(`invalid upstream ref: ${ref}`)
  const skillNames = await publishVendor(temporary, ref)
  await updateRefMarkers(ref, skillNames)
  process.stdout.write(`${ref}\n`)
} catch (error) {
  console.error(`update-engineersamuel-skills: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await rm(temporary, { recursive: true, force: true })
}
