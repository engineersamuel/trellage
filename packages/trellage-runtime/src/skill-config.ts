import { readFile } from "node:fs/promises"
import { parse } from "smol-toml"

const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const safeRepository = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/

export enum SkillAdapter {
  Generic = "generic",
  OmpNative = "omp-native",
}

export interface SkillSource {
  readonly id: string
  readonly repository: string
  readonly tag?: string
  readonly commit?: string
  readonly select: readonly string[]
  readonly exclude: readonly string[]
  readonly required: readonly string[]
  readonly adapter: SkillAdapter
  readonly allowWildcard: boolean
  readonly alwaysOn: boolean
  readonly allowExecutables: boolean
}

export interface SkillCatalog {
  readonly schema: 1
  readonly sources: Readonly<Record<string, SkillSource>>
  readonly bundles: Readonly<Record<string, readonly string[]>>
}

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

export const assertStringArray = (value: unknown, label: string): string[] => {
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
    "tag",
    "commit",
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
  if (
    candidate.tag !== undefined &&
    (typeof candidate.tag !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidate.tag) ||
      candidate.tag.includes(".."))
  )
    fail(`invalid tag: ${id}`)
  if (
    candidate.commit !== undefined &&
    (typeof candidate.commit !== "string" || !/^[a-f0-9]{40}$/i.test(candidate.commit))
  )
    fail(`invalid commit: ${id}`)
  if (candidate.tag !== undefined && candidate.commit !== undefined)
    fail(`source cannot have both tag and commit: ${id}`)
  const { select, exclude, required } = parseSourceSelections(id, candidate)
  const allowExecutables = parseBooleanPolicy(candidate, "allowExecutables", id)
  const alwaysOn = parseBooleanPolicy(candidate, "alwaysOn", id)
  const adapter = candidate.adapter ?? SkillAdapter.Generic
  if (adapter !== SkillAdapter.Generic && adapter !== SkillAdapter.OmpNative) fail(`invalid skill adapter: ${id}`)
  if (adapter !== SkillAdapter.Generic && alwaysOn) fail(`always-on is supported only for generic skills: ${id}`)
  return Object.freeze({
    id,
    repository: candidate.repository,
    ...(candidate.tag === undefined ? {} : { tag: candidate.tag as string }),
    ...(candidate.commit === undefined ? {} : { commit: (candidate.commit as string).toLowerCase() }),
    select: Object.freeze([...select]),
    exclude: Object.freeze([...exclude]),
    required: Object.freeze([...required]),
    adapter,
    alwaysOn,
    allowWildcard: candidate.allowWildcard === true,
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
    raw = source.trimStart().startsWith("{")
      ? JSON.parse(source)
      : { schema: 1, ...(parse(source).skills as Record<string, unknown>) }
  } catch (cause) {
    fail("skill catalog is not valid TOML or legacy JSON", cause)
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

/** Read one effective policy; an environment-only default file inherits shipped skills in memory. */
export const readEffectiveSkillCatalog = async (options: {
  readonly configPath: string
  readonly starterPath: string
  readonly explicit?: boolean
}): Promise<SkillCatalog> => {
  const source = await readFile(options.configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && !options.explicit) return undefined
    throw error
  })
  if (source !== undefined) {
    const raw = parse(source)
    if (raw.skills !== undefined) return parseCatalog(source)
    if (options.explicit) fail(`explicit configuration has no [skills] policy: ${options.configPath}`)
  }
  return readCatalog(options.starterPath)
}
