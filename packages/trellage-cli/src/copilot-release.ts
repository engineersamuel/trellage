import { Data, Effect, Schema } from "effect"

import type { HarnessPackageLock } from "./lock.js"

export interface CopilotReleaseClient {
  readonly release: (selector: string) => Effect.Effect<unknown, unknown>
}

export class CopilotReleaseError extends Data.TaggedError("CopilotReleaseError")<{
  readonly message: string
}> {}

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

export const GitHubCopilotReleaseClient: CopilotReleaseClient = {
  release: (selector) =>
    Effect.gen(function* () {
      const route = selector === "latest" ? "latest" : `tags/v${selector}`
      const url = `https://api.github.com/repos/github/copilot-cli/releases/${route}`
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            redirect: "error",
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "sandbox-harness",
            },
          }),
        catch: () => new CopilotReleaseError({ message: "GitHub release request failed" }),
      })
      if (response.redirected) {
        return yield* Effect.fail(new CopilotReleaseError({ message: "GitHub release response was redirected" }))
      }
      if (response.url !== url) {
        return yield* Effect.fail(new CopilotReleaseError({ message: "GitHub release response identity is invalid" }))
      }
      if (!response.ok) {
        return yield* Effect.fail(
          new CopilotReleaseError({ message: `GitHub release request failed (${response.status})` }),
        )
      }
      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => new CopilotReleaseError({ message: "GitHub release response was invalid" }),
      })
    }),
}

const assetName = (platform: "linux/arm64" | "linux/amd64"): string =>
  platform === "linux/arm64" ? "copilot-linux-arm64.tar.gz" : "copilot-linux-x64.tar.gz"

export const resolveCopilotRelease = (
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  client: CopilotReleaseClient = GitHubCopilotReleaseClient,
): Effect.Effect<HarnessPackageLock, CopilotReleaseError> =>
  Effect.gen(function* () {
    if (selector !== "latest" && !exactStableVersion.test(selector)) {
      return yield* Effect.fail(
        new CopilotReleaseError({ message: "Copilot release selector is not an exact version" }),
      )
    }
    const payload = yield* client
      .release(selector)
      .pipe(Effect.mapError(() => new CopilotReleaseError({ message: "Copilot release lookup failed" })))
    const release = yield* Schema.decodeUnknown(GitHubReleaseSchema)(payload, {
      onExcessProperty: "ignore",
    }).pipe(Effect.mapError(() => new CopilotReleaseError({ message: "Copilot release response is invalid" })))
    if (release.draft || release.prerelease) {
      return yield* Effect.fail(new CopilotReleaseError({ message: "Copilot release is not stable" }))
    }
    if (!release.tag_name.startsWith("v")) {
      return yield* Effect.fail(new CopilotReleaseError({ message: "Copilot release tag is invalid" }))
    }
    const version = release.tag_name.slice(1)
    if (!exactStableVersion.test(version)) {
      return yield* Effect.fail(new CopilotReleaseError({ message: "Copilot release tag is invalid" }))
    }
    if (selector !== "latest" && selector !== version) {
      return yield* Effect.fail(new CopilotReleaseError({ message: "Copilot release does not match selector" }))
    }
    const name = assetName(platform)
    const assets = release.assets.filter((candidate) => candidate.name === name)
    if (assets.length !== 1) {
      return yield* Effect.fail(
        new CopilotReleaseError({ message: "Copilot release platform asset is missing or ambiguous" }),
      )
    }
    const asset = assets[0]!
    const expectedUrl = `https://github.com/github/copilot-cli/releases/download/v${version}/${name}`
    if (asset.browser_download_url !== expectedUrl) {
      return yield* Effect.fail(new CopilotReleaseError({ message: "Copilot release asset URL is invalid" }))
    }
    if (asset.digest === undefined || !sha256Digest.test(asset.digest)) {
      return yield* Effect.fail(new CopilotReleaseError({ message: "Copilot release asset digest is invalid" }))
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      return yield* Effect.fail(new CopilotReleaseError({ message: "Copilot release asset size is invalid" }))
    }
    return {
      kind: "copilot",
      selector,
      version,
      url: expectedUrl,
      size: asset.size,
      integrity: asset.digest,
    }
  })
