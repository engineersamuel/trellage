import { readFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect, Schema } from "effect"

export class CopilotPluginError extends Data.TaggedError("CopilotPluginError")<{
  readonly message: string
}> {}

const MarketplaceSchema = Schema.Struct({
  name: Schema.String,
  metadata: Schema.Struct({
    description: Schema.String,
    version: Schema.String,
    pluginRoot: Schema.optional(Schema.String),
  }),
  owner: Schema.Struct({
    name: Schema.String,
  }),
  plugins: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Schema.String,
      description: Schema.String,
      version: Schema.String,
      author: Schema.optional(
        Schema.Struct({
          name: Schema.String,
          url: Schema.optional(Schema.String),
        }),
      ),
      homepage: Schema.optional(Schema.String),
      repository: Schema.optional(Schema.String),
      license: Schema.optional(Schema.String),
      keywords: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

const exactVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"])
const maxJsonCharacters = 1_000_000
const maxJsonDepth = 128

const safeKey = (value: string): boolean =>
  safeSegment.test(value) && !dangerousKeys.has(value) && !Object.hasOwn(Object.prototype, value)

const safeSource = (value: string): boolean =>
  value === "." ||
  (safeSegment.test(value) &&
    value !== ".." &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.includes("/") &&
    !value.includes("\\"))

const safeRelativePath = (value: string): boolean => {
  if (value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
    return false
  const segments = value.split("/")
  if (segments[0] === ".") segments.shift()
  return (
    segments.length > 0 && segments.every((segment) => safeSegment.test(segment) && segment !== "." && segment !== "..")
  )
}

export class DuplicateJsonKeyError extends Error {}

type JsonFrame =
  | {
      readonly kind: "object"
      readonly keys: Set<string>
      state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd"
    }
  | {
      readonly kind: "array"
      state: "valueOrEnd" | "value" | "commaOrEnd"
    }

export const assertNoDuplicateJsonKeys = (source: string): void => {
  if (source.length > maxJsonCharacters) throw new Error("JSON input is too large")
  const frames: Array<JsonFrame> = []
  let index = 0
  let rootState: "value" | "end" = "value"

  const invalid = (): never => {
    throw new Error("invalid JSON")
  }
  const skipWhitespace = (): void => {
    while (index < source.length && /[\u0020\u0009\u000a\u000d]/.test(source[index]!)) index += 1
  }
  const stringToken = (): { readonly value: string; readonly end: number } => {
    if (source[index] !== '"') return invalid()
    let cursor = index + 1
    while (cursor < source.length) {
      const character = source[cursor]!
      if (character === '"') {
        const end = cursor + 1
        return { value: JSON.parse(source.slice(index, end)) as string, end }
      }
      if (character.charCodeAt(0) < 0x20) return invalid()
      if (character !== "\\") {
        cursor += 1
        continue
      }
      cursor += 1
      const escape = source[cursor]
      if (escape === undefined) return invalid()
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor + 1, cursor + 5))) return invalid()
        cursor += 5
      } else if ('"\\/bfnrt'.includes(escape)) {
        cursor += 1
      } else {
        return invalid()
      }
    }
    return invalid()
  }
  const value = (): void => {
    const character = source[index]
    if (character === "{") {
      if (frames.length >= maxJsonDepth) return invalid()
      frames.push({ kind: "object", keys: new Set<string>(), state: "keyOrEnd" })
      index += 1
      return
    }
    if (character === "[") {
      if (frames.length >= maxJsonDepth) return invalid()
      frames.push({ kind: "array", state: "valueOrEnd" })
      index += 1
      return
    }
    if (character === '"') {
      index = stringToken().end
      return
    }
    for (const literal of ["true", "false", "null"]) {
      if (source.startsWith(literal, index)) {
        index += literal.length
        return
      }
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0]
    if (number !== undefined) {
      index += number.length
      return
    }
    return invalid()
  }

  while (true) {
    skipWhitespace()
    const frame = frames.at(-1)
    if (frame === undefined) {
      if (rootState === "end") {
        if (index !== source.length) return invalid()
        return
      }
      rootState = "end"
      value()
      continue
    }
    if (frame.kind === "object") {
      if ((frame.state === "keyOrEnd" || frame.state === "key") && source[index] === "}") {
        if (frame.state === "key") return invalid()
        index += 1
        frames.pop()
        continue
      }
      if (frame.state === "keyOrEnd" || frame.state === "key") {
        const key = stringToken()
        if (frame.keys.has(key.value)) throw new DuplicateJsonKeyError("duplicate JSON key")
        frame.keys.add(key.value)
        frame.state = "colon"
        index = key.end
        continue
      }
      if (frame.state === "colon") {
        if (source[index] !== ":") return invalid()
        index += 1
        frame.state = "value"
        continue
      }
      if (frame.state === "value") {
        frame.state = "commaOrEnd"
        value()
        continue
      }
      if (source[index] === ",") {
        index += 1
        frame.state = "key"
        continue
      }
      if (source[index] === "}") {
        index += 1
        frames.pop()
        continue
      }
      return invalid()
    }
    if ((frame.state === "valueOrEnd" || frame.state === "value") && source[index] === "]") {
      if (frame.state === "value") return invalid()
      index += 1
      frames.pop()
      continue
    }
    if (frame.state === "valueOrEnd" || frame.state === "value") {
      frame.state = "commaOrEnd"
      value()
      continue
    }
    if (source[index] === ",") {
      index += 1
      frame.state = "value"
      continue
    }
    if (source[index] === "]") {
      index += 1
      frames.pop()
      continue
    }
    return invalid()
  }
}

export const readCopilotMarketplace = (
  sourceDirectory: string,
  expectedMarketplace: string,
  selections: ReadonlyArray<string>,
): Effect.Effect<Readonly<Record<string, string>>, CopilotPluginError> =>
  Effect.gen(function* () {
    if (!safeKey(expectedMarketplace)) {
      return yield* Effect.fail(new CopilotPluginError({ message: "expected marketplace name is unsafe" }))
    }
    const source = yield* Effect.tryPromise({
      try: () => readFile(path.join(sourceDirectory, ".github", "plugin", "marketplace.json"), "utf8"),
      catch: () => new CopilotPluginError({ message: "cannot read Copilot marketplace metadata" }),
    })
    const value = yield* Effect.try({
      try: () => {
        assertNoDuplicateJsonKeys(source)
        return JSON.parse(source) as unknown
      },
      catch: (cause) =>
        new CopilotPluginError({
          message: cause instanceof DuplicateJsonKeyError ? cause.message : "Copilot marketplace metadata is invalid",
        }),
    })
    const metadata = yield* Schema.decodeUnknown(MarketplaceSchema)(value, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new CopilotPluginError({ message: "Copilot marketplace metadata is invalid" })))
    if (!safeKey(metadata.name)) {
      return yield* Effect.fail(new CopilotPluginError({ message: "Copilot marketplace name is unsafe" }))
    }
    if (metadata.name !== expectedMarketplace) {
      return yield* Effect.fail(
        new CopilotPluginError({ message: "Copilot marketplace name does not match selection" }),
      )
    }
    if (metadata.metadata.description.length === 0) {
      return yield* Effect.fail(new CopilotPluginError({ message: "Copilot marketplace description is empty" }))
    }
    if (!exactVersion.test(metadata.metadata.version)) {
      return yield* Effect.fail(
        new CopilotPluginError({ message: "Copilot marketplace metadata version is not exact" }),
      )
    }
    if (metadata.metadata.pluginRoot !== undefined && !safeRelativePath(metadata.metadata.pluginRoot)) {
      return yield* Effect.fail(new CopilotPluginError({ message: "Copilot marketplace pluginRoot is unsafe" }))
    }
    if (metadata.owner.name.length === 0) {
      return yield* Effect.fail(new CopilotPluginError({ message: "Copilot marketplace owner name is empty" }))
    }
    const plugins = new Map<string, { readonly version: string }>()
    for (const plugin of metadata.plugins) {
      if (!safeKey(plugin.name)) {
        return yield* Effect.fail(new CopilotPluginError({ message: `Copilot plugin name is unsafe: ${plugin.name}` }))
      }
      if (!safeSource(plugin.source)) {
        return yield* Effect.fail(
          new CopilotPluginError({ message: `Copilot plugin source is unsafe: ${plugin.name}` }),
        )
      }
      if (plugin.description.length === 0) {
        return yield* Effect.fail(
          new CopilotPluginError({ message: `Copilot plugin description is empty: ${plugin.name}` }),
        )
      }
      if (!exactVersion.test(plugin.version)) {
        return yield* Effect.fail(
          new CopilotPluginError({ message: `Copilot plugin version is not exact: ${plugin.name}` }),
        )
      }
      if (plugins.has(plugin.name)) {
        return yield* Effect.fail(new CopilotPluginError({ message: `duplicate plugin: ${plugin.name}` }))
      }
      plugins.set(plugin.name, { version: plugin.version })
    }
    if (selections.length === 0) {
      return yield* Effect.fail(new CopilotPluginError({ message: "Copilot plugin selection is empty" }))
    }
    const selected = new Set<string>()
    for (const selection of selections) {
      if (!safeKey(selection)) {
        return yield* Effect.fail(
          new CopilotPluginError({ message: `Copilot plugin selection is unsafe: ${selection}` }),
        )
      }
      if (selected.has(selection)) {
        return yield* Effect.fail(new CopilotPluginError({ message: `duplicate selection: ${selection}` }))
      }
      selected.add(selection)
    }
    const output = Object.create(null) as Record<string, string>
    for (const selection of [...selected].sort((left, right) => left.localeCompare(right, "en"))) {
      const plugin = plugins.get(selection)
      if (plugin === undefined) {
        return yield* Effect.fail(
          new CopilotPluginError({ message: `Copilot plugin selection is missing: ${selection}` }),
        )
      }
      output[selection] = plugin.version
    }
    return Object.freeze(output)
  })
