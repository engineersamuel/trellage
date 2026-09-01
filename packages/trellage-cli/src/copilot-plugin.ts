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

type JsonObjectFrame = {
  readonly kind: "object"
  readonly keys: Set<string>
  state: "keyOrEnd" | "key" | "colon" | "value" | "commaOrEnd"
}

type JsonArrayFrame = {
  readonly kind: "array"
  state: "valueOrEnd" | "value" | "commaOrEnd"
}

type JsonFrame = JsonObjectFrame | JsonArrayFrame

type JsonParser = {
  readonly source: string
  readonly frames: Array<JsonFrame>
  index: number
  rootState: "value" | "end"
}

const invalidJson = (): never => {
  throw new Error("invalid JSON")
}

const skipJsonWhitespace = (parser: JsonParser): void => {
  while (parser.index < parser.source.length && /[\u0020\u0009\u000a\u000d]/.test(parser.source[parser.index]!)) {
    parser.index += 1
  }
}

const jsonEscapeEnd = (source: string, cursor: number): number => {
  const escape = source[cursor]
  if (escape === undefined) return invalidJson()
  if (escape === "u") {
    if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor + 1, cursor + 5))) return invalidJson()
    return cursor + 5
  }
  if (!'"\\/bfnrt'.includes(escape)) return invalidJson()
  return cursor + 1
}

const readJsonStringToken = (parser: JsonParser): { readonly value: string; readonly end: number } => {
  if (parser.source[parser.index] !== '"') return invalidJson()
  let cursor = parser.index + 1
  while (cursor < parser.source.length) {
    const character = parser.source[cursor]!
    if (character === '"') {
      const end = cursor + 1
      return { value: JSON.parse(parser.source.slice(parser.index, end)) as string, end }
    }
    if (character.charCodeAt(0) < 0x20) return invalidJson()
    cursor = character === "\\" ? jsonEscapeEnd(parser.source, cursor + 1) : cursor + 1
  }
  return invalidJson()
}

const pushJsonObjectFrame = (parser: JsonParser): void => {
  if (parser.frames.length >= maxJsonDepth) return invalidJson()
  parser.frames.push({ kind: "object", keys: new Set<string>(), state: "keyOrEnd" })
  parser.index += 1
}

const pushJsonArrayFrame = (parser: JsonParser): void => {
  if (parser.frames.length >= maxJsonDepth) return invalidJson()
  parser.frames.push({ kind: "array", state: "valueOrEnd" })
  parser.index += 1
}

const readJsonValue = (parser: JsonParser): void => {
  const character = parser.source[parser.index]
  if (character === "{") return pushJsonObjectFrame(parser)
  if (character === "[") return pushJsonArrayFrame(parser)
  if (character === '"') {
    parser.index = readJsonStringToken(parser).end
    return
  }
  for (const literal of ["true", "false", "null"]) {
    if (parser.source.startsWith(literal, parser.index)) {
      parser.index += literal.length
      return
    }
  }
  const number = parser.source.slice(parser.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0]
  if (number === undefined) return invalidJson()
  parser.index += number.length
}

const closeJsonFrame = (parser: JsonParser): void => {
  parser.index += 1
  parser.frames.pop()
}

const readJsonObjectKey = (parser: JsonParser, frame: JsonObjectFrame, allowEnd: boolean): void => {
  if (parser.source[parser.index] === "}") {
    if (!allowEnd) return invalidJson()
    closeJsonFrame(parser)
    return
  }
  const key = readJsonStringToken(parser)
  if (frame.keys.has(key.value)) throw new DuplicateJsonKeyError("duplicate JSON key")
  frame.keys.add(key.value)
  frame.state = "colon"
  parser.index = key.end
}

const readJsonObjectEnd = (parser: JsonParser, frame: JsonObjectFrame): void => {
  if (parser.source[parser.index] === ",") {
    parser.index += 1
    frame.state = "key"
    return
  }
  if (parser.source[parser.index] !== "}") return invalidJson()
  closeJsonFrame(parser)
}

const advanceJsonObject = (parser: JsonParser, frame: JsonObjectFrame): void => {
  switch (frame.state) {
    case "keyOrEnd":
      return readJsonObjectKey(parser, frame, true)
    case "key":
      return readJsonObjectKey(parser, frame, false)
    case "colon":
      if (parser.source[parser.index] !== ":") return invalidJson()
      parser.index += 1
      frame.state = "value"
      return
    case "value":
      frame.state = "commaOrEnd"
      return readJsonValue(parser)
    default:
      return readJsonObjectEnd(parser, frame)
  }
}

const readJsonArrayValue = (parser: JsonParser, frame: JsonArrayFrame, allowEnd: boolean): void => {
  if (parser.source[parser.index] === "]") {
    if (!allowEnd) return invalidJson()
    closeJsonFrame(parser)
    return
  }
  frame.state = "commaOrEnd"
  readJsonValue(parser)
}

const readJsonArrayEnd = (parser: JsonParser, frame: JsonArrayFrame): void => {
  if (parser.source[parser.index] === ",") {
    parser.index += 1
    frame.state = "value"
    return
  }
  if (parser.source[parser.index] !== "]") return invalidJson()
  closeJsonFrame(parser)
}

const advanceJsonArray = (parser: JsonParser, frame: JsonArrayFrame): void => {
  switch (frame.state) {
    case "valueOrEnd":
      return readJsonArrayValue(parser, frame, true)
    case "value":
      return readJsonArrayValue(parser, frame, false)
    default:
      return readJsonArrayEnd(parser, frame)
  }
}

export const assertNoDuplicateJsonKeys = (source: string): void => {
  if (source.length > maxJsonCharacters) throw new Error("JSON input is too large")
  const parser: JsonParser = { source, index: 0, frames: [], rootState: "value" }
  while (true) {
    skipJsonWhitespace(parser)
    const frame = parser.frames.at(-1)
    if (frame !== undefined) {
      if (frame.kind === "object") advanceJsonObject(parser, frame)
      else advanceJsonArray(parser, frame)
      continue
    }
    if (parser.rootState === "end") {
      if (parser.index !== source.length) return invalidJson()
      return
    }
    parser.rootState = "end"
    readJsonValue(parser)
  }
}

type CopilotMarketplace = Schema.Schema.Type<typeof MarketplaceSchema>
type CopilotMarketplacePlugin = CopilotMarketplace["plugins"][number]

const pluginFailure = (message: string): Effect.Effect<never, CopilotPluginError> =>
  Effect.fail(new CopilotPluginError({ message }))

const validateExpectedMarketplace = (expectedMarketplace: string): Effect.Effect<void, CopilotPluginError> =>
  safeKey(expectedMarketplace) ? Effect.void : pluginFailure("expected marketplace name is unsafe")

const readMarketplaceJson = (sourceDirectory: string): Effect.Effect<string, CopilotPluginError> =>
  Effect.tryPromise({
    try: () => readFile(path.join(sourceDirectory, ".github", "plugin", "marketplace.json"), "utf8"),
    catch: () => new CopilotPluginError({ message: "cannot read Copilot marketplace metadata" }),
  })

const parseMarketplaceJson = (source: string): Effect.Effect<unknown, CopilotPluginError> =>
  Effect.try({
    try: () => {
      assertNoDuplicateJsonKeys(source)
      return JSON.parse(source) as unknown
    },
    catch: (cause) =>
      new CopilotPluginError({
        message: cause instanceof DuplicateJsonKeyError ? cause.message : "Copilot marketplace metadata is invalid",
      }),
  })

const decodeMarketplace = (value: unknown): Effect.Effect<CopilotMarketplace, CopilotPluginError> =>
  Schema.decodeUnknown(MarketplaceSchema)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new CopilotPluginError({ message: "Copilot marketplace metadata is invalid" })))

const validateMarketplaceMetadata = (
  marketplace: CopilotMarketplace,
  expectedMarketplace: string,
): Effect.Effect<void, CopilotPluginError> =>
  Effect.gen(function* () {
    if (!safeKey(marketplace.name)) {
      return yield* pluginFailure("Copilot marketplace name is unsafe")
    }
    if (marketplace.name !== expectedMarketplace) {
      return yield* pluginFailure("Copilot marketplace name does not match selection")
    }
    if (marketplace.metadata.description.length === 0) {
      return yield* pluginFailure("Copilot marketplace description is empty")
    }
    if (!exactVersion.test(marketplace.metadata.version)) {
      return yield* pluginFailure("Copilot marketplace metadata version is not exact")
    }
    if (marketplace.metadata.pluginRoot !== undefined && !safeRelativePath(marketplace.metadata.pluginRoot)) {
      return yield* pluginFailure("Copilot marketplace pluginRoot is unsafe")
    }
    if (marketplace.owner.name.length === 0) {
      return yield* pluginFailure("Copilot marketplace owner name is empty")
    }
  })

const validateMarketplacePlugin = (plugin: CopilotMarketplacePlugin): Effect.Effect<void, CopilotPluginError> =>
  Effect.gen(function* () {
    if (!safeKey(plugin.name)) {
      return yield* pluginFailure(`Copilot plugin name is unsafe: ${plugin.name}`)
    }
    if (!safeSource(plugin.source)) {
      return yield* pluginFailure(`Copilot plugin source is unsafe: ${plugin.name}`)
    }
    if (plugin.description.length === 0) {
      return yield* pluginFailure(`Copilot plugin description is empty: ${plugin.name}`)
    }
    if (!exactVersion.test(plugin.version)) {
      return yield* pluginFailure(`Copilot plugin version is not exact: ${plugin.name}`)
    }
  })

const collectMarketplacePlugins = (
  marketplace: CopilotMarketplace,
): Effect.Effect<ReadonlyMap<string, string>, CopilotPluginError> =>
  Effect.gen(function* () {
    const plugins = new Map<string, string>()
    for (const plugin of marketplace.plugins) {
      yield* validateMarketplacePlugin(plugin)
      if (plugins.has(plugin.name)) {
        return yield* pluginFailure(`duplicate plugin: ${plugin.name}`)
      }
      plugins.set(plugin.name, plugin.version)
    }
    return plugins
  })

const collectPluginSelections = (
  selections: ReadonlyArray<string>,
): Effect.Effect<ReadonlySet<string>, CopilotPluginError> =>
  Effect.gen(function* () {
    if (selections.length === 0) {
      return yield* pluginFailure("Copilot plugin selection is empty")
    }
    const selected = new Set<string>()
    for (const selection of selections) {
      if (!safeKey(selection)) {
        return yield* pluginFailure(`Copilot plugin selection is unsafe: ${selection}`)
      }
      if (selected.has(selection)) {
        return yield* pluginFailure(`duplicate selection: ${selection}`)
      }
      selected.add(selection)
    }
    return selected
  })

const selectPluginVersions = (
  plugins: ReadonlyMap<string, string>,
  selected: ReadonlySet<string>,
): Effect.Effect<Readonly<Record<string, string>>, CopilotPluginError> =>
  Effect.gen(function* () {
    const output = Object.create(null) as Record<string, string>
    for (const selection of [...selected].sort((left, right) => left.localeCompare(right, "en"))) {
      const version = plugins.get(selection)
      if (version === undefined) {
        return yield* pluginFailure(`Copilot plugin selection is missing: ${selection}`)
      }
      output[selection] = version
    }
    return Object.freeze(output)
  })

export const readCopilotMarketplace = (
  sourceDirectory: string,
  expectedMarketplace: string,
  selections: ReadonlyArray<string>,
): Effect.Effect<Readonly<Record<string, string>>, CopilotPluginError> =>
  Effect.gen(function* () {
    yield* validateExpectedMarketplace(expectedMarketplace)
    const source = yield* readMarketplaceJson(sourceDirectory)
    const value = yield* parseMarketplaceJson(source)
    const marketplace = yield* decodeMarketplace(value)
    yield* validateMarketplaceMetadata(marketplace, expectedMarketplace)
    const plugins = yield* collectMarketplacePlugins(marketplace)
    const selected = yield* collectPluginSelections(selections)
    return yield* selectPluginVersions(plugins, selected)
  })
