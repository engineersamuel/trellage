import { Data, Effect, Schema } from "effect"

import type { HarnessPackageLock } from "./lock.js"

export interface CodexReleaseClient {
  readonly release: (selector: string) => Effect.Effect<unknown, unknown>
}

export class CodexReleaseError extends Data.TaggedError("CodexReleaseError")<{
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

export const GitHubCodexReleaseClient: CodexReleaseClient = {
  release: (selector) =>
    Effect.gen(function* () {
      const route = selector === "latest" ? "latest" : `tags/rust-v${selector}`
      const url = `https://api.github.com/repos/openai/codex/releases/${route}`
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            redirect: "error",
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": "trellage",
            },
          }),
        catch: () => new CodexReleaseError({ message: "GitHub release request failed" }),
      })
      if (response.redirected) {
        return yield* Effect.fail(new CodexReleaseError({ message: "GitHub release response was redirected" }))
      }
      if (response.url !== url) {
        return yield* Effect.fail(new CodexReleaseError({ message: "GitHub release response identity is invalid" }))
      }
      if (!response.ok) {
        return yield* Effect.fail(
          new CodexReleaseError({ message: `GitHub release request failed (${response.status})` }),
        )
      }
      return yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => new CodexReleaseError({ message: "GitHub release response was invalid" }),
      })
    }),
}

const assetName = (platform: "linux/arm64" | "linux/amd64"): string =>
  platform === "linux/arm64" ? "codex-aarch64-unknown-linux-musl.tar.gz" : "codex-x86_64-unknown-linux-musl.tar.gz"

export const resolveCodexRelease = (
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  client: CodexReleaseClient = GitHubCodexReleaseClient,
): Effect.Effect<HarnessPackageLock, CodexReleaseError> =>
  Effect.gen(function* () {
    if (selector !== "latest" && !exactStableVersion.test(selector)) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release selector is not an exact version" }))
    }
    const payload = yield* client
      .release(selector)
      .pipe(Effect.mapError(() => new CodexReleaseError({ message: "Codex release lookup failed" })))
    const release = yield* Schema.decodeUnknown(GitHubReleaseSchema)(payload, {
      onExcessProperty: "ignore",
    }).pipe(Effect.mapError(() => new CodexReleaseError({ message: "Codex release response is invalid" })))
    if (release.draft || release.prerelease) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release is not stable" }))
    }
    if (!release.tag_name.startsWith("rust-v")) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release tag is invalid" }))
    }
    const version = release.tag_name.slice("rust-v".length)
    if (!exactStableVersion.test(version)) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release tag is invalid" }))
    }
    if (selector !== "latest" && selector !== version) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release does not match selector" }))
    }
    const name = assetName(platform)
    const assets = release.assets.filter((candidate) => candidate.name === name)
    if (assets.length !== 1) {
      return yield* Effect.fail(
        new CodexReleaseError({ message: "Codex release platform asset is missing or ambiguous" }),
      )
    }
    const asset = assets[0]!
    const expectedUrl = `https://github.com/openai/codex/releases/download/rust-v${version}/${name}`
    if (asset.browser_download_url !== expectedUrl) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release asset URL is invalid" }))
    }
    if (asset.digest === undefined || !sha256Digest.test(asset.digest)) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release asset digest is invalid" }))
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
      return yield* Effect.fail(new CodexReleaseError({ message: "Codex release asset size is invalid" }))
    }
    return {
      kind: "codex",
      selector,
      version,
      url: expectedUrl,
      size: asset.size,
      integrity: asset.digest,
    }
  })
