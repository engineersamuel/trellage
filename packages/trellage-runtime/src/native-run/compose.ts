import { createHash } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { NativeCatalog, NativePluginSelection } from "../native-config.ts"
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

export interface SelectedPlugin extends NativePluginSelection {
  readonly name: string
  readonly sourceId: string
  readonly commit: string
  readonly digest: string
  /** Absolute path of the plugin inside the verified source cache. */
  readonly directory: string
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
  readonly plugins: ReadonlyArray<SelectedPlugin>
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

const selectedPlugins = (
  request: CompositionRequest,
  effective: ReadonlyArray<string>,
): Array<NativePluginSelection & { readonly profile: string }> => {
  const plugins: Array<NativePluginSelection & { readonly profile: string }> = []
  for (const profile of effective) {
    for (const plugin of request.catalog.profiles[profile]!.plugins) {
      if (plugin.harness !== request.harness) continue
      if (request.harness !== "claude")
        throw new NativeRunError("unsupported", `plugin loading is not supported for ${request.harness}`)
      plugins.push({ ...plugin, profile })
    }
  }
  return plugins
}

const pluginName = (selection: NativePluginSelection): string =>
  selection.name ?? path.basename(selection.path === "." ? selection.source : selection.path).toLowerCase()

const pluginManifestExists = async (directory: string): Promise<boolean> => {
  const manifests = await Promise.all([
    lstat(path.join(directory, ".claude-plugin", "plugin.json")).catch(() => undefined),
    lstat(path.join(directory, "plugin.json")).catch(() => undefined),
  ])
  return manifests.some((manifest) => manifest?.isFile() && !manifest.isSymbolicLink())
}

const marketplacePluginDirectory = async (
  root: string,
  selection: NativePluginSelection,
): Promise<string | undefined> => {
  const manifestPath = path.join(root, ".claude-plugin", "marketplace.json")
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch {
    return undefined
  }
  if (!manifest || typeof manifest !== "object" || !Array.isArray((manifest as { plugins?: unknown }).plugins))
    throw new NativeRunError("unsupported", `plugin marketplace manifest is invalid: ${manifestPath}`)
  const entry = (manifest as { plugins: Array<Record<string, unknown>> }).plugins.find(
    (candidate) => candidate?.name === selection.plugin,
  )
  if (!entry) throw new NativeRunError("unsupported", `plugin ${selection.plugin} is missing from ${manifestPath}`)
  if (typeof entry.source !== "string" || !entry.source.startsWith("./"))
    throw new NativeRunError("unsupported", `plugin ${selection.plugin} uses an unsupported marketplace source`)
  const directory = path.resolve(root, entry.source)
  const relative = path.relative(root, directory)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new NativeRunError("unsafe-path", `plugin ${selection.plugin} escapes marketplace source`)
  return directory
}

const resolvePluginDirectory = async (source: ResolvedSource, selection: NativePluginSelection): Promise<string> => {
  const selectedRoot = path.resolve(source.directory, selection.path)
  const relative = path.relative(source.directory, selectedRoot)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new NativeRunError("unsafe-path", `plugin ${pluginName(selection)} escapes source ${selection.source}`)
  if (await pluginManifestExists(selectedRoot)) return selectedRoot
  const resolved = await marketplacePluginDirectory(selectedRoot, selection)
  if (!resolved) throw new NativeRunError("unsupported", `plugin ${pluginName(selection)} has no plugin manifest`)
  return resolved
}

/** Plugins may link files inside themselves (Council links skills/council/SKILL.md to its root SKILL.md). */
const assertSymlinksStayInside = async (root: string, name: string): Promise<void> => {
  const realRoot = await realpath(root)
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(child)
      if (!entry.isSymbolicLink()) continue
      const target = await realpath(child).catch(() => undefined)
      const relative = target === undefined ? ".." : path.relative(realRoot, target)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new NativeRunError("unsafe-path", `plugin ${name} links outside itself: ${path.relative(root, child)}`)
    }
  }
  await walk(root)
}

const validatePluginDirectory = async (
  source: ResolvedSource,
  selection: NativePluginSelection,
  profile: string,
): Promise<{ directory: string; digest: string }> => {
  try {
    const directory = await resolvePluginDirectory(source, selection)
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new NativeRunError("unsafe-path", `plugin ${pluginName(selection)} is not a safe directory`)
    if (!(await pluginManifestExists(directory)))
      throw new NativeRunError("unsupported", `plugin ${pluginName(selection)} has no regular Claude plugin manifest`)
    await assertSymlinksStayInside(directory, pluginName(selection))
    return { directory, digest: await digestDirectory(directory, true) }
  } catch (cause) {
    if (cause instanceof NativeRunError) throw cause
    throw new NativeRunError("unsupported", `plugin ${pluginName(selection)} for ${profile} is invalid: ${String(cause)}`)
  }
}

const resolvedPlugin = async (
  source: ResolvedSource,
  selection: NativePluginSelection,
  profile: string,
): Promise<SelectedPlugin> => {
  const { directory, digest } = await validatePluginDirectory(source, selection, profile)
  return {
    ...selection,
    name: pluginName(selection),
    includeMcp: selection.includeMcp ?? true,
    settings: selection.settings ?? {},
    sourceId: selection.source,
    commit: source.commit,
    digest,
    directory,
  }
}

const addPlugin = (plugins: Map<string, SelectedPlugin>, selected: SelectedPlugin): void => {
  const existing = plugins.get(selected.name)
  if (
    existing &&
    (existing.digest !== selected.digest ||
      JSON.stringify(existing.settings) !== JSON.stringify(selected.settings) ||
      existing.includeMcp !== selected.includeMcp)
  )
    throw new NativeRunError("conflict", `Claude plugin ${selected.name} has conflicting selections`)
  if (!existing) plugins.set(selected.name, selected)
}

const resolvePlugins = async (
  request: CompositionRequest,
  options: PlanOptions,
  effective: ReadonlyArray<string>,
): Promise<{ sources: ResolvedSource[]; plugins: SelectedPlugin[] }> => {
  const declarations = selectedPlugins(request, effective)
  const sourceIds = [...new Set(declarations.map(({ source }) => source))].sort()
  const sources = await Promise.all(
    sourceIds.map((sourceId) => options.resolver.resolve(sourceId, request.catalog.sources[sourceId]!)),
  )
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]))
  const plugins = new Map<string, SelectedPlugin>()
  for (const declaration of declarations) {
    const { profile, ...selection } = declaration
    const source = sourceById.get(selection.source)
    if (!source) throw new NativeRunError("config", `plugin source ${selection.source} was not resolved`)
    addPlugin(plugins, await resolvedPlugin(source, selection, profile))
  }
  return { sources, plugins: [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name)) }
}

const skillNamesForSource = async (
  source: ResolvedSource,
  policy: NativeCatalog["sources"][string],
  wanted: ReadonlySet<string>,
): Promise<string[]> => {
  for (const required of policy.required ?? []) {
    if (!(await findSkill(source.directory, required)))
      throw new NativeRunError("skill-not-found", `required skill ${required} is missing from ${source.sourceId}`)
  }
  if (!wanted.has("*")) return [...wanted].sort()
  const names = await discoverSkillNames(source.directory)
  return names.filter((name) => !policy.exclude?.includes(name))
}

const loadSelectedSkill = async (
  source: ResolvedSource,
  name: string,
  policy: NativeCatalog["sources"][string],
): Promise<SelectedSkill> => {
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
  return {
    name,
    sourceId: source.sourceId,
    commit: source.commit,
    digest: await digestDirectory(directory),
    directory,
    ...(manualOnly ? { manualOnly: true } : {}),
    ...(policy.alwaysOn && !manualOnly ? { alwaysOn: true } : {}),
  }
}

const mergeSelectedSkill = (
  skills: Map<string, SelectedSkill>,
  warnings: string[],
  selectedSources: ReadonlySet<string>,
  selected: SelectedSkill,
): void => {
  const existing = skills.get(selected.name)
  if (!existing) {
    skills.set(selected.name, selected)
    return
  }
  if (existing.digest === selected.digest) return
  const existingSelected = selectedSources.has(existing.sourceId)
  const currentSelected = selectedSources.has(selected.sourceId)
  if (existingSelected === currentSelected)
    throw new NativeRunError(
      "conflict",
      `skill ${selected.name} differs between sources ${existing.sourceId} and ${selected.sourceId}; remove one profile from the stack`,
    )
  const winner = currentSelected ? selected : existing
  const loser = currentSelected ? existing : selected
  skills.set(selected.name, winner)
  warnings.push(`skill ${selected.name} from selected source ${winner.sourceId} overrides always-profile source ${loser.sourceId}`)
}

const resolveSkills = async (
  request: CompositionRequest,
  options: PlanOptions,
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
  selectedSources: ReadonlySet<string>,
): Promise<{ sources: ResolvedSource[]; skills: SelectedSkill[]; warnings: string[] }> => {
  const sources = await Promise.all(
    [...wanted.keys()].sort().map((sourceId) => options.resolver.resolve(sourceId, request.catalog.sources[sourceId]!)),
  )
  const skills = new Map<string, SelectedSkill>()
  const warnings: string[] = []
  for (const source of sources) {
    const policy = request.catalog.sources[source.sourceId]!
    const names = await skillNamesForSource(source, policy, wanted.get(source.sourceId)!)
    for (const name of names) {
      mergeSelectedSkill(skills, warnings, selectedSources, await loadSelectedSkill(source, name, policy))
    }
  }
  return { sources, skills: [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), warnings }
}

const generationIdOf = (
  request: CompositionRequest,
  effective: ReadonlyArray<string>,
  instructions: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  skills: ReadonlyArray<SelectedSkill>,
  plugins: ReadonlyArray<SelectedPlugin>,
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
        plugins.map((plugin) => [
          plugin.name,
          plugin.sourceId,
          plugin.commit,
          plugin.digest,
          plugin.includeMcp,
          plugin.settings,
        ]),
      ]),
    )
    .digest("hex")
    .slice(0, 16)

/** Resolve every selected profile into exact skill content and detect conflicts. */
export const planComposition = async (request: CompositionRequest, options: PlanOptions): Promise<CompositionPlan> => {
  const profiles = selectedProfiles(request)
  const { alwaysProfiles, effective } = effectiveProfiles(request, profiles)
  const instructions = selectedInstructions(request, effective)
  const selectedSources = new Set(profiles.flatMap((id) => request.catalog.profiles[id]!.skills.map((selection) => selection.source)))
  const { sources, skills, warnings } = await resolveSkills(request, options, wantedSkills(request, effective), selectedSources)
  const resolvedPlugins = await resolvePlugins(request, options, effective)
  const allSources = new Map([...sources, ...resolvedPlugins.sources].map((source) => [source.sourceId, source]))
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
    sources: [...allSources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    plugins: resolvedPlugins.plugins,
    warnings: [...sources.flatMap((source) => (source.warning ? [source.warning] : [])), ...warnings],
    generationId: generationIdOf(request, effective, instructions, skills, resolvedPlugins.plugins),
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
    for (const plugin of input.plan.plugins) {
      const directory = path.join(stage, "plugins", plugin.name)
      await cp(plugin.directory, directory, { recursive: true, errorOnExist: true, verbatimSymlinks: true })
      if (!plugin.includeMcp) await rm(path.join(directory, ".mcp.json"), { force: true })
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
          plugins: input.plan.plugins.map(({ name, sourceId, commit, digest, includeMcp, settings }) => ({
            name,
            sourceId,
            commit,
            digest,
            includeMcp,
            settings,
          })),
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
