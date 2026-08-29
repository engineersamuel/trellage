import { createHash } from "node:crypto"

import { Data, Effect, ParseResult, Schema } from "effect"

import type { Platform } from "./platform.js"

const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`

export interface ResolutionSidecarFile {
  readonly role: "python-constraints"
  readonly content: string
  readonly integrity: string
  readonly size: number
}

export interface ResolutionSidecar {
  readonly schema: 1
  readonly profile_hash: string
  readonly platform: Platform
  readonly files: ReadonlyArray<ResolutionSidecarFile>
}

export interface ResolutionSidecarReference {
  readonly schema: 1
  readonly integrity: string
  readonly size: number
}

export class ResolutionSidecarError extends Data.TaggedError("ResolutionSidecarError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const FileSchema = Schema.Struct({
  role: Schema.Literal("python-constraints"),
  content: Schema.String,
  integrity: Schema.String,
  size: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})

const SidecarSchema = Schema.Struct({
  schema: Schema.Literal(1),
  profile_hash: Schema.String,
  platform: Schema.Literal("linux/arm64", "linux/amd64"),
  files: Schema.Array(FileSchema),
})

export const renderResolutionSidecar = (sidecar: ResolutionSidecar): string =>
  `${JSON.stringify({
    ...sidecar,
    files: [...sidecar.files].sort((left, right) => left.role.localeCompare(right.role, "en")),
  })}\n`

export const resolutionSidecarReference = (sidecar: ResolutionSidecar): ResolutionSidecarReference => {
  const rendered = renderResolutionSidecar(sidecar)
  return { schema: 1, integrity: sha256(rendered), size: Buffer.byteLength(rendered) }
}

export const createPythonConstraintsSidecar = (
  profileHash: string,
  platform: Platform,
  content: string,
): ResolutionSidecar => ({
  schema: 1,
  profile_hash: profileHash,
  platform,
  files: [
    {
      role: "python-constraints",
      content,
      integrity: sha256(content),
      size: Buffer.byteLength(content),
    },
  ],
})

export const parseResolutionSidecar = (source: string): Effect.Effect<ResolutionSidecar, ResolutionSidecarError> =>
  Effect.try({
    try: () => JSON.parse(source) as unknown,
    catch: (cause) => new ResolutionSidecarError({ message: "resolution sidecar JSON is invalid", cause }),
  }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknown(SidecarSchema)(value, { onExcessProperty: "error" })),
    Effect.mapError((cause) =>
      cause instanceof ResolutionSidecarError
        ? cause
        : new ResolutionSidecarError({ message: ParseResult.TreeFormatter.formatErrorSync(cause) }),
    ),
    Effect.flatMap((sidecar) => {
      if (!/^sha256:[0-9a-f]{64}$/.test(sidecar.profile_hash)) {
        return Effect.fail(new ResolutionSidecarError({ message: "resolution sidecar profile hash is invalid" }))
      }
      if (sidecar.files.length !== 1) {
        return Effect.fail(new ResolutionSidecarError({ message: "resolution sidecar file set is invalid" }))
      }
      const file = sidecar.files[0]!
      if (file.integrity !== sha256(file.content) || file.size !== Buffer.byteLength(file.content)) {
        return Effect.fail(new ResolutionSidecarError({ message: "resolution sidecar file integrity is invalid" }))
      }
      return Effect.succeed(sidecar)
    }),
  )

export const verifyResolutionSidecarReference = (
  source: string,
  reference: ResolutionSidecarReference,
): Effect.Effect<void, ResolutionSidecarError> => {
  if (
    reference.schema !== 1 ||
    reference.integrity !== sha256(source) ||
    reference.size !== Buffer.byteLength(source)
  ) {
    return Effect.fail(new ResolutionSidecarError({ message: "resolution sidecar reference is invalid" }))
  }
  return Effect.void
}

export const pythonConstraints = (sidecar: ResolutionSidecar | undefined): string | undefined =>
  sidecar?.files.find((file) => file.role === "python-constraints")?.content
