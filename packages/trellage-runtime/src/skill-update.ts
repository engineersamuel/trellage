import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { parse } from "smol-toml"
import { parseCatalog } from "./skill-config.ts"
import { digestDirectory } from "./native-run/source.ts"
import { parseTrellageConfig, type NativeProfile, type NativeSource, type TrellageConfig } from "./native-config.ts"
import {
  createSourceResolver,
  gitSourceTransport,
  type ResolvedSource,
  type SourceTransport,
} from "./native-run/source.ts"
import { discoverSkillNames, findSkill } from "./native-run/compose.ts"
import { NativeRunError, resolveNativeRunPaths, type NativeRunPaths } from "./native-run/paths.ts"
import type { SkillCatalog } from "./skill-config.ts"

export interface SkillUpdateResult {
  readonly source: string
  readonly profiles: readonly string[]
  readonly oldSelector: string
  readonly newSelector: string
  readonly commit?: string
  readonly candidateCommit?: string
}
export interface SkillUpdateOptions {
  readonly configPath: string
  readonly paths?: NativeRunPaths
  readonly transport?: SourceTransport
  readonly check?: boolean
  readonly upgradePins?: boolean
  readonly validate?: (source: ResolvedSource) => Promise<void>
}
const selector = (source: NativeSource): string => source.commit ?? source.tag ?? "HEAD"
const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const newestStableTag = (tags: readonly string[]): string => {
  const versions = tags
    .filter((tag) => stableTag.test(tag))
    .map((tag) => ({ tag, parts: tag.replace(/^v/, "").split(".").map(Number) }))
  versions.sort((a, b) => b.parts[0]! - a.parts[0]! || b.parts[1]! - a.parts[1]! || b.parts[2]! - a.parts[2]!)
  const first = versions[0]
  if (!first || (versions[1] && first.parts.join(".") === versions[1].parts.join("."))) {
    throw new NativeRunError(
      "config",
      "tag upgrade is ambiguous; choose an explicit new tag or commit in ~/.config/trellage/config.toml",
    )
  }
  return first.tag
}

const replacePin = (text: string, section: string, key: string, oldValue: string, newValue: string): string => {
  const lines = text.split("\n")
  let active = false
  let changed = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const header = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (header) active = header[1]!.replace(/["']/g, "") === section
    if (!active) continue
    const field = new RegExp(`^(\\s*${key}\\s*=\\s*)(["'])([^"']*)\\2(\\s*(?:#.*)?)$`).exec(line)
    if (field?.[3] === oldValue) {
      lines[index] = `${field[1]}${field[2]}${newValue}${field[2]}${field[4]}`
      changed = true
    }
  }
  if (!changed)
    throw new NativeRunError("config", `cannot safely edit ${section}.${key}; use a table with a single-line pin`)
  return lines.join("\n")
}

type SkillReceipts = { pins?: Record<string, string>; floating?: Record<string, { commit: string }> }
type SourceResult = {
  readonly result: SkillUpdateResult
  readonly replacement: string
  readonly validated?: ResolvedSource
}

const assertUpdateMode = (options: SkillUpdateOptions): void => {
  if (options.check && options.upgradePins)
    throw new NativeRunError("usage", "--check and --upgrade-pins are mutually exclusive")
}

const readSafeConfig = async (
  configPath: string,
): Promise<{ readonly original: string; readonly mode: number; readonly config: TrellageConfig }> => {
  const original = await readFile(configPath, "utf8")
  const info = await lstat(configPath)
  if (!info.isFile() || info.isSymbolicLink()) throw new NativeRunError("unsafe-path", "config must be a regular file")
  return { original, mode: info.mode & 0o777, config: await Effect.runPromise(parseTrellageConfig(original)) }
}

const readSkillReceipts = async (statePath: string): Promise<SkillReceipts> =>
  readFile(path.join(statePath, "receipts.json"), "utf8")
    .then((text) => JSON.parse(text) as SkillReceipts)
    .catch(() => ({}))

const sourceProfiles = (
  id: string,
  profiles: Record<string, NativeProfile>,
  sharedCatalog?: SkillCatalog,
): string[] => {
  const selectedProfiles = Object.entries(profiles)
    .filter(([, profile]) => [...profile.skills, ...profile.plugins].some((item) => item.source === id))
    .map(([name]) => name)
  const bundles = Object.entries(sharedCatalog?.bundles ?? {})
    .filter(([, ids]) => ids.includes(id))
    .map(([name]) => `bundle:${name}`)
  return [...selectedProfiles, ...bundles]
}

const desiredSource = async (
  id: string,
  source: NativeSource,
  options: SkillUpdateOptions,
  transport: SourceTransport,
): Promise<{ readonly desired: NativeSource; readonly candidateCommit?: string }> => {
  if (!options.check && !(options.upgradePins && (source.commit || source.tag))) return { desired: source }
  if (source.tag) {
    if (!transport.listTags)
      throw new NativeRunError(
        "config",
        `cannot determine stable tags for ${id}; select an explicit tag in ~/.config/trellage/config.toml`,
      )
    const tag = newestStableTag(await transport.listTags(source.repository))
    return {
      desired: { ...source, tag },
      candidateCommit: await transport.resolveRef(source.repository, tag),
    }
  }
  const candidateCommit = await transport.resolveRef(source.repository, "HEAD")
  return { desired: source.commit ? { ...source, commit: candidateCommit } : source, candidateCommit }
}

const checkSource = (
  id: string,
  source: NativeSource,
  desired: NativeSource,
  profiles: string[],
  receipts: SkillReceipts,
  candidateCommit?: string,
): SkillUpdateResult => {
  const currentCommit =
    source.commit ??
    (source.tag
      ? receipts.pins?.[`${source.repository}|tag|${source.tag}`]
      : receipts.floating?.[source.repository]?.commit)
  return {
    source: id,
    profiles,
    oldSelector: selector(source),
    newSelector: selector(desired),
    ...(currentCommit ? { commit: currentCommit } : {}),
    ...(candidateCommit ? { candidateCommit } : {}),
  }
}

const validateProfileSkills = async (
  id: string,
  directory: string,
  profiles: Record<string, NativeProfile>,
): Promise<void> => {
  for (const profile of Object.values(profiles)) {
    for (const selection of profile.skills.filter((item) => item.source === id)) {
      for (const name of selection.names) {
        if (name !== "*" && !(await findSkill(directory, name)))
          throw new NativeRunError("skill-not-found", `skill ${name} missing from replacement ${id}`)
      }
    }
  }
}

const validateSharedSkills = async (id: string, directory: string, catalog?: SkillCatalog): Promise<void> => {
  const policy = catalog?.sources[id]
  if (!policy) return
  const selected = policy.select.includes("*")
    ? (await discoverSkillNames(directory)).filter((name) => !policy.exclude.includes(name))
    : policy.select
  for (const required of policy.required) {
    if (!selected.includes(required))
      throw new NativeRunError("skill-not-found", `required skill ${required} missing from replacement ${id}`)
  }
  for (const name of selected) {
    const skillDirectory = await findSkill(directory, name)
    if (!skillDirectory) throw new NativeRunError("skill-not-found", `skill ${name} missing from replacement ${id}`)
    await digestDirectory(skillDirectory)
  }
}

const validateResolvedSource = async (
  id: string,
  resolved: ResolvedSource,
  config: TrellageConfig,
  sharedCatalog: SkillCatalog | undefined,
  options: SkillUpdateOptions,
): Promise<void> => {
  if (resolved.warning) throw new NativeRunError("source-unavailable", resolved.warning)
  await validateProfileSkills(id, resolved.directory, config.native.profiles)
  await validateSharedSkills(id, resolved.directory, sharedCatalog)
  await options.validate?.(resolved)
}

const updateOneSource = async (
  id: string,
  source: NativeSource,
  state: {
    readonly config: TrellageConfig
    readonly sharedCatalog: SkillCatalog | undefined
    readonly sharedSources: Record<string, unknown>
    readonly receipts: SkillReceipts
    readonly resolver: ReturnType<typeof createSourceResolver>
    readonly transport: SourceTransport
    readonly options: SkillUpdateOptions
    readonly replacement: string
  },
): Promise<SourceResult> => {
  const profiles = sourceProfiles(id, state.config.native.profiles, state.sharedCatalog)
  const { desired, candidateCommit } = await desiredSource(id, source, state.options, state.transport)
  if (state.options.check) {
    return {
      result: checkSource(id, source, desired, profiles, state.receipts, candidateCommit),
      replacement: state.replacement,
    }
  }
  const resolved = await state.resolver.resolve(id, desired)
  await validateResolvedSource(id, resolved, state.config, state.sharedCatalog, state.options)
  const replacement =
    selector(desired) === selector(source)
      ? state.replacement
      : replacePin(
          state.replacement,
          `${Object.hasOwn(state.sharedSources, id) ? "skills" : "native"}.sources.${id}`,
          source.commit ? "commit" : "tag",
          selector(source),
          selector(desired),
        )
  return {
    result: {
      source: id,
      profiles,
      oldSelector: selector(source),
      newSelector: selector(desired),
      commit: resolved.commit,
      ...(candidateCommit ? { candidateCommit } : {}),
    },
    replacement,
    validated: resolved,
  }
}

const persistReplacement = async (
  configPath: string,
  original: string,
  replacement: string,
  mode: number,
): Promise<void> => {
  const lock = `${configPath}.upgrade.lock`
  const handle = await open(lock, "wx", 0o600)
  const temporary = path.join(path.dirname(configPath), `.config-upgrade-${process.pid}-${crypto.randomUUID()}.toml`)
  try {
    if ((await readFile(configPath, "utf8")) !== original)
      throw new NativeRunError("conflict", "config changed during skill upgrade; retry with the new configuration")
    await writeFile(temporary, replacement, { mode })
    await rename(temporary, configPath)
  } finally {
    await handle.close()
    await rm(temporary, { force: true })
    await rm(lock, { force: true })
  }
}

export const updateSkills = async (options: SkillUpdateOptions): Promise<SkillUpdateResult[]> => {
  assertUpdateMode(options)
  const { original, mode, config } = await readSafeConfig(options.configPath)
  const raw = parse(original)
  const sharedCatalog = raw.skills ? parseCatalog(original) : undefined
  const sharedSources = (raw.skills as { sources?: Record<string, unknown> } | undefined)?.sources ?? {}
  const transport = options.transport ?? gitSourceTransport()
  const paths = options.paths ?? resolveNativeRunPaths()
  const resolver = createSourceResolver({ paths, transport })
  const receipts = await readSkillReceipts(paths.state)
  const results: SkillUpdateResult[] = []
  const validated: ResolvedSource[] = []
  let replacement = original
  for (const [id, source] of Object.entries(config.native.sources)) {
    const updated = await updateOneSource(id, source, {
      config,
      sharedCatalog,
      sharedSources,
      receipts,
      resolver,
      transport,
      options,
      replacement,
    })
    results.push(updated.result)
    replacement = updated.replacement
    if (updated.validated) validated.push(updated.validated)
  }
  if (replacement !== original) await persistReplacement(options.configPath, original, replacement, mode)
  for (const source of validated) await resolver.markGood(source)
  return results
}
