import { readFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect, Schema } from "effect"

import { assertNoDuplicateJsonKeys, DuplicateJsonKeyError } from "./copilot-plugin.js"

export class ClaudePluginError extends Data.TaggedError("ClaudePluginError")<{
  readonly message: string
}> {}

const MarketplaceSchema = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({
    name: Schema.String,
    url: Schema.optional(Schema.String),
  }),
  plugins: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Schema.optional(Schema.Unknown),
      description: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      metadata: Schema.optional(Schema.Unknown),
    }),
  ),
})

const PluginManifestSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
})

const exactVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const taggedSemverRef = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"])

const safeKey = (value: string): boolean =>
  safeSegment.test(value) && !dangerousKeys.has(value) && !Object.hasOwn(Object.prototype, value)

const isSafeClaudePluginSource = (value: string): boolean => {
  if (value === "." || value === "./") return true
  if (value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return false
  }
  const segments = value.split("/")
  if (segments.includes("")) return false
  if (segments[0] === ".") segments.shift()
  return (
    segments.length > 0 && segments.every((segment) => safeSegment.test(segment) && segment !== "." && segment !== "..")
  )
}

const pluginRootForSource = (sourceDirectory: string, source: string): string => {
  if (source === "." || source === "./") return sourceDirectory
  const relative = source.startsWith("./") ? source.slice(2) : source
  return path.join(sourceDirectory, ...relative.split("/"))
}

/** Normalize a pinned git tag/ref (`v1.10.0` or `1.10.0`) into an exact plugin semver for lock-time fallback. */
export const pluginVersionFromRef = (ref: string): string | undefined => {
  const match = taggedSemverRef.exec(ref)
  return match?.[1]
}

export type ReadClaudeMarketplaceOptions = {
  /**
   * Used only when marketplace.json and plugin.json both omit an exact version.
   * Intended for lock-time injection from a pinned semver git tag (e.g. caveman@v1.10.0).
   */
  readonly versionFallback?: string
}

type ClaudeMarketplace = Schema.Schema.Type<typeof MarketplaceSchema>

const parseJsonObject = (source: string, invalidMessage: string): Effect.Effect<unknown, ClaudePluginError> =>
  Effect.try({
    try: () => {
      assertNoDuplicateJsonKeys(source)
      return JSON.parse(source) as unknown
    },
    catch: (cause) =>
      new ClaudePluginError({
        message: cause instanceof DuplicateJsonKeyError ? cause.message : invalidMessage,
      }),
  })

const decodeClaudeMarketplace = (
  source: string,
  expectedMarketplace: string,
): Effect.Effect<ClaudeMarketplace, ClaudePluginError> =>
  Effect.gen(function* () {
    const value = yield* parseJsonObject(source, "Claude marketplace metadata is invalid")
    const metadata = yield* Schema.decodeUnknown(MarketplaceSchema)(value).pipe(
      Effect.mapError(() => new ClaudePluginError({ message: "Claude marketplace metadata is invalid" })),
    )
    if (!safeKey(metadata.name)) {
      return yield* Effect.fail(new ClaudePluginError({ message: "Claude marketplace name is unsafe" }))
    }
    if (metadata.name !== expectedMarketplace) {
      return yield* Effect.fail(new ClaudePluginError({ message: "Claude marketplace name does not match selection" }))
    }
    if (metadata.owner.name.length === 0) {
      return yield* Effect.fail(new ClaudePluginError({ message: "Claude marketplace owner name is empty" }))
    }
    return metadata
  })

const readPluginJsonMarketplace = (
  sourceDirectory: string,
  expectedMarketplace: string,
): Effect.Effect<ClaudeMarketplace, ClaudePluginError> =>
  Effect.gen(function* () {
    const manifestSource = yield* Effect.tryPromise({
      try: () => readFile(path.join(sourceDirectory, ".claude-plugin", "plugin.json"), "utf8"),
      catch: () => new ClaudePluginError({ message: "cannot read Claude marketplace metadata" }),
    })
    const value = yield* parseJsonObject(manifestSource, "Claude plugin metadata is invalid")
    const manifest = yield* Schema.decodeUnknown(PluginManifestSchema)(value).pipe(
      Effect.mapError(() => new ClaudePluginError({ message: "Claude plugin metadata is invalid" })),
    )
    if (!safeKey(manifest.name)) {
      return yield* Effect.fail(new ClaudePluginError({ message: "Claude plugin name is unsafe" }))
    }
    if (manifest.name !== expectedMarketplace) {
      return yield* Effect.fail(new ClaudePluginError({ message: "Claude marketplace name does not match selection" }))
    }
    const record = value as { description?: unknown; author?: { name?: unknown } }
    const description = typeof record.description === "string" ? record.description : ""
    const ownerName = typeof record.author?.name === "string" ? record.author.name : manifest.name
    return {
      name: manifest.name,
      owner: { name: ownerName },
      plugins: [
        {
          name: manifest.name,
          source: ".",
          description,
          version: manifest.version,
        },
      ],
    }
  })

const readOptionalUtf8 = (
  filePath: string,
  missingMessage: string,
): Effect.Effect<string | undefined, ClaudePluginError> =>
  Effect.tryPromise({
    try: async (): Promise<string | undefined> => {
      try {
        return await readFile(filePath, "utf8")
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw cause
      }
    },
    catch: () => new ClaudePluginError({ message: missingMessage }),
  })

const loadClaudeMarketplace = (
  sourceDirectory: string,
  expectedMarketplace: string,
): Effect.Effect<ClaudeMarketplace, ClaudePluginError> =>
  Effect.gen(function* () {
    const marketplaceSource = yield* readOptionalUtf8(
      path.join(sourceDirectory, ".claude-plugin", "marketplace.json"),
      "cannot read Claude marketplace metadata",
    )
    return marketplaceSource === undefined
      ? yield* readPluginJsonMarketplace(sourceDirectory, expectedMarketplace)
      : yield* decodeClaudeMarketplace(marketplaceSource, expectedMarketplace)
  })

type NestedPluginManifest = { readonly found: false } | { readonly found: true; readonly version: string | undefined }

const nestedPluginManifestVersion = (
  sourceDirectory: string,
  source: string,
  pluginName: string,
): Effect.Effect<NestedPluginManifest, ClaudePluginError> =>
  Effect.gen(function* () {
    const optionalManifest = yield* readOptionalUtf8(
      path.join(pluginRootForSource(sourceDirectory, source), ".claude-plugin", "plugin.json"),
      `cannot read Claude plugin metadata: ${pluginName}`,
    )
    if (optionalManifest === undefined) return { found: false }
    const manifestValue = yield* parseJsonObject(optionalManifest, `Claude plugin metadata is invalid: ${pluginName}`)
    const manifest = yield* Schema.decodeUnknown(PluginManifestSchema)(manifestValue).pipe(
      Effect.mapError(() => new ClaudePluginError({ message: `Claude plugin metadata is invalid: ${pluginName}` })),
    )
    if (manifest.name !== pluginName) {
      return yield* Effect.fail(
        new ClaudePluginError({ message: `Claude plugin metadata name does not match: ${pluginName}` }),
      )
    }
    return { found: true, version: manifest.version }
  })

const exactPluginVersion = (
  pluginName: string,
  declared: string | undefined,
  fallback: string | undefined,
): Effect.Effect<string, ClaudePluginError> => {
  const version = declared ?? fallback
  if (version === undefined) {
    return Effect.fail(new ClaudePluginError({ message: `Claude plugin version is missing: ${pluginName}` }))
  }
  if (!exactVersion.test(version)) {
    return Effect.fail(new ClaudePluginError({ message: `Claude plugin version is not exact: ${pluginName}` }))
  }
  return Effect.succeed(version)
}

const selectedPluginVersion = (
  sourceDirectory: string,
  plugin: ClaudeMarketplace["plugins"][number],
  fallback: string | undefined,
): Effect.Effect<string, ClaudePluginError> =>
  Effect.gen(function* () {
    if (typeof plugin.source !== "string" || !isSafeClaudePluginSource(plugin.source)) {
      return yield* Effect.fail(
        new ClaudePluginError({
          message: `Claude plugin source must be a relative marketplace path: ${plugin.name}`,
        }),
      )
    }
    if (plugin.description === undefined || plugin.description.length === 0) {
      return yield* Effect.fail(
        new ClaudePluginError({ message: `Claude plugin description is empty: ${plugin.name}` }),
      )
    }
    if (plugin.version !== undefined) {
      return yield* exactPluginVersion(plugin.name, plugin.version, fallback)
    }
    const nested = yield* nestedPluginManifestVersion(sourceDirectory, plugin.source, plugin.name)
    if (!nested.found && fallback === undefined) {
      return yield* Effect.fail(
        new ClaudePluginError({ message: `cannot read Claude plugin metadata: ${plugin.name}` }),
      )
    }
    return yield* exactPluginVersion(plugin.name, nested.found ? nested.version : undefined, fallback)
  })

const collectSelectedPluginVersions = (
  sourceDirectory: string,
  metadata: ClaudeMarketplace,
  selections: ReadonlyArray<string>,
  fallback: string | undefined,
): Effect.Effect<Map<string, string>, ClaudePluginError> =>
  Effect.gen(function* () {
    const requested = new Set(selections)
    const plugins = new Map<string, string>()
    const seen = new Set<string>()
    for (const plugin of metadata.plugins) {
      if (!safeKey(plugin.name)) {
        return yield* Effect.fail(new ClaudePluginError({ message: `Claude plugin name is unsafe: ${plugin.name}` }))
      }
      if (seen.has(plugin.name)) {
        return yield* Effect.fail(new ClaudePluginError({ message: `duplicate plugin: ${plugin.name}` }))
      }
      seen.add(plugin.name)
      if (!requested.has(plugin.name)) continue
      plugins.set(plugin.name, yield* selectedPluginVersion(sourceDirectory, plugin, fallback))
    }
    return plugins
  })

const freezeSelectedVersions = (
  selections: ReadonlyArray<string>,
  plugins: Map<string, string>,
): Effect.Effect<Readonly<Record<string, string>>, ClaudePluginError> =>
  Effect.gen(function* () {
    if (selections.length === 0) {
      return yield* Effect.fail(new ClaudePluginError({ message: "Claude plugin selection is empty" }))
    }
    const selected = new Set<string>()
    for (const selection of selections) {
      if (!safeKey(selection)) {
        return yield* Effect.fail(new ClaudePluginError({ message: `Claude plugin selection is unsafe: ${selection}` }))
      }
      if (selected.has(selection)) {
        return yield* Effect.fail(new ClaudePluginError({ message: `duplicate selection: ${selection}` }))
      }
      selected.add(selection)
    }
    const output = Object.create(null) as Record<string, string>
    for (const selection of [...selected].sort((left, right) => left.localeCompare(right, "en"))) {
      const version = plugins.get(selection)
      if (version === undefined) {
        return yield* Effect.fail(
          new ClaudePluginError({ message: `Claude plugin selection is missing: ${selection}` }),
        )
      }
      output[selection] = version
    }
    return Object.freeze(output)
  })

export const readClaudeMarketplace = (
  sourceDirectory: string,
  expectedMarketplace: string,
  selections: ReadonlyArray<string>,
  options?: ReadClaudeMarketplaceOptions,
): Effect.Effect<Readonly<Record<string, string>>, ClaudePluginError> =>
  Effect.gen(function* () {
    if (!safeKey(expectedMarketplace)) {
      return yield* Effect.fail(new ClaudePluginError({ message: "expected Claude marketplace name is unsafe" }))
    }
    const fallback = options?.versionFallback
    if (fallback !== undefined && !exactVersion.test(fallback)) {
      return yield* Effect.fail(new ClaudePluginError({ message: "Claude plugin version fallback is not exact" }))
    }
    const metadata = yield* loadClaudeMarketplace(sourceDirectory, expectedMarketplace)
    const plugins = yield* collectSelectedPluginVersions(sourceDirectory, metadata, selections, fallback)
    return yield* freezeSelectedVersions(selections, plugins)
  })
