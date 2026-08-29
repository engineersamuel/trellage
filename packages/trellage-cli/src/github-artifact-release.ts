import { Data, Effect, ParseResult, Schema } from "effect"

import { cacheArtifact } from "./artifact-cache.js"
import type { ArtifactLock } from "./lock.js"
import type { Platform } from "./platform.js"

export class GitHubArtifactReleaseError extends Data.TaggedError("GitHubArtifactReleaseError")<{
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

type DecodedRelease = Schema.Schema.Type<typeof ReleaseSchema>

const selectReleaseAsset = (
  request: {
    readonly name: string
    readonly repository: string
    readonly platform: Platform
    readonly versionFromTag: (tag: string) => string | undefined
    readonly assetName: (version: string, platform: Platform) => string
  },
  release: DecodedRelease,
) => {
  const version = request.versionFromTag(release.tag_name)
  if (release.prerelease || release.draft || version === undefined) {
    throw new Error(`latest GitHub artifact is not stable: ${request.name}`)
  }
  const assetName = request.assetName(version, request.platform)
  const asset = release.assets.find((candidate) => candidate.name === assetName)
  const expectedUrl = `https://github.com/${request.repository}/releases/download/${release.tag_name}/${assetName}`
  if (
    asset === undefined ||
    asset.browser_download_url !== expectedUrl ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  ) {
    throw new Error(`GitHub release asset is invalid: ${request.name}`)
  }
  return { version, asset, expectedUrl }
}

export const resolveGitHubArtifactRelease = (request: {
  readonly cacheHome: string
  readonly name: string
  readonly repository: string
  readonly platform: Platform
  readonly versionFromTag: (tag: string) => string | undefined
  readonly assetName: (version: string, platform: Platform) => string
}): Effect.Effect<ArtifactLock, GitHubArtifactReleaseError> =>
  Effect.gen(function* () {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository)) {
      return yield* Effect.fail(new GitHubArtifactReleaseError({ message: "GitHub artifact repository is invalid" }))
    }
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(`https://api.github.com/repos/${request.repository}/releases/latest`, {
          redirect: "error",
          headers: { Accept: "application/vnd.github+json" },
          signal,
        }),
      catch: (cause) =>
        new GitHubArtifactReleaseError({ message: `cannot resolve GitHub artifact: ${request.name}`, cause }),
    })
    if (!response.ok) {
      return yield* Effect.fail(
        new GitHubArtifactReleaseError({
          message: `cannot resolve GitHub artifact ${request.name}: HTTP ${response.status}`,
        }),
      )
    }
    const raw = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new GitHubArtifactReleaseError({ message: "GitHub release response is invalid", cause }),
    })
    const release = yield* Schema.decodeUnknown(ReleaseSchema)(raw, { onExcessProperty: "ignore" }).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubArtifactReleaseError({
            message: `GitHub release response is invalid: ${ParseResult.TreeFormatter.formatErrorSync(cause)}`,
          }),
      ),
    )
    const { version, asset, expectedUrl } = yield* Effect.try({
      try: () => selectReleaseAsset(request, release),
      catch: (cause) => new GitHubArtifactReleaseError({ message: String(cause), cause }),
    })
    const cached =
      asset.digest === undefined
        ? yield* cacheArtifact({ cacheHome: request.cacheHome, url: expectedUrl }).pipe(
            Effect.mapError(
              (cause) => new GitHubArtifactReleaseError({ message: `cannot hash artifact: ${request.name}`, cause }),
            ),
          )
        : undefined
    const integrity = cached?.integrity ?? asset.digest
    const size = cached?.size ?? asset.size
    if (!/^sha256:[0-9a-f]{64}$/.test(integrity ?? "")) {
      return yield* Effect.fail(
        new GitHubArtifactReleaseError({ message: `GitHub release digest is invalid: ${request.name}` }),
      )
    }
    return { name: request.name, version, integrity: integrity!, url: expectedUrl, size }
  })
