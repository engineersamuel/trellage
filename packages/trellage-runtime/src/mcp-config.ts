import { Schema } from "effect"

const NonEmpty = Schema.String.pipe(Schema.minLength(1))
const Identifier = Schema.String.pipe(Schema.pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
const EnvironmentName = Schema.String.pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]*$/))
const HeaderName = Schema.String.pipe(Schema.pattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/))
const NoNull = Schema.String.pipe(Schema.filter((value) => !value.includes("\0")))
const NoControls = Schema.String.pipe(
  Schema.filter((value) =>
    [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
  ),
)
const Command = NonEmpty.pipe(
  Schema.filter((value) => value.trim().length > 0),
  Schema.compose(NoControls),
)
const RemoteUrl = NonEmpty.pipe(
  Schema.filter((value) => {
    if (!/^https?:\/\//.test(value) || /\s/.test(value)) return false
    if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) return false
    try {
      const url = new URL(value)
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0
    } catch {
      return false
    }
  }),
)
const Enabled = Schema.optionalWith(Schema.Boolean, { default: () => true })
const Headers = Schema.optionalWith(Schema.Record({ key: HeaderName, value: NoControls }), {
  default: () => ({}),
})

/** Common server definitions preserve ${ENV_VAR} references; only launch code resolves them. */
export const McpServer = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("stdio"),
    enabled: Enabled,
    command: Command,
    args: Schema.optionalWith(Schema.Array(NoNull), { default: () => [] }),
    env: Schema.optionalWith(Schema.Record({ key: EnvironmentName, value: NoNull }), {
      default: () => ({}),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("http"),
    enabled: Enabled,
    url: RemoteUrl,
    headers: Headers,
  }),
  Schema.Struct({
    type: Schema.Literal("sse"),
    enabled: Enabled,
    url: RemoteUrl,
    headers: Headers,
  }),
)

/** Every enabled entry is common to all non-clean Native launches. */
export const McpConfig = Schema.Struct({
  servers: Schema.optionalWith(Schema.Record({ key: Identifier, value: McpServer }), {
    default: () => ({}),
  }),
})

export type McpServer = Schema.Schema.Type<typeof McpServer>
export type McpConfig = Schema.Schema.Type<typeof McpConfig>
