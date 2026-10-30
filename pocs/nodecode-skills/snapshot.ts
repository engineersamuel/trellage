// Standalone spike: consumes the canonical composition plan, never parses skill policy.
// This is an artifact publisher, NOT a production Nodecode loader or sandbox.
import { createHash, randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CompositionPlan } from "../../packages/trellage-runtime/src/native-run/compose.ts"
import { digestDirectory } from "../../packages/trellage-runtime/src/native-run/source.ts"

export interface Entry {
  name: string
  sourceId: string
  commit: string
  digest: string
  manualOnly: boolean
  alwaysOn: boolean
  directory: string
}

export interface Manifest {
  schema: 1
  compositionId: string
  profiles: readonly string[]
  alwaysProfiles: readonly string[]
  sources: {
    sourceId: string
    repository: string
    selector: unknown
    commit: string
    digest: string
  }[]
  skills: Entry[]
  instructions: readonly { readonly id: string; readonly text: string }[]
}

// Only generated string literals and fixed syntax enter Lisp. Skill prose is data.
const lispString = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const safeName = (name: string): string => {
  if (!identifier.test(name)) throw new Error(`Unsafe managed name: ${name}`)
  return name
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

export const manifestFor = (plan: CompositionPlan): Manifest => {
  if (plan.harness !== "nodecode") throw new Error("Nodecode plans only")
  if (plan.plugins.length) throw new Error("Upstream plugins are not supported by this spike")
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
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length) throw new Error("Duplicate skill name")
  return {
    schema: 1,
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

/** Retain snapshots for in-flight readers. No GC is attempted without session leases. */
export const publishSnapshot = async (
  owner: string,
  plan: CompositionPlan,
  options: { beforePublish?: () => Promise<void> } = {},
): Promise<{ directory: string; manifest: Manifest; id: string }> => {
  const manifest = manifestFor(plan)
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`
  const id = createHash("sha256").update(serialized).digest("hex")
  const root = path.join(owner, "managed", "nodecode-skills")
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lock = path.join(root, ".publish-lock")
  // Fail closed rather than stealing a lock: stale-lock recovery is intentionally out of scope.
  await mkdir(lock, { mode: 0o700 })
  const stage = path.join(root, `.stage-${randomUUID()}`)
  const pointer = path.join(root, `.current-${randomUUID()}`)
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
      await cp(skill.directory, destination, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
      })
      if ((await digestDirectory(destination)) !== entry.digest)
        throw new Error(`Copied digest mismatch: ${entry.name}`)
      if (!(await lstat(path.join(destination, "SKILL.md"))).isFile()) throw new Error("Missing SKILL.md")
    }
    await writeFile(path.join(stage, "manifest.json"), serialized, { mode: 0o600 })
    // Native data-only knowledge cell; only this subdirectory is registered in cells/.
    // Never link the whole snapshot: private manual content must stay undiscoverable.
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
      // Fixed safe symbol names avoid reader syntax injection and user-skill collisions.
      await writeFile(
        path.join(knowledge, `${entry.name}.lisp`),
        `(define-skill trellage-${entry.name} "Selected Trellage skill: ${entry.name}" ${lispString(guidance)})\n`,
        { mode: 0o600 },
      )
    }
    await writeFile(
      path.join(stage, "ordinary.json"),
      `${JSON.stringify(manifest.skills.filter((skill) => !skill.manualOnly))}\n`,
      { mode: 0o600 },
    )
    await writeFile(
      path.join(stage, "instructions.md"),
      `${plan.instructions.map((entry) => entry.text).join("\n\n")}\n`,
      { mode: 0o600 },
    )
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
    if (await exists(directory)) {
      if ((await digestDirectory(directory)) !== (await digestDirectory(stage)))
        throw new Error("Existing snapshot has been modified")
    } else await rename(stage, directory)
    await options.beforePublish?.()
    await symlink(path.relative(root, directory), pointer)
    await rename(pointer, path.join(root, "current"))
    return { directory: await realpath(directory), manifest, id }
  } finally {
    await rm(pointer, { force: true })
    await rm(stage, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

/** Pin once per launch; never chase a mutable `current` path during a session. */
export const currentSnapshot = (owner: string): Promise<string> =>
  realpath(path.join(owner, "managed", "nodecode-skills", "current"))

/** Explicit dispatch resolver, not an authorization boundary against host-authority Lisp. */
export const resolveAsset = async (snapshot: string, name: string, relative: string): Promise<string> => {
  safeName(name)
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Error("Unsafe asset path")
  const manifest: Manifest = JSON.parse(await readFile(path.join(snapshot, "manifest.json"), "utf8"))
  const entry = manifest.skills.find((skill) => skill.name === name)
  if (!entry || entry.directory !== `${entry.manualOnly ? "private" : "ordinary"}/${name}`)
    throw new Error("Unknown or invalid managed skill")
  const root = await realpath(path.join(snapshot, entry.directory))
  const resolved = await realpath(path.join(root, relative))
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Asset escapes selected skill")
  return resolved
}
