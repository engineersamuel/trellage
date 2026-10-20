import { constants } from "node:fs"
import { open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Data, Effect, Either, ParseResult, Schema } from "effect"
import { parse } from "smol-toml"
import { parseCatalog } from "./skill-config.ts"
import { parseSelectionMetadata } from "@trellage/guide-core"
import { resolveShippedResource } from "./native-run/resources.ts"

const NonEmpty = Schema.String.pipe(Schema.minLength(1))
const LowercaseIdentity = Schema.transform(Schema.String, Schema.String, {
  strict: true,
  decode: (value) => value.toLowerCase(),
  encode: (value) => value,
})
const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
const Identifier = Schema.String.pipe(Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
const RelativePluginPath = NonEmpty.pipe(
  Schema.filter(
    (value) =>
      value === "." ||
      (!hasControlCharacters(value) &&
        !/[\\:]/.test(value) &&
        value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")),
  ),
)
const Repository = NonEmpty.pipe(
  Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/),
  Schema.filter((value) => ![".", ".."].includes(value.split("/")[1] ?? "")),
)
const PluginSettingKey = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_-]*$/))
const Tag = NonEmpty.pipe(
  Schema.filter(
    (value) =>
      value !== "@" &&
      !hasControlCharacters(value) &&
      !/[ ~^:?*[\]\\]/.test(value) &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !value.endsWith(".") &&
      value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
  ),
)

const EnvironmentConfig = Schema.Struct({
  provider: Schema.optionalWith(Schema.Literal("varlock"), { default: () => "varlock" as const }),
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  path: Schema.optional(NonEmpty),
  required: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  strict_permissions: Schema.optionalWith(Schema.Boolean, { default: () => true }),
})

const NativeSource = Schema.Struct({
  exclude: Schema.optional(Schema.Array(Identifier)),
  required: Schema.optional(Schema.Array(Identifier)),
  allowWildcard: Schema.optional(Schema.Boolean),
  allowExecutables: Schema.optional(Schema.Boolean),
  alwaysOn: Schema.optional(Schema.Boolean),
  repository: Repository.pipe(Schema.compose(LowercaseIdentity)),
  tag: Schema.optional(Tag),
  commit: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}$/i), Schema.compose(LowercaseIdentity))),
}).pipe(Schema.filter((source) => source.tag === undefined || source.commit === undefined))

const NativeSkillSelection = Schema.Struct({
  source: Identifier,
  names: Schema.Array(Schema.Union(Identifier, Schema.Literal("*"))).pipe(Schema.minItems(1)),
})

const NativePluginSelection = Schema.Struct({
  source: Identifier,
  harness: Identifier,
  path: RelativePluginPath,
  name: Schema.optional(Identifier),
  plugin: Schema.optional(Identifier),
  marketplace: Schema.optional(Identifier),
  includeMcp: Schema.optional(Schema.Boolean),
  settings: Schema.optional(Schema.Record({ key: PluginSettingKey, value: NonEmpty })),
})

const NativeInstruction = Schema.Struct({
  file: Schema.Union(RelativePluginPath, NonEmpty.pipe(Schema.filter(value => {
    try { resolveShippedResource(value,"/shipped"); return true } catch { return false }
  }))),
})

/** Absolute or home-relative (`~/...`) directory. */
const WorkingDirectory = NonEmpty.pipe(
  Schema.filter((value) => !hasControlCharacters(value) && (value === "~" || value.startsWith("~/") || path.isAbsolute(value))),
)

const NativeProfileRepository = Schema.Struct({
  url: NonEmpty.pipe(Schema.filter((value) => !hasControlCharacters(value))),
  branch: Schema.optionalWith(NonEmpty.pipe(Schema.pattern(/^[A-Za-z0-9._/-]+$/)), { default: () => "main" }),
})

const NativePrerequisite = Schema.Struct({
  /** Executable that must be on PATH. */
  command: NonEmpty.pipe(Schema.pattern(/^[A-Za-z0-9._-]+$/)),
  /** Shell command that installs it; run only after the user confirms. */
  install: NonEmpty.pipe(Schema.filter((value) => !hasControlCharacters(value))),
})

const NativeSelection = Schema.Struct({
  description: Schema.optional(NonEmpty),
  strengths: Schema.optional(Schema.Array(NonEmpty)),
  weaknesses: Schema.optional(Schema.Array(NonEmpty)),
  best_for: Schema.optional(Schema.Array(NonEmpty)),
  avoid_for: Schema.optional(Schema.Array(NonEmpty)),
  capabilities: Schema.optional(Schema.Array(Identifier)),
}).pipe(Schema.filter((value) => {
  try { parseSelectionMetadata(value, "selection"); return true } catch { return false }
}))

const NativeWorkflow = Schema.Struct({
  id: Identifier,
  description: NonEmpty,
  examples: Schema.Array(NonEmpty),
  skill: Schema.optional(NonEmpty),
  launch_agent: Schema.optional(NonEmpty),
  interaction: Schema.optional(Schema.Struct({
    mode: Schema.Literal("interactive"),
    required_skills: Schema.Array(Identifier),
  })),
  frame: Schema.optional(Schema.Literal("fixed")),
})
const NativeGuide = Schema.Struct({
  document: Schema.optional(NonEmpty),
  documents: Schema.optional(Schema.Record({ key: Identifier, value: NonEmpty })),
  workflows: Schema.optional(Schema.Array(NativeWorkflow)),
  prerequisites: Schema.optional(Schema.Array(Schema.Struct({ id: Identifier, description: NonEmpty }))),
  goal_execution: Schema.optional(Schema.Struct({
    controller: Schema.Literal("codex-goal", "claude-goal"),
    workflow_ids: Schema.Array(Identifier),
  })),
})
export type NativeWorkflowConfig = Schema.Schema.Type<typeof NativeGuide>

const NativeProfile = Schema.Struct({
  selection: Schema.optional(NativeSelection),
  required_environment: Schema.optional(Schema.Array(NonEmpty.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/)))),
  guide: Schema.optional(NativeGuide),
  label: Schema.optional(NonEmpty),
  /** Apply to every run, before the profiles the user selects. */
  always: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** Restrict the profile to these harnesses; omitted means all. */
  harnesses: Schema.optional(Schema.Array(Identifier).pipe(Schema.minItems(1))),
  instructions: Schema.optionalWith(Schema.Array(Identifier), { default: () => [] }),
  skills: Schema.optionalWith(Schema.Array(NativeSkillSelection), { default: () => [] }),
  plugins: Schema.optionalWith(Schema.Array(NativePluginSelection), { default: () => [] }),
  /** Start the harness in this directory instead of the invocation directory. */
  current_working_directory: Schema.optional(WorkingDirectory),
  /** Clone this repository into current_working_directory and pull it before every launch. */
  repository: Schema.optional(NativeProfileRepository),
  /** Load the working directory's own harness extensions and skills. */
  project_resources: Schema.optional(Schema.Boolean),
  /** Executables the profile needs; trx offers to install missing ones before launch. */
  prerequisites: Schema.optional(Schema.Array(NativePrerequisite)),
  /** Hand this run's harness setup to the workers the agent starts; "firstmate" writes the Firstmate home's worker config. */
  workers: Schema.optional(Schema.Literal("firstmate")),
})

const NativeCatalog = Schema.Struct({
  harnesses: Schema.optional(Schema.Record({ key: Identifier, value: Schema.Struct({ selection: Schema.optional(NativeSelection) }) })),
  sources: Schema.optionalWith(Schema.Record({ key: Identifier, value: NativeSource }), { default: () => ({}) }),
  instructions: Schema.optionalWith(Schema.Record({ key: Identifier, value: NativeInstruction }), { default: () => ({}) }),
  profiles: Schema.optionalWith(Schema.Record({ key: Identifier, value: NativeProfile }), { default: () => ({}) }),
})

const RootConfig = Schema.Struct({
  schema_version: Schema.optionalWith(Schema.Literal(1), { default: () => 1 as const }),
  environment: Schema.optional(Schema.Unknown),
  native: Schema.optional(Schema.Unknown),
  skills: Schema.optional(Schema.Unknown),
})

export type EnvironmentConfig = Schema.Schema.Type<typeof EnvironmentConfig>
export type NativeSource = Schema.Schema.Type<typeof NativeSource>
export type NativeProfile = Schema.Schema.Type<typeof NativeProfile>
export type NativePluginSelection = Schema.Schema.Type<typeof NativePluginSelection>
export type NativeCatalog = Schema.Schema.Type<typeof NativeCatalog>

export interface TrellageConfig {
  readonly schema_version: 1
  readonly environment: EnvironmentConfig
  readonly native: NativeCatalog
}

export interface TrellageConfigLocation {
  readonly environment?: NodeJS.ProcessEnv
  readonly home?: string
  readonly cwd?: string
}

export interface LoadedTrellageConfig {
  readonly path: string
  readonly present: boolean
  readonly nativeDeclared: boolean
  readonly config: TrellageConfig
}

export class TrellageConfigError extends Data.TaggedError("TrellageConfigError")<{
  readonly message: string
}> {}

const configError = (label: string, cause: ParseResult.ParseError): TrellageConfigError => {
  const locations = ParseResult.ArrayFormatter.formatErrorSync(cause).map(
    (issue) => issue.path.map(String).join(".") || "root",
  )
  return new TrellageConfigError({
    message: `invalid ${label} configuration: unknown or invalid value at ${[...new Set(locations)].join(", ")}`,
  })
}

const validateProfileSources = (catalog: NativeCatalog): string | undefined => {
  for (const [profileId, profile] of Object.entries(catalog.profiles)) {
    for (const selection of [...profile.skills, ...profile.plugins]) {
      if (!Object.hasOwn(catalog.sources, selection.source))
        return `profile ${profileId} references undeclared source ${selection.source}`
    }
    for (const plugin of profile.plugins) {
      if (Object.keys(plugin.settings ?? {}).length > 0 && (!plugin.plugin || !plugin.marketplace))
        return `profile ${profileId} plugin settings require plugin id and marketplace`
    }
  }
}

const validateProfileWildcards = (catalog: NativeCatalog): string | undefined => {
  for (const [profileId, profile] of Object.entries(catalog.profiles)) {
    for (const selection of profile.skills) {
      const source = catalog.sources[selection.source]
      if (selection.names.includes("*") && (!source?.allowWildcard || selection.names.length !== 1))
        return `wildcard selection requires explicit source permission and a sole wildcard: ${profileId}/${selection.source}`
    }
  }
}

const validateProfileInstructions = (catalog: NativeCatalog): string | undefined => {
  for (const [profileId, profile] of Object.entries(catalog.profiles)) {
    for (const instruction of profile.instructions) {
      if (!Object.hasOwn(catalog.instructions, instruction))
        return `profile ${profileId} references undeclared instruction ${instruction}`
    }
  }
}

const validateProfileWorkspaces = (catalog: NativeCatalog): string | undefined => {
  for (const [profileId, profile] of Object.entries(catalog.profiles)) {
    if (profile.repository && !profile.current_working_directory)
      return `profile ${profileId} declares repository without current_working_directory`
  }
  return undefined
}

const validateNativeReferences = (catalog: NativeCatalog): string | undefined =>
  validateProfileWorkspaces(catalog) ??
  validateProfileSources(catalog) ??
  validateProfileWildcards(catalog) ??
  validateProfileInstructions(catalog)

const parseConfigDocument = (source: string) =>
  Effect.try({
    try: () => parse(source),
    catch: () => new TrellageConfigError({ message: "invalid Trellage config: malformed TOML" }),
  })

const decodeTrellageConfig = (raw: unknown, source: string): Effect.Effect<TrellageConfig, TrellageConfigError> =>
  Effect.gen(function* () {
    const root = yield* Schema.decodeUnknown(RootConfig)(raw).pipe(
      Effect.mapError((cause) => configError("Trellage", cause)),
    )
    const environment = yield* Schema.decodeUnknown(EnvironmentConfig)(root.environment ?? {}, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => configError("[environment]", cause)))
    const shared = root.skills === undefined ? undefined : yield* Effect.try({
      try: () => parseCatalog(source),
      catch: (cause) => new TrellageConfigError({ message: String(cause) }),
    })
    const declaredNative = (root.native ?? {}) as Record<string, unknown>
    const ownSources = (declaredNative.sources ?? {}) as Record<string, unknown>
    for (const id of Object.keys(shared?.sources ?? {})) {
      if (Object.hasOwn(ownSources, id)) return yield* new TrellageConfigError({ message: `duplicate shared/native source ${id}; declare it only once` })
    }
    const sharedSources = Object.fromEntries(Object.entries(shared?.sources ?? {}).map(([id, entry]) => [id, {
      exclude: entry.exclude, required: entry.required, allowWildcard: entry.allowWildcard,
      allowExecutables: entry.allowExecutables, alwaysOn: entry.alwaysOn,
      repository: entry.repository.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""),
      ...(entry.tag === undefined ? {} : { tag: entry.tag }),
      ...(entry.commit === undefined ? {} : { commit: entry.commit }),
    }]))
    const native = yield* Schema.decodeUnknown(NativeCatalog)({ ...declaredNative, sources: { ...sharedSources, ...ownSources } }, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError((cause) => configError("[native]", cause)))
    const referenceError = validateNativeReferences(native)
    if (referenceError)
      return yield* new TrellageConfigError({ message: `invalid [native] configuration: ${referenceError}` })
    return { schema_version: root.schema_version, environment, native }
  })

export const parseTrellageConfig = (source: string): Effect.Effect<TrellageConfig, TrellageConfigError> =>
  parseConfigDocument(source).pipe(Effect.flatMap((raw) => decodeTrellageConfig(raw, source)))

export const expandTrellagePath = (candidate: string, home: string, base: string): string => {
  if (candidate === "~") return home
  if (candidate.startsWith("~/")) return path.join(home, candidate.slice(2))
  return path.resolve(base, candidate)
}

/** Read the shared config without validating sections owned by other consumers. */
export const loadTrellageConfigDocument = (
  location: TrellageConfigLocation = {},
) =>
  Effect.gen(function* () {
    const environment = location.environment ?? process.env
    const home = location.home ?? os.homedir()
    const cwd = location.cwd ?? process.cwd()
    const configDirectory = environment.XDG_CONFIG_HOME
      ? path.resolve(cwd, environment.XDG_CONFIG_HOME, "trellage")
      : path.join(home, ".config", "trellage")
    const configPath = environment.TRELLAGE_CONFIG
      ? expandTrellagePath(environment.TRELLAGE_CONFIG, home, cwd)
      : path.join(configDirectory, "config.toml")
    const source = yield* Effect.tryPromise({
      try: async () => {
        let file
        try {
          file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          const stats = await file.stat()
          if (!stats.isFile()) {
            throw new TrellageConfigError({ message: `Trellage config must be a regular file: ${configPath}` })
          }
          if ((stats.mode & 0o022) !== 0) {
            throw new TrellageConfigError({
              message: `Trellage config must not be writable by group or other users: ${configPath}`,
            })
          }
          return await file.readFile("utf8")
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined
          throw cause
        } finally {
          await file?.close()
        }
      },
      catch: (cause) => {
        if (cause instanceof TrellageConfigError) return cause
        const code = cause instanceof Error && "code" in cause ? String(cause.code) : "I/O failure"
        return new TrellageConfigError({ message: `cannot read Trellage config: ${configPath} (${code})` })
      },
    })
    const document = yield* parseConfigDocument(source ?? "")
    return { path: configPath, source, document }
  })

export const loadTrellageConfig = (
  location: TrellageConfigLocation = {},
): Effect.Effect<LoadedTrellageConfig, TrellageConfigError> =>
  Effect.gen(function* () {
    const loaded = yield* loadTrellageConfigDocument(location)
    const config = yield* decodeTrellageConfig(loaded.document, loaded.source ?? "")
    return {
      path: loaded.path,
      present: loaded.source !== undefined,
      nativeDeclared: Object.hasOwn(loaded.document, "native"),
      config,
    }
  })

export const readTrellageConfigDocument = async (location: TrellageConfigLocation = {}) => {
  const result = await Effect.runPromise(Effect.either(loadTrellageConfigDocument(location)))
  if (Either.isLeft(result)) throw result.left
  return result.right
}

export const readTrellageConfig = async (location: TrellageConfigLocation = {}): Promise<LoadedTrellageConfig> => {
  const result = await Effect.runPromise(Effect.either(loadTrellageConfig(location)))
  if (Either.isLeft(result)) throw result.left
  return result.right
}
