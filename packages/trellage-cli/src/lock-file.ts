import { parse } from "smol-toml"
import { Data, Effect, ParseResult, Schema } from "effect"

import {
  hasLegacyPackageProvenance,
  hasLegacySourceProvenance,
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

export const renderLock = (lock: ProfileLock): string => {
  const lines = [
    "schema = 1",
    `source_date_epoch = ${lock.source_date_epoch}`,
    `profile_hash = ${quote(lock.profile_hash)}`,
  ]
  if (lock.sources.length === 0) lines.push("sources = []")
  for (const [sourceIndex, source] of lock.sources.entries()) {
    lines.push("", "[[sources]]", `kind = ${quote(source.kind)}`)
    if (source.adapter) lines.push(`adapter = ${quote(source.adapter)}`)
    if (source.marketplace) lines.push(`marketplace = ${quote(source.marketplace)}`)
    if (source.plugin_versions) lines.push(`plugin_versions = ${stringRecord(source.plugin_versions)}`)
    lines.push(
      `repository = ${quote(source.repository)}`,
      `ref = ${quote(source.ref)}`,
      `select = ${strings(source.select)}`,
      `commit = ${quote(source.commit)}`,
      `integrity = ${quote(source.integrity)}`,
    )
    for (const file of source.files) {
      if (file.kind === "file") {
        lines.push("", "[[sources.files]]")
        if (lock.packages.harness.kind === "codex" && !hasLegacySourceProvenance(lock, sourceIndex)) {
          lines.push(`kind = ${quote(file.kind)}`)
        }
        lines.push(`path = ${quote(file.path)}`, `sha256 = ${quote(file.sha256)}`)
        if (file.executable === true) lines.push("executable = true")
      } else {
        lines.push(
          "",
          "[[sources.files]]",
          `kind = ${quote(file.kind)}`,
          `path = ${quote(file.path)}`,
          `target = ${quote(file.target)}`,
        )
      }
    }
  }
  lines.push("", "[packages]")
  if (lock.packages.harness.kind === "codex" && hasLegacyPackageProvenance(lock)) {
    lines.push(
      `codex = ${quote(lock.packages.harness.version)}`,
      `codex_integrity = ${quote(lock.packages.harness.integrity)}`,
      `codex_url = ${quote(lock.packages.harness.url)}`,
      `codex_size = ${lock.packages.harness.size}`,
    )
  }
  if (lock.packages.skills_cli_version) lines.push(`skills_cli_version = ${quote(lock.packages.skills_cli_version)}`)
  if (lock.packages.skills_cli_integrity)
    lines.push(`skills_cli_integrity = ${quote(lock.packages.skills_cli_integrity)}`)
  if (lock.packages.python_lock_integrity)
    lines.push(`python_lock_integrity = ${quote(lock.packages.python_lock_integrity)}`)
  if (
    lock.packages.harness.kind === "claude" ||
    lock.packages.harness.kind === "copilot" ||
    lock.packages.harness.kind === "pi" ||
    (lock.packages.harness.kind === "codex" && !hasLegacyPackageProvenance(lock))
  ) {
    lines.push(
      "",
      "[packages.harness]",
      `kind = ${quote(lock.packages.harness.kind)}`,
      `selector = ${quote(lock.packages.harness.selector)}`,
      `version = ${quote(lock.packages.harness.version)}`,
      `integrity = ${quote(lock.packages.harness.integrity)}`,
      `url = ${quote(lock.packages.harness.url)}`,
      `size = ${lock.packages.harness.size}`,
    )
  }
  for (const runtime of lock.packages.runtime) {
    lines.push(
      "",
      "[[packages.runtime]]",
      `name = ${quote(runtime.name)}`,
      `version = ${quote(runtime.version)}`,
      `integrity = ${quote(runtime.integrity)}`,
    )
  }
  for (const artifact of lock.packages.artifacts ?? []) {
    lines.push(
      "",
      "[[packages.artifacts]]",
      `name = ${quote(artifact.name)}`,
      `version = ${quote(artifact.version)}`,
      `integrity = ${quote(artifact.integrity)}`,
      `url = ${quote(artifact.url)}`,
    )
    if (artifact.size !== undefined) lines.push(`size = ${artifact.size}`)
  }
  lines.push("", "[image]", `base = ${quote(lock.image.base)}`, `base_digest = ${quote(lock.image.base_digest)}`)
  if (lock.image.final_digest !== undefined) lines.push(`final_digest = ${quote(lock.image.final_digest)}`)
  return `${lines.join("\n")}\n`
}

const Text = Schema.String.pipe(Schema.minLength(1))
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
  kind: Schema.Literal("skill", "plugin"),
  adapter: Schema.optional(
    Schema.Literal(
      "claude-marketplace",
      "codex-native",
      "wshobson-agents",
      "copilot-marketplace",
      "hyperresearch",
      "omp-native",
    ),
  ),
  marketplace: Schema.optional(Text),
  plugin_versions: Schema.optional(StringRecordSchema),
  repository: Text,
  ref: Text,
  select: Schema.Array(Text),
  commit: Text,
  integrity: Text,
  files: Schema.Array(InventoryEntrySchema),
})
const RuntimeSchema = Schema.Struct({ name: Text, version: Text, integrity: Text })
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
)
const LegacyPackageSchema = Schema.Struct({
  codex: Text,
  codex_integrity: Schema.optional(Text),
  codex_url: Schema.optional(Text),
  codex_size: Schema.optional(Schema.Number.pipe(Schema.positive())),
  skills_cli_version: Schema.optional(Text),
  skills_cli_integrity: Schema.optional(Text),
  runtime: Schema.Array(RuntimeSchema),
})
const PackageSchema = Schema.Struct({
  harness: HarnessPackageSchema,
  skills_cli_version: Schema.optional(Text),
  skills_cli_integrity: Schema.optional(Text),
  python_lock_integrity: Schema.optional(Text),
  runtime: Schema.Array(RuntimeSchema),
  artifacts: Schema.optional(Schema.Array(ArtifactSchema)),
})
const LockSchema = Schema.Struct({
  schema: Schema.Literal(1),
  source_date_epoch: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  profile_hash: Text,
  sources: Schema.Array(SourceSchema),
  packages: Schema.Union(LegacyPackageSchema, PackageSchema),
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
                ...(value.packages.skills_cli_version === undefined
                  ? {}
                  : { skills_cli_version: value.packages.skills_cli_version }),
                ...(value.packages.skills_cli_integrity === undefined
                  ? {}
                  : { skills_cli_integrity: value.packages.skills_cli_integrity }),
                runtime: value.packages.runtime,
              },
      } as ProfileLock
      return legacySources === undefined ? lock : markParsedLegacyProvenance(lock, legacySources)
    }),
    Effect.mapError((cause) =>
      cause instanceof LockFileError
        ? cause
        : new LockFileError({ message: ParseResult.TreeFormatter.formatErrorSync(cause) }),
    ),
  )
