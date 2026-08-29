import { Data, Effect, ParseResult, Schema } from "effect"

import type { ArtifactLock } from "./lock.js"
import type { Platform } from "./platform.js"

export class PythonReleaseError extends Data.TaggedError("PythonReleaseError")<{
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

export const resolvePythonRelease = (platform: Platform): Effect.Effect<ArtifactLock, PythonReleaseError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch("https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest", {
          redirect: "error",
          headers: { Accept: "application/vnd.github+json" },
          signal,
        }),
      catch: (cause) => new PythonReleaseError({ message: "cannot resolve latest Python release", cause }),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new PythonReleaseError({ message: `cannot resolve latest Python release: HTTP ${response.status}` }),
      )
    }
    const raw = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new PythonReleaseError({ message: "Python release response is invalid", cause }),
    })
    const release = yield* Schema.decodeUnknown(ReleaseSchema)(raw, { onExcessProperty: "ignore" }).pipe(
      Effect.mapError(
        (cause) =>
          new PythonReleaseError({
            message: `Python release response is invalid: ${ParseResult.TreeFormatter.formatErrorSync(cause)}`,
          }),
      ),
    )
    if (release.prerelease || release.draft || !/^\d{8}$/.test(release.tag_name)) {
      return yield* Effect.fail(new PythonReleaseError({ message: "latest Python standalone release is not stable" }))
    }
    const architecture = platform === "linux/arm64" ? "aarch64" : "x86_64"
    const pattern = new RegExp(
      `^cpython-(3\\.13\\.\\d+)\\+${release.tag_name}-${architecture}-unknown-linux-gnu-install_only_stripped\\.tar\\.gz$`,
    )
    const matches = release.assets.flatMap((asset) => {
      const match = pattern.exec(asset.name)
      return match?.[1] === undefined ? [] : [{ asset, version: match[1] }]
    })
    const selected = matches.sort((left, right) =>
      right.version.localeCompare(left.version, "en", { numeric: true }),
    )[0]
    if (
      selected === undefined ||
      selected.asset.browser_download_url !==
        `https://github.com/astral-sh/python-build-standalone/releases/download/${release.tag_name}/${selected.asset.name.replace("+", "%2B")}` ||
      !/^sha256:[0-9a-f]{64}$/.test(selected.asset.digest ?? "") ||
      !Number.isSafeInteger(selected.asset.size) ||
      selected.asset.size <= 0
    ) {
      return yield* Effect.fail(
        new PythonReleaseError({ message: `Python standalone has no valid 3.13 artifact for ${platform}` }),
      )
    }
    return {
      name: "python",
      version: selected.version,
      integrity: selected.asset.digest!,
      url: selected.asset.browser_download_url,
      size: selected.asset.size,
    }
  })
