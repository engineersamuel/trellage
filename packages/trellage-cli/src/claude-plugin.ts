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
  version: Schema.String,
})

const exactVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"])

const safeKey = (value: string): boolean =>
  safeSegment.test(value) && !dangerousKeys.has(value) && !Object.hasOwn(Object.prototype, value)

export const readClaudeMarketplace = (
  sourceDirectory: string,
  expectedMarketplace: string,
  selections: ReadonlyArray<string>,
): Effect.Effect<Readonly<Record<string, string>>, ClaudePluginError> =>
  Effect.gen(function* () {
    if (!safeKey(expectedMarketplace)) {
      return yield* Effect.fail(new ClaudePluginError({ message: "expected Claude marketplace name is unsafe" }))
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
        const manifestSource = yield* Effect.tryPromise({
          try: () => readFile(path.join(sourceDirectory, ".claude-plugin", "plugin.json"), "utf8"),
          catch: () => new ClaudePluginError({ message: `cannot read Claude plugin metadata: ${plugin.name}` }),
        })
        const manifestValue = yield* Effect.try({
          try: () => {
            assertNoDuplicateJsonKeys(manifestSource)
            return JSON.parse(manifestSource) as unknown
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
