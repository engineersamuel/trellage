import { createHash } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { NativeCatalog } from "../native-config.ts"
import { NativeRunError, type NativeRunPaths } from "./paths.ts"
import { digestDirectory, type ResolvedSource, type SourceResolver } from "./source.ts"

export const COMPOSITION_SCHEMA = 1

export interface SelectedSkill {
  readonly name: string
  readonly sourceId: string
  readonly commit: string
  readonly digest: string
  /** Absolute path of the skill inside the verified source cache. */
  readonly directory: string
  readonly alwaysOn?: boolean
  readonly manualOnly?: boolean
}

export interface CompositionRequest {
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly catalog: NativeCatalog
  /** Adapter-scoped policy identity: changes here invalidate generations. */
  readonly adapterPolicy: string
  readonly providerPolicy: string
  /** Instruction id to Markdown body, loaded by the caller from the config directory. */
  readonly instructionTexts?: Readonly<Record<string, string>>
  /** Skip profiles marked always = true. */
  readonly skipAlways?: boolean
}

export interface CompositionPlan {
  readonly compositionId: string
  readonly harness: string
  /** Profiles the user selected; always-on profiles are listed separately. */
  readonly profiles: ReadonlyArray<string>
  readonly alwaysProfiles: ReadonlyArray<string>
  readonly instructions: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly skills: ReadonlyArray<SelectedSkill>
  readonly sources: ReadonlyArray<ResolvedSource>
  readonly warnings: ReadonlyArray<string>
  readonly generationId: string
}

export const normalizeProfiles = (profiles: ReadonlyArray<string>): string[] => [...new Set(profiles)].sort()

export const compositionIdOf = (harness: string, profiles: ReadonlyArray<string>): string =>
  `${harness}-${createHash("sha256")
    .update(JSON.stringify([COMPOSITION_SCHEMA, harness, normalizeProfiles(profiles)]))
    .digest("hex")
    .slice(0, 12)}`

const searchRoots = ["skills", "", ".claude/skills", ".agents/skills", ".codex/skills", ".github/skills"]
const ignored = new Set([".git", "node_modules", ".trellage-receipt"])

const hasSkill = async (directory: string): Promise<boolean> => {
  try {
    return (await lstat(path.join(directory, "SKILL.md"))).isFile()
  } catch {
    return false
  }
}

const frontmatterName = async (directory: string): Promise<string | undefined> => {
  const text = await readFile(path.join(directory, "SKILL.md"), "utf8")
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const line = match?.[1]?.split(/\r?\n/).find((entry) => entry.startsWith("name:"))
  return line
    ?.slice(5)
    .trim()
    .replace(/^["']|["']$/g, "")
}

/** Find the directory of one named skill inside a source checkout. */
export const findSkill = async (root: string, name: string): Promise<string | null> => {
  for (const base of searchRoots) {
    const candidate = path.join(root, base, name)
    if (await hasSkill(candidate)) return candidate
  }
  if ((await hasSkill(root)) && (await frontmatterName(root)) === name) return root
  const matches: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignored.has(entry.name)) continue
      const child = path.join(directory, entry.name)
      if ((await hasSkill(child)) && (entry.name === name || (await frontmatterName(child)) === name))
        matches.push(child)
      else await walk(child, depth + 1)
    }
  }
  await walk(root, 0)
  if (matches.length > 1)
    throw new NativeRunError(
      "conflict",
      `skill ${name} is ambiguous in its source (${matches.map((match) => path.relative(root, match)).join(", ")})`,
    )
  return matches[0] ?? null
}

export const discoverSkillNames = async (root: string): Promise<string[]> => {
  const names = new Set<string>()
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 6) return
    if (await hasSkill(directory)) {
      const name = (await frontmatterName(directory)) ?? path.basename(directory)
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
        throw new NativeRunError("config", `invalid discovered skill name: ${name}`)
      names.add(name)
      return
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignored.has(entry.name)) await walk(path.join(directory, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return [...names].sort()
}

const validateExecutablePolicy = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name)
    const info = await lstat(candidate)
    if (info.isFile() && info.mode & 0o111)
      throw new NativeRunError("unsafe-path", `skill contains an executable without allowExecutables: ${candidate}`)
    if (entry.isDirectory()) await validateExecutablePolicy(candidate)
  }
}

export interface PlanOptions {
  readonly resolver: SourceResolver
}

const selectedProfiles = (request: CompositionRequest): string[] => {
  const profiles = normalizeProfiles(request.profiles)
  for (const id of profiles) {
    if (Object.hasOwn(request.catalog.profiles, id)) continue
    const declared = Object.keys(request.catalog.profiles).sort().join(", ")
    throw new NativeRunError(
      "unknown-profile",
      `unknown profile ${id}; declared profiles: ${declared || "none (add [native.profiles.NAME] to ~/.config/trellage/config.toml)"}`,
    )
  }
  return profiles
}

const effectiveProfiles = (
  request: CompositionRequest,
  profiles: ReadonlyArray<string>,
): {
  alwaysProfiles: string[]
  effective: string[]
} => {
  const alwaysProfiles = request.skipAlways
    ? []
    : Object.entries(request.catalog.profiles)
        .filter(([, profile]) => profile.always && (!profile.harnesses || profile.harnesses.includes(request.harness)))
        .map(([id]) => id)
        .sort()
  const effective = [...new Set([...alwaysProfiles, ...profiles])].sort()
  for (const id of effective) {
    const unsupported = request.catalog.profiles[id]!.plugins.filter((plugin) => plugin.harness === request.harness)
    if (unsupported.length === 0) continue
    throw new NativeRunError(
      "unsupported",
      `profile ${id} declares plugins for ${request.harness}; plugin installation is not supported yet and is not silently skipped`,
    )
  }
  return { alwaysProfiles, effective }
}

const selectedInstructions = (
  request: CompositionRequest,
  effective: ReadonlyArray<string>,
): Array<{ readonly id: string; readonly text: string }> =>
  [...new Set(effective.flatMap((id) => request.catalog.profiles[id]!.instructions))].sort().map((id) => {
    const text = request.instructionTexts?.[id]
    if (text === undefined) throw new NativeRunError("config", `instruction ${id} has no loaded content`)
    return { id, text }
  })

const wantedSkills = (request: CompositionRequest, effective: ReadonlyArray<string>): Map<string, Set<string>> => {
  const wanted = new Map<string, Set<string>>()
  for (const id of effective) {
    for (const selection of request.catalog.profiles[id]!.skills) {
      if (!Object.hasOwn(request.catalog.sources, selection.source))
        throw new NativeRunError("config", `profile ${id} references undeclared source ${selection.source}`)
      const names = wanted.get(selection.source) ?? new Set<string>()
      for (const name of selection.names) names.add(name)
      wanted.set(selection.source, names)
    }
  }
  return wanted
}

const resolveSkills = async (
  request: CompositionRequest,
  options: PlanOptions,
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<{ sources: ResolvedSource[]; skills: SelectedSkill[] }> => {
  const sources = await Promise.all(
    [...wanted.keys()].sort().map((sourceId) => options.resolver.resolve(sourceId, request.catalog.sources[sourceId]!)),
  )
  const skills = new Map<string, SelectedSkill>()
  for (const source of sources) {
    const policy = request.catalog.sources[source.sourceId]!
    const wantedNames = wanted.get(source.sourceId)!
    const names = wantedNames.has("*")
      ? (await discoverSkillNames(source.directory)).filter((name) => !policy.exclude?.includes(name))
      : [...wantedNames].sort()
    for (const required of policy.required ?? []) {
      if (!(await findSkill(source.directory, required)))
        throw new NativeRunError("skill-not-found", `required skill ${required} is missing from ${source.sourceId}`)
    }
    for (const name of names) {
      const directory = await findSkill(source.directory, name)
      if (!directory)
        throw new NativeRunError(
          "skill-not-found",
          `skill ${name} was not found in source ${source.sourceId} (${source.repository})`,
        )
      if (policy.allowExecutables === false) await validateExecutablePolicy(directory)
      const markdown = await readFile(path.join(directory, "SKILL.md"), "utf8")
      const openaiPolicy = await readFile(path.join(directory, "agents", "openai.yaml"), "utf8").catch(() => "")
      const manualOnly =
        /^---\r?\n[\s\S]*?^disable-model-invocation:\s*true\s*$/m.test(markdown) ||
        /^\s*allow_implicit_invocation:\s*false\s*$/m.test(openaiPolicy)
      const selected = {
        name,
        sourceId: source.sourceId,
        commit: source.commit,
        digest: await digestDirectory(directory),
        directory,
        ...(manualOnly ? { manualOnly: true } : {}),
        ...(policy.alwaysOn && !manualOnly ? { alwaysOn: true } : {}),
      }
      const existing = skills.get(name)
      if (existing && existing.digest !== selected.digest)
        throw new NativeRunError(
          "conflict",
          `skill ${name} differs between sources ${existing.sourceId} and ${selected.sourceId}; remove one profile from the stack`,
        )
      if (!existing) skills.set(name, selected)
    }
  }
  return { sources, skills: [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) }
}

const generationIdOf = (
  request: CompositionRequest,
  effective: ReadonlyArray<string>,
  instructions: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  skills: ReadonlyArray<SelectedSkill>,
): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        COMPOSITION_SCHEMA,
        request.harness,
        effective,
        instructions.map((instruction) => [
          instruction.id,
          createHash("sha256").update(instruction.text).digest("hex"),
        ]),
        request.adapterPolicy,
        request.providerPolicy,
        skills.map((skill) => [skill.name, skill.digest, skill.alwaysOn ?? false, skill.manualOnly ?? false]),
      ]),
    )
    .digest("hex")
    .slice(0, 16)

/** Resolve every selected profile into exact skill content and detect conflicts. */
export const planComposition = async (request: CompositionRequest, options: PlanOptions): Promise<CompositionPlan> => {
  const profiles = selectedProfiles(request)
  const { alwaysProfiles, effective } = effectiveProfiles(request, profiles)
  const instructions = selectedInstructions(request, effective)
  const { sources, skills } = await resolveSkills(request, options, wantedSkills(request, effective))
  for (const skill of skills.filter((entry) => entry.alwaysOn && !entry.manualOnly)) {
    instructions.push({
      id: `skill-${skill.name}`,
      text: `# Managed skill: ${skill.name}\n\n${stripFrontmatter(await readFile(path.join(skill.directory, "SKILL.md"), "utf8"))}`,
    })
  }

  return {
    compositionId: compositionIdOf(request.harness, profiles),
    harness: request.harness,
    profiles,
    alwaysProfiles,
    instructions,
    skills,
    sources,
    warnings: sources.flatMap((source) => (source.warning ? [source.warning] : [])),
    generationId: generationIdOf(request, effective, instructions, skills),
  }
}

export interface GenerationLayout {
  readonly ownerHome: string
  readonly generationPath: string
  readonly sessionsPath: string
}

export const layoutFor = (paths: NativeRunPaths, plan: CompositionPlan): GenerationLayout => {
  const ownerHome = path.join(paths.data, "compositions", plan.compositionId)
  return {
    ownerHome,
    generationPath: path.join(ownerHome, "generations", plan.generationId),
    sessionsPath: path.join(ownerHome, "sessions"),
  }
}

export interface PublishInput {
  readonly paths: NativeRunPaths
  readonly plan: CompositionPlan
  /** Adapter hook that writes harness configuration into the staged generation. */
  readonly writeAdapterFiles: (stage: string, layout: GenerationLayout) => Promise<void>
  readonly skillsSubdirectory: string
  /** Generation-relative file the harness reads as user-level instructions. */
  readonly instructionsFile: string
  /** Generation-relative directories that hold conversations; they live per composition so they outlast generations. */
  readonly persistentState?: ReadonlyArray<string>
}

const stripFrontmatter = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()

/** Stage the complete generation, then publish it atomically. Existing identical generations are reused. */
export const publishGeneration = async (input: PublishInput): Promise<GenerationLayout> => {
  const layout = layoutFor(input.paths, input.plan)
  await mkdir(layout.sessionsPath, { recursive: true, mode: 0o700 })
  await mkdir(path.dirname(layout.generationPath), { recursive: true, mode: 0o700 })
  if (await exists(path.join(layout.generationPath, "manifest.json"))) return layout

  const stage = path.join(
    path.dirname(layout.generationPath),
    `.stage-${process.pid}-${Math.random().toString(36).slice(2)}`,
  )
  await mkdir(stage, { recursive: true, mode: 0o700 })
  try {
    for (const skill of input.plan.skills) {
      await cp(skill.directory, path.join(stage, input.skillsSubdirectory, skill.name), { recursive: true })
    }
    await input.writeAdapterFiles(stage, layout)
    for (const name of input.persistentState ?? []) {
      const target = path.join(layout.ownerHome, "state", name)
      await mkdir(target, { recursive: true, mode: 0o700 })
      await rm(path.join(stage, name), { recursive: true, force: true })
      await symlink(target, path.join(stage, name))
    }
    if (input.plan.instructions.length > 0)
      await writeFile(
        path.join(stage, input.instructionsFile),
        `${input.plan.instructions.map((instruction) => stripFrontmatter(instruction.text)).join("\n\n")}\n`,
      )
    await writeFile(
      path.join(stage, "manifest.json"),
      `${JSON.stringify(
        {
          schema: COMPOSITION_SCHEMA,
          harness: input.plan.harness,
          profiles: input.plan.profiles,
          alwaysProfiles: input.plan.alwaysProfiles,
          instructions: input.plan.instructions.map((instruction) => instruction.id),
          skills: input.plan.skills.map(({ name, sourceId, commit, digest }) => ({ name, sourceId, commit, digest })),
        },
        null,
        2,
      )}\n`,
    )
    try {
      await rename(stage, layout.generationPath)
    } catch (error) {
      // Another launch published the same content-addressed generation first.
      if (!(await exists(path.join(layout.generationPath, "manifest.json")))) throw error
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  return layout
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}
