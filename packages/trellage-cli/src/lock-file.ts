import { parse } from "smol-toml"
import { Data, Effect, ParseResult, Schema } from "effect"

import {
  hasLegacyPackageProvenance,
  hasLegacySourceProvenance,
  markPersistedLock,
  markParsedLegacyProvenance,
  type ProfileLock,
} from "./lock.js"

const quote = (value: string): string => JSON.stringify(value)
const strings = (values: ReadonlyArray<string>): string => `[${values.map(quote).join(", ")}]`
const stringRecord = (values: Readonly<Record<string, string>>): string =>
  `{ ${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${quote(key)} = ${quote(value)}`)
    .join(", ")} }`

const sortedFrozenRecord = (values: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  const sorted = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    sorted[key] = value
  }
  return Object.freeze(sorted)
}

const renderSourceFile = (
  lock: ProfileLock,
  sourceIndex: number,
  file: ProfileLock["sources"][number]["files"][number],
): ReadonlyArray<string> => {
  if (file.kind === "symlink") {
    return [
      "",
      "[[sources.files]]",
      `kind = ${quote(file.kind)}`,
      `path = ${quote(file.path)}`,
      `target = ${quote(file.target)}`,
    ]
  }
  const kind =
    lock.packages.harness.kind === "codex" && !hasLegacySourceProvenance(lock, sourceIndex)
      ? [`kind = ${quote(file.kind)}`]
      : []
  return [
    "",
    "[[sources.files]]",
    ...kind,
    `path = ${quote(file.path)}`,
    `sha256 = ${quote(file.sha256)}`,
    ...(file.executable === true ? ["executable = true"] : []),
  ]
}

const renderSource = (
  lock: ProfileLock,
  sourceIndex: number,
  source: ProfileLock["sources"][number],
): ReadonlyArray<string> => [
  "",
  "[[sources]]",
  `kind = ${quote(source.kind)}`,
  ...(source.adapter ? [`adapter = ${quote(source.adapter)}`] : []),
  ...(source.marketplace ? [`marketplace = ${quote(source.marketplace)}`] : []),
  ...(source.plugin_versions ? [`plugin_versions = ${stringRecord(source.plugin_versions)}`] : []),
  ...(source.package_version ? [`package_version = ${quote(source.package_version)}`] : []),
  `repository = ${quote(source.repository)}`,
  `ref = ${quote(source.ref)}`,
  `select = ${strings(source.select)}`,
  `commit = ${quote(source.commit)}`,
  `integrity = ${quote(source.integrity)}`,
  ...(source.files.length === 0 ? ["files = []"] : []),
  ...source.files.flatMap((file) => renderSourceFile(lock, sourceIndex, file)),
]

const renderLegacyHarness = (lock: ProfileLock): ReadonlyArray<string> => {
  const harness = lock.packages.harness
  if (harness.kind !== "codex" || !hasLegacyPackageProvenance(lock)) return []
  return [
    `codex = ${quote(harness.version)}`,
    `codex_integrity = ${quote(harness.integrity)}`,
    `codex_url = ${quote(harness.url)}`,
    `codex_size = ${harness.size}`,
  ]
}

const renderHarness = (lock: ProfileLock): ReadonlyArray<string> => {
  const harness = lock.packages.harness
  if (harness.kind === "codex" && hasLegacyPackageProvenance(lock)) return []
  if (harness.kind === "headlong") {
    return [
      "",
      "[packages.harness]",
      `kind = ${quote(harness.kind)}`,
      `selector = ${quote(harness.selector)}`,
      `commit = ${quote(harness.commit)}`,
      `integrity = ${quote(harness.integrity)}`,
    ]
  }
  return [
    "",
    "[packages.harness]",
    `kind = ${quote(harness.kind)}`,
    `selector = ${quote(harness.selector)}`,
    `version = ${quote(harness.version)}`,
    `integrity = ${quote(harness.integrity)}`,
    `url = ${quote(harness.url)}`,
    `size = ${harness.size}`,
  ]
}

const renderRuntime = (runtime: ProfileLock["packages"]["runtime"][number]): ReadonlyArray<string> => [
  "",
  "[[packages.runtime]]",
  `name = ${quote(runtime.name)}`,
  `version = ${quote(runtime.version)}`,
  `integrity = ${quote(runtime.integrity)}`,
  ...(runtime.size === undefined ? [] : [`size = ${runtime.size}`]),
  ...(runtime.url === undefined ? [] : [`url = ${quote(runtime.url)}`]),
  ...(runtime.direct === undefined ? [] : [`direct = ${runtime.direct}`]),
]

const renderArtifact = (artifact: NonNullable<ProfileLock["packages"]["artifacts"]>[number]): ReadonlyArray<string> => [
  "",
  "[[packages.artifacts]]",
  `name = ${quote(artifact.name)}`,
  `version = ${quote(artifact.version)}`,
  `integrity = ${quote(artifact.integrity)}`,
  `url = ${quote(artifact.url)}`,
  ...(artifact.size === undefined ? [] : [`size = ${artifact.size}`]),
]

const renderImage = (lock: ProfileLock): ReadonlyArray<string> => [
  "",
  "[image]",
  `base = ${quote(lock.image.base)}`,
  `base_digest = ${quote(lock.image.base_digest)}`,
  ...(lock.image.final_digest === undefined ? [] : [`final_digest = ${quote(lock.image.final_digest)}`]),
]

const renderBuild = (lock: ProfileLock): ReadonlyArray<string> =>
  lock.build === undefined
    ? []
    : [
        "",
        "[build.builder]",
        `reference = ${quote(lock.build.builder.reference)}`,
        `digest = ${quote(lock.build.builder.digest)}`,
        "",
        "[build.importer]",
        `reference = ${quote(lock.build.importer.reference)}`,
        `digest = ${quote(lock.build.importer.digest)}`,
      ]

const renderSidecar = (lock: ProfileLock): ReadonlyArray<string> =>
  lock.sidecar === undefined
    ? []
    : [
        "",
        "[sidecar]",
        `schema = ${lock.sidecar.schema}`,
        `integrity = ${quote(lock.sidecar.integrity)}`,
        `size = ${lock.sidecar.size}`,
      ]

export const renderLock = (lock: ProfileLock): string => {
  const lines = [
    "schema = 1",
    `platform = ${quote(lock.platform)}`,
    `source_date_epoch = ${lock.source_date_epoch}`,
    `profile_hash = ${quote(lock.profile_hash)}`,
    ...(lock.sources.length === 0 ? ["sources = []"] : []),
    ...lock.sources.flatMap((source, index) => renderSource(lock, index, source)),
    "",
    "[packages]",
    ...renderLegacyHarness(lock),
    ...(lock.packages.runtime.length === 0 ? ["runtime = []"] : []),
    ...(lock.packages.python_lock_integrity === undefined
      ? []
      : [`python_lock_integrity = ${quote(lock.packages.python_lock_integrity)}`]),
    ...(lock.packages.runtime_direct === undefined
      ? []
      : [`runtime_direct = ${strings(lock.packages.runtime_direct)}`]),
    ...(lock.packages.runtime_closure_integrity === undefined
      ? []
      : [`runtime_closure_integrity = ${quote(lock.packages.runtime_closure_integrity)}`]),
    ...renderHarness(lock),
    ...lock.packages.runtime.flatMap(renderRuntime),
    ...(lock.packages.artifacts ?? []).flatMap(renderArtifact),
    ...renderSidecar(lock),
    ...renderBuild(lock),
    ...renderImage(lock),
  ]
  return `${lines.join("\n")}\n`
}

const Text = Schema.String.pipe(Schema.minLength(1))
const Sha256 = Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/))
const LegacyFileSchema = Schema.Struct({
  path: Text,
  sha256: Text,
  executable: Schema.optional(Schema.Literal(true)),
})
const TypedFileSchema = Schema.Struct({
  kind: Schema.Literal("file"),
  path: Text,
  sha256: Text,
  executable: Schema.optional(Schema.Literal(true)),
})
const SymlinkSchema = Schema.Struct({ kind: Schema.Literal("symlink"), path: Text, target: Text })
const InventoryEntrySchema = Schema.Union(LegacyFileSchema, TypedFileSchema, SymlinkSchema)
const StringRecordSchema = Schema.Record({ key: Text, value: Schema.String })
const SourceSchema = Schema.Struct({
  kind: Schema.Literal("plugin", "harness"),
  adapter: Schema.optional(
    Schema.Literal(
      "claude-marketplace",
      "codex-native",
      "wshobson-agents",
      "copilot-marketplace",
      "headlong",
      "hyperresearch",
      "prime-extension",
    ),
  ),
  marketplace: Schema.optional(Text),
  plugin_versions: Schema.optional(StringRecordSchema),
  package_version: Schema.optional(Text),
  repository: Text,
  ref: Text,
  select: Schema.Array(Text),
  commit: Text,
  integrity: Text,
  files: Schema.Array(InventoryEntrySchema),
})
const RuntimeSchema = Schema.Struct({
  name: Text,
  version: Text,
  integrity: Text,
  size: Schema.optional(Schema.Number.pipe(Schema.positive())),
  url: Schema.optional(Text),
  direct: Schema.optional(Schema.Boolean),
})
const ArtifactSchema = Schema.Struct({
  name: Text,
  version: Text,
  integrity: Text,
  url: Text,
  size: Schema.optional(Schema.Number.pipe(Schema.positive())),
})
const HarnessPackageSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("codex"),
    selector: Text,
    version: Text,
    integrity: Text,
    url: Text,
    size: Schema.Number.pipe(Schema.positive()),
  }),
  Schema.Struct({
    kind: Schema.Literal("copilot"),
    selector: Text,
    version: Text,
    integrity: Text,
    url: Text,
    size: Schema.Number.pipe(Schema.positive()),
  }),
  Schema.Struct({
    kind: Schema.Literal("claude"),
    selector: Text,
    version: Text,
    integrity: Text,
    url: Text,
    size: Schema.Number.pipe(Schema.positive()),
  }),
  Schema.Struct({
    kind: Schema.Literal("pi"),
    selector: Text,
    version: Text,
    integrity: Text,
    url: Text,
    size: Schema.Number.pipe(Schema.positive()),
  }),
  Schema.Struct({
    kind: Schema.Literal("prime"),
    selector: Text,
    version: Text,
    integrity: Text,
    url: Text,
    size: Schema.Number.pipe(Schema.positive()),
  }),
  Schema.Struct({
    kind: Schema.Literal("headlong"),
    selector: Text,
    commit: Text,
    integrity: Text,
  }),
)
const LegacyPackageSchema = Schema.Struct({
  codex: Text,
  codex_integrity: Schema.optional(Text),
  codex_url: Schema.optional(Text),
  codex_size: Schema.optional(Schema.Number.pipe(Schema.positive())),
  runtime: Schema.Array(RuntimeSchema),
})
const PackageSchema = Schema.Struct({
  harness: HarnessPackageSchema,
  python_lock_integrity: Schema.optional(Text),
  runtime_direct: Schema.optional(Schema.Array(Text)),
  runtime_closure_integrity: Schema.optional(Text),
  runtime: Schema.Array(RuntimeSchema),
  artifacts: Schema.optional(Schema.Array(ArtifactSchema)),
})
const LockSchema = Schema.Struct({
  schema: Schema.Literal(1),
  platform: Schema.Literal("linux/arm64", "linux/amd64"),
  source_date_epoch: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  profile_hash: Text,
  sources: Schema.Array(SourceSchema),
  packages: Schema.Union(LegacyPackageSchema, PackageSchema),
  sidecar: Schema.optional(
    Schema.Struct({
      schema: Schema.Literal(1),
      integrity: Sha256,
      size: Schema.Number.pipe(Schema.int(), Schema.positive()),
    }),
  ),
  build: Schema.optional(
    Schema.Struct({
      builder: Schema.Struct({ reference: Text, digest: Text }),
      importer: Schema.Struct({ reference: Text, digest: Text }),
    }),
  ),
  image: Schema.Struct({ base: Text, base_digest: Text, final_digest: Schema.optional(Text) }),
})

export class LockFileError extends Data.TaggedError("LockFileError")<{ readonly message: string }> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const legacySourceIndexes = (raw: unknown): ReadonlyArray<number> | undefined => {
  if (
    !isRecord(raw) ||
    !isRecord(raw.packages) ||
    Object.hasOwn(raw.packages, "harness") ||
    typeof raw.packages.codex !== "string" ||
    !Array.isArray(raw.sources)
  )
    return undefined
  const indexes: Array<number> = []
  for (const [index, source] of raw.sources.entries()) {
    if (!isRecord(source) || !Array.isArray(source.files)) continue
    const legacyFiles = source.files.every(
      (file) => isRecord(file) && !Object.hasOwn(file, "kind") && !Object.hasOwn(file, "executable"),
    )
    if (legacyFiles) indexes.push(index)
  }
  return indexes
}

export const parseLock = (source: string): Effect.Effect<ProfileLock, LockFileError> =>
  Effect.try({
    try: () => parse(source),
    catch: (cause) => new LockFileError({ message: `invalid lock TOML: ${String(cause)}` }),
  }).pipe(
    Effect.map((raw) => ({ raw, legacySources: legacySourceIndexes(raw) })),
    Effect.flatMap(({ raw, legacySources }) =>
      Schema.decodeUnknown(LockSchema)(raw, { onExcessProperty: "error" }).pipe(
        Effect.map((value) => ({ value, legacySources })),
      ),
    ),
    Effect.map(({ value, legacySources }) => {
      const lock = {
        ...value,
        source_date_epoch: value.source_date_epoch ?? 1784379906,
        sources: value.sources.map((sourceEntry) => ({
          ...sourceEntry,
          ...(sourceEntry.plugin_versions === undefined
            ? {}
            : { plugin_versions: sortedFrozenRecord(sourceEntry.plugin_versions) }),
          files: sourceEntry.files.map((file) => ("kind" in file ? file : { kind: "file" as const, ...file })),
        })),
        packages:
          "harness" in value.packages
            ? value.packages
            : {
                harness: {
                  kind: "codex" as const,
                  selector: value.packages.codex,
                  version: value.packages.codex,
                  integrity: value.packages.codex_integrity ?? "",
                  url: value.packages.codex_url ?? "",
                  size: value.packages.codex_size ?? 0,
                },
                runtime: value.packages.runtime,
              },
      } as ProfileLock
      return markPersistedLock(legacySources === undefined ? lock : markParsedLegacyProvenance(lock, legacySources))
    }),
    Effect.mapError((cause) =>
      cause instanceof LockFileError
        ? cause
        : new LockFileError({ message: ParseResult.TreeFormatter.formatErrorSync(cause) }),
    ),
  )
