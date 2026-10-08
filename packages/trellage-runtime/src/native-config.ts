import { constants } from "node:fs"
import { open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Data, Effect, Either, ParseResult, Schema } from "effect"
import { parse } from "smol-toml"
import { parseCatalog } from "./skill-config.ts"

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
})

const NativeInstruction = Schema.Struct({
  file: RelativePluginPath,
})

const NativeProfile = Schema.Struct({
  label: Schema.optional(NonEmpty),
  /** Apply to every run, before the profiles the user selects. */
  always: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** Restrict an always-on profile to these harnesses; omitted means all. */
  harnesses: Schema.optional(Schema.Array(Identifier).pipe(Schema.minItems(1))),
  instructions: Schema.optionalWith(Schema.Array(Identifier), { default: () => [] }),
  skills: Schema.optionalWith(Schema.Array(NativeSkillSelection), { default: () => [] }),
  plugins: Schema.optionalWith(Schema.Array(NativePluginSelection), { default: () => [] }),
})

const NativeCatalog = Schema.Struct({
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

export const parseTrellageConfig = (source: string): Effect.Effect<TrellageConfig, TrellageConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: () => parse(source),
      catch: () => new TrellageConfigError({ message: "invalid Trellage config: malformed TOML" }),
    })
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
    for (const [profileId, profile] of Object.entries(native.profiles)) {
      for (const selection of [...profile.skills, ...profile.plugins]) {
        if (!Object.hasOwn(native.sources, selection.source)) {
          return yield* new TrellageConfigError({
            message: `invalid [native] configuration: profile ${profileId} references undeclared source ${selection.source}`,
          })
        }
      }
      for (const selection of profile.skills) {
        if (selection.names.includes("*") && (!native.sources[selection.source]?.allowWildcard || selection.names.length !== 1)) {
          return yield* new TrellageConfigError({ message: `invalid [native] configuration: wildcard selection requires explicit source permission and a sole wildcard: ${profileId}/${selection.source}` })
        }
      }
      for (const instruction of profile.instructions) {
        if (!Object.hasOwn(native.instructions, instruction)) {
          return yield* new TrellageConfigError({
            message: `invalid [native] configuration: profile ${profileId} references undeclared instruction ${instruction}`,
          })
        }
      }
    }
    return { schema_version: root.schema_version, environment, native }
  })

export const expandTrellagePath = (candidate: string, home: string, base: string): string => {
  if (candidate === "~") return home
  if (candidate.startsWith("~/")) return path.join(home, candidate.slice(2))
  return path.resolve(base, candidate)
}

export const loadTrellageConfig = (
  location: TrellageConfigLocation = {},
): Effect.Effect<LoadedTrellageConfig, TrellageConfigError> =>
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
    const config = yield* parseTrellageConfig(source ?? "")
    return { path: configPath, present: source !== undefined, config }
  })

export const readTrellageConfig = async (location: TrellageConfigLocation = {}): Promise<LoadedTrellageConfig> => {
  const result = await Effect.runPromise(Effect.either(loadTrellageConfig(location)))
  if (Either.isLeft(result)) throw result.left
  return result.right
}
