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
      source: Schema.String,
      description: Schema.String,
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
    const source = yield* Effect.tryPromise({
      try: () => readFile(path.join(sourceDirectory, ".claude-plugin", "marketplace.json"), "utf8"),
      catch: () => new ClaudePluginError({ message: "cannot read Claude marketplace metadata" }),
    })
    const value = yield* Effect.try({
      try: () => {
        assertNoDuplicateJsonKeys(source)
        return JSON.parse(source) as unknown
      },
      catch: (cause) =>
        new ClaudePluginError({
          message: cause instanceof DuplicateJsonKeyError ? cause.message : "Claude marketplace metadata is invalid",
        }),
    })
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
    const plugins = new Map<string, string>()
    for (const plugin of metadata.plugins) {
      if (!safeKey(plugin.name)) {
        return yield* Effect.fail(new ClaudePluginError({ message: `Claude plugin name is unsafe: ${plugin.name}` }))
      }
      if (plugin.source !== "." && plugin.source !== "./") {
        return yield* Effect.fail(
          new ClaudePluginError({ message: `Claude plugin source must be the marketplace root: ${plugin.name}` }),
        )
      }
      if (plugin.description.length === 0) {
        return yield* Effect.fail(
          new ClaudePluginError({ message: `Claude plugin description is empty: ${plugin.name}` }),
        )
      }
      let version = plugin.version
      if (version === undefined) {
        const manifestPath = path.join(sourceDirectory, ".claude-plugin", "plugin.json")
        const optionalManifest = yield* Effect.tryPromise({
          try: async (): Promise<string | undefined> => {
            try {
              return await readFile(manifestPath, "utf8")
            } catch {
              return undefined
            }
          },
          catch: () => new ClaudePluginError({ message: `cannot read Claude plugin metadata: ${plugin.name}` }),
        })
        if (optionalManifest === undefined) {
          if (fallback === undefined) {
            return yield* Effect.fail(
              new ClaudePluginError({ message: `cannot read Claude plugin metadata: ${plugin.name}` }),
            )
          }
        } else {
          const manifestValue = yield* Effect.try({
            try: () => {
              assertNoDuplicateJsonKeys(optionalManifest)
              return JSON.parse(optionalManifest) as unknown
            },
            catch: (cause) =>
              new ClaudePluginError({
                message:
                  cause instanceof DuplicateJsonKeyError
                    ? cause.message
                    : `Claude plugin metadata is invalid: ${plugin.name}`,
              }),
          })
          const manifest = yield* Schema.decodeUnknown(PluginManifestSchema)(manifestValue).pipe(
            Effect.mapError(
              () => new ClaudePluginError({ message: `Claude plugin metadata is invalid: ${plugin.name}` }),
            ),
          )
          if (manifest.name !== plugin.name) {
            return yield* Effect.fail(
              new ClaudePluginError({ message: `Claude plugin metadata name does not match: ${plugin.name}` }),
            )
          }
          version = manifest.version
        }
      }
      if (version === undefined) {
        if (fallback === undefined) {
          return yield* Effect.fail(
            new ClaudePluginError({ message: `Claude plugin version is missing: ${plugin.name}` }),
          )
        }
        version = fallback
      }
      if (!exactVersion.test(version)) {
        return yield* Effect.fail(
          new ClaudePluginError({ message: `Claude plugin version is not exact: ${plugin.name}` }),
        )
      }
      if (plugins.has(plugin.name)) {
        return yield* Effect.fail(new ClaudePluginError({ message: `duplicate plugin: ${plugin.name}` }))
      }
      plugins.set(plugin.name, version)
    }
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
