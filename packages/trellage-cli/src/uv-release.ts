import { Data, Effect, ParseResult, Schema } from "effect"

import type { ArtifactLock } from "./lock.js"
import type { Platform } from "./platform.js"

export class UvReleaseError extends Data.TaggedError("UvReleaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const AssetSchema = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  digest: Schema.optional(Schema.String),
  size: Schema.Number,
})

const ReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  prerelease: Schema.Boolean,
  draft: Schema.Boolean,
  assets: Schema.Array(AssetSchema),
})

export const resolveUvRelease = (platform: Platform): Effect.Effect<ArtifactLock, UvReleaseError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch("https://api.github.com/repos/astral-sh/uv/releases/latest", {
          redirect: "error",
          headers: { Accept: "application/vnd.github+json" },
          signal,
        }),
      catch: (cause) => new UvReleaseError({ message: "cannot resolve latest uv release", cause }),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new UvReleaseError({ message: `cannot resolve latest uv release: HTTP ${response.status}` }),
      )
    }
    const raw = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new UvReleaseError({ message: "uv release response is invalid", cause }),
    })
    const release = yield* Schema.decodeUnknown(ReleaseSchema)(raw, { onExcessProperty: "ignore" }).pipe(
      Effect.mapError(
        (cause) =>
          new UvReleaseError({
            message: `uv release response is invalid: ${ParseResult.TreeFormatter.formatErrorSync(cause)}`,
          }),
      ),
    )
    if (release.prerelease || release.draft || !/^\d+\.\d+\.\d+$/.test(release.tag_name)) {
      return yield* Effect.fail(new UvReleaseError({ message: "latest uv release is not stable" }))
    }
    const assetName =
      platform === "linux/arm64" ? "uv-aarch64-unknown-linux-musl.tar.gz" : "uv-x86_64-unknown-linux-musl.tar.gz"
    const asset = release.assets.find((candidate) => candidate.name === assetName)
    const expectedUrl = `https://github.com/astral-sh/uv/releases/download/${release.tag_name}/${assetName}`
    if (
      asset === undefined ||
      asset.browser_download_url !== expectedUrl ||
      !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "") ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    ) {
      return yield* Effect.fail(new UvReleaseError({ message: `uv release asset is invalid: ${assetName}` }))
    }
    return {
      name: "uv",
      version: release.tag_name,
      integrity: asset.digest!,
      url: expectedUrl,
      size: asset.size,
    }
  })
