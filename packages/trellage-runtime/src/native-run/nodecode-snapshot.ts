import { createHash, randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CompositionPlan } from "./compose.ts"
import { digestDirectory } from "./source.ts"

export interface NodecodeSkillEntry {
  readonly name: string
  readonly sourceId: string
  readonly commit: string
  readonly digest: string
  readonly manualOnly: boolean
  readonly alwaysOn: boolean
  readonly directory: string
}

export interface NodecodeSnapshotManifest {
  readonly schema: 1
  /** Includes both the publisher and Trellage-owned command source. */
  readonly generator: string
  readonly compositionId: string
  readonly profiles: readonly string[]
  readonly alwaysProfiles: readonly string[]
  readonly sources: readonly {
    readonly sourceId: string
    readonly repository: string
    readonly selector: unknown
    readonly commit: string
    readonly digest: string
  }[]
  readonly skills: readonly NodecodeSkillEntry[]
  readonly instructions: CompositionPlan["instructions"]
}

export interface NodecodeSnapshot {
  readonly directory: string
  readonly id: string
  readonly manifest: NodecodeSnapshotManifest
}

// Only fixed syntax and escaped string literals enter Lisp; upstream prose is data.
const lispString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
const safeName = (name: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Unsafe managed skill name: ${name}`)
  return name
}

export const nodecodeManifestFor = (plan: CompositionPlan, generator: string): NodecodeSnapshotManifest => {
  if (plan.harness !== "nodecode") throw new Error("Nodecode plans only")
  if (plan.plugins.length) throw new Error("Nodecode does not install upstream plugins")
  const skills = [...plan.skills]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((skill) => {
      // Defense in depth for the mandatory manual-only common skill.
      const manualOnly = skill.manualOnly === true || skill.name === "i-have-adhd"
      if (manualOnly && skill.alwaysOn) throw new Error(`Conflicting invocation policy: ${skill.name}`)
      return {
        name: safeName(skill.name),
        sourceId: skill.sourceId,
        commit: skill.commit,
        digest: skill.digest,
        manualOnly,
        alwaysOn: skill.alwaysOn === true,
        directory: `${manualOnly ? "private" : "ordinary"}/${skill.name}`,
      }
    })
  // The Common Lisp reader folds symbol names to uppercase.
  if (new Set(skills.map((skill) => skill.name.toLowerCase())).size !== skills.length)
    throw new Error("Duplicate Nodecode skill name (case-insensitive)")
  return {
    schema: 1,
    generator,
    compositionId: plan.compositionId,
    profiles: plan.profiles,
    alwaysProfiles: plan.alwaysProfiles,
    sources: plan.sources.map(({ sourceId, repository, selector, commit, digest }) => ({
      sourceId,
      repository,
      selector,
      commit,
      digest,
    })),
    skills,
    instructions: plan.instructions,
  }
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/**
 * Build a complete immutable-by-convention snapshot without activating it.
 * The caller holds the composition launch guard. Snapshots are retained: old
 * conversations may still refer to their assets, even after generation pruning.
 */
export const buildNodecodeSnapshot = async (ownerHome: string, plan: CompositionPlan): Promise<NodecodeSnapshot> => {
  const [publisher, bridge] = await Promise.all([
    readFile(new URL("./nodecode-snapshot.ts", import.meta.url)),
    readFile(new URL("./nodecode-manual.lisp", import.meta.url), "utf8"),
  ])
  const generator = createHash("sha256").update(publisher).update("\0").update(bridge).digest("hex")
  const manifest = nodecodeManifestFor(plan, generator)
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  const id = createHash("sha256").update(serialized).digest("hex")
  const root = path.join(await realpath(ownerHome), "managed", "nodecode-skills")
  await mkdir(path.join(root, "snapshots"), { recursive: true, mode: 0o700 })
  const stage = path.join(root, `.stage-${randomUUID()}`)
  const directory = path.join(root, "snapshots", id)
  try {
    await mkdir(stage, { mode: 0o700 })
    for (const entry of manifest.skills) {
      const skill = plan.skills.find((candidate) => candidate.name === entry.name)!
      if (!(await lstat(skill.directory)).isDirectory()) throw new Error("Skill root must be a real directory")
      if ((await digestDirectory(skill.directory)) !== entry.digest)
        throw new Error(`Source digest mismatch: ${entry.name}`)
      const destination = path.join(stage, entry.directory)
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await cp(skill.directory, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true })
      if ((await digestDirectory(destination)) !== entry.digest)
        throw new Error(`Copied digest mismatch: ${entry.name}`)
      if (!(await lstat(path.join(destination, "SKILL.md"))).isFile()) throw new Error("Missing SKILL.md")
    }
    await writeFile(path.join(stage, "manifest.json"), serialized, { mode: 0o600 })
    // Register only this subdirectory as knowledge, never the whole snapshot.
    const knowledge = path.join(stage, "trellage-knowledge")
    await mkdir(knowledge, { mode: 0o700 })
    await writeFile(
      path.join(knowledge, "trellage-knowledge.asd"),
      '(defsystem "trellage-knowledge" :class nodecode.kernel:layer :depends-on ("nodecode") :properties ((:knowledge . t)) :components ())\n',
      { mode: 0o600 },
    )
    for (const entry of manifest.skills.filter((skill) => !skill.manualOnly)) {
      const body = await readFile(path.join(stage, entry.directory, "SKILL.md"), "utf8")
      const guidance = `${body}\n\nManaged asset directory: ${path.join(directory, entry.directory)}\nTreat relative assets as paths beneath that directory.\n`
      await writeFile(
        path.join(knowledge, `${entry.name}.lisp`),
        `(define-skill trellage-${entry.name} "Selected Trellage skill: ${entry.name}" ${lispString(guidance)})\n`,
        { mode: 0o600 },
      )
    }
    const manual = path.join(stage, "nodecode-trellage-manual")
    await mkdir(manual, { mode: 0o700 })
    await writeFile(
      path.join(manual, "nodecode-trellage-manual.asd"),
      '(defsystem "nodecode-trellage-manual" :depends-on ("nodecode") :serial t :components ((:file "snapshot") (:file "cell")))\n',
      { mode: 0o600 },
    )
    await writeFile(
      path.join(manual, "snapshot.lisp"),
      `(defpackage #:nodecode-trellage-manual (:use #:cl))\n(in-package #:nodecode-trellage-manual)\n(defparameter *snapshot-directory* ${lispString(`${directory}/`)})\n`,
      { mode: 0o600 },
    )
    await writeFile(path.join(manual, "cell.lisp"), bridge, { mode: 0o600 })
    // planComposition already includes alwaysOn prose. Add asset locations, not
    // another policy parser or duplicate skill body.
    const instructions = [
      ...plan.instructions.map((entry) => entry.text),
      ...manifest.skills
        .filter((entry) => entry.alwaysOn)
        .map(
          (entry) =>
            `Managed assets for always-on skill ${entry.name}: ${path.join(directory, entry.directory)}\nResolve its relative asset paths beneath this directory.`,
        ),
    ].join("\n\n")
    await writeFile(path.join(stage, "instructions.md"), instructions ? `${instructions}\n` : "", { mode: 0o600 })
    if (await exists(directory)) {
      if (!(await lstat(directory)).isDirectory()) throw new Error("Snapshot must be a real directory")
      if ((await digestDirectory(directory)) !== (await digestDirectory(stage)))
        throw new Error("Existing Nodecode snapshot has been modified")
    } else await rename(stage, directory)
    return { directory, manifest, id }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}
