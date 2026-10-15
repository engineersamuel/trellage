import { Effect, Schema } from "effect"

export interface HarnessReleaseClient {
  readonly release: (selector: string) => Effect.Effect<unknown, unknown>
}

interface ReleasePolicy<Error> {
  readonly repository: string
  readonly tagPrefix: string
  readonly label: string
  readonly error: (message: string) => Error
}

interface ReleaseAsset {
  readonly name: string
  readonly label: string
  readonly missing: string
}

const GitHubAssetSchema = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.Number,
  digest: Schema.optional(Schema.String),
})

const GitHubReleaseSchema = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(GitHubAssetSchema),
})

const exactStableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const sha256Digest = /^sha256:[0-9a-f]{64}$/

/** Strict harness releases require official URLs and published digests; never download to infer trust. */
export const createStrictHarnessRelease = <Error>(policy: ReleasePolicy<Error>) => {
  const client: HarnessReleaseClient = {
    release: (selector) =>
      Effect.gen(function* () {
        const route = selector === "latest" ? "latest" : `tags/${policy.tagPrefix}${selector}`
        const url = `https://api.github.com/repos/${policy.repository}/releases/${route}`
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(url, {
              redirect: "error",
              headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "trellage",
              },
            }),
          catch: () => policy.error("GitHub release request failed"),
        })
        if (response.redirected) {
          return yield* Effect.fail(policy.error("GitHub release response was redirected"))
        }
        if (response.url !== url) {
          return yield* Effect.fail(policy.error("GitHub release response identity is invalid"))
        }
        if (!response.ok) {
          return yield* Effect.fail(policy.error(`GitHub release request failed (${response.status})`))
        }
        return yield* Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => policy.error("GitHub release response was invalid"),
        })
      }),
  }

  const resolve = (selector: string, requested: ReadonlyArray<ReleaseAsset>, source: HarnessReleaseClient = client) =>
    Effect.gen(function* () {
      if (selector !== "latest" && !exactStableVersion.test(selector)) {
        return yield* Effect.fail(policy.error(`${policy.label} release selector is not an exact version`))
      }
      const payload = yield* source
        .release(selector)
        .pipe(Effect.mapError(() => policy.error(`${policy.label} release lookup failed`)))
      const release = yield* Schema.decodeUnknown(GitHubReleaseSchema)(payload, {
        onExcessProperty: "ignore",
      }).pipe(Effect.mapError(() => policy.error(`${policy.label} release response is invalid`)))
      if (release.draft || release.prerelease) {
        return yield* Effect.fail(policy.error(`${policy.label} release is not stable`))
      }
      if (!release.tag_name.startsWith(policy.tagPrefix)) {
        return yield* Effect.fail(policy.error(`${policy.label} release tag is invalid`))
      }
      const version = release.tag_name.slice(policy.tagPrefix.length)
      if (!exactStableVersion.test(version)) {
        return yield* Effect.fail(policy.error(`${policy.label} release tag is invalid`))
      }
      if (selector !== "latest" && selector !== version) {
        return yield* Effect.fail(policy.error(`${policy.label} release does not match selector`))
      }

      const artifacts = []
      for (const request of requested) {
        const assets = release.assets.filter((candidate) => candidate.name === request.name)
        if (assets.length !== 1) return yield* Effect.fail(policy.error(request.missing))
        const asset = assets[0]!
        const url = `https://github.com/${policy.repository}/releases/download/${policy.tagPrefix}${version}/${request.name}`
        if (asset.browser_download_url !== url) {
          return yield* Effect.fail(policy.error(`${request.label} URL is invalid`))
        }
        if (asset.digest === undefined || !sha256Digest.test(asset.digest)) {
          return yield* Effect.fail(policy.error(`${request.label} digest is invalid`))
        }
        if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
          return yield* Effect.fail(policy.error(`${request.label} size is invalid`))
        }
        artifacts.push({ version, url, size: asset.size, integrity: asset.digest })
      }
      return artifacts
    })

  return { client, resolve }
}
