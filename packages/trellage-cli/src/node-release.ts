import { Data, Effect } from "effect"

import type { ArtifactLock } from "./lock.js"
import type { Platform } from "./platform.js"

export class NodeReleaseError extends Data.TaggedError("NodeReleaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface NodeReleaseIndexEntry {
  readonly version?: unknown
  readonly lts?: unknown
  readonly files?: unknown
}

const sha256Pattern = /^[0-9a-f]{64}$/

const fetchText = (url: string): Effect.Effect<string, NodeReleaseError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, { redirect: "error", signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.text()
    },
    catch: (cause) => new NodeReleaseError({ message: `cannot resolve Node release: ${url}`, cause }),
  })

const platformAsset = (version: string, platform: Platform): string =>
  `node-${version}-${platform === "linux/arm64" ? "linux-arm64" : "linux-x64"}.tar.gz`

export const resolveNodeRelease = (platform: Platform): Effect.Effect<ArtifactLock, NodeReleaseError> =>
  Effect.gen(function* () {
    const source = yield* fetchText("https://nodejs.org/dist/index.json")
    const releases = yield* Effect.try({
      try: () => {
        const value = JSON.parse(source) as unknown
        if (!Array.isArray(value)) throw new Error("release index is not an array")
        return value.filter(
          (candidate): candidate is NodeReleaseIndexEntry => typeof candidate === "object" && candidate !== null,
        )
      },
      catch: (cause) => new NodeReleaseError({ message: "Node release index is invalid", cause }),
    })
    const platformFile = platform === "linux/arm64" ? "linux-arm64" : "linux-x64"
    const release = releases.find(
      (candidate) =>
        typeof candidate.version === "string" &&
        /^v\d+\.\d+\.\d+$/.test(candidate.version) &&
        typeof candidate.lts === "string" &&
        Array.isArray(candidate.files) &&
        candidate.files.includes(platformFile),
    )
    if (typeof release?.version !== "string") {
      return yield* Effect.fail(new NodeReleaseError({ message: `Node has no stable LTS release for ${platform}` }))
    }
    const asset = platformAsset(release.version, platform)
    const checksums = yield* fetchText(`https://nodejs.org/dist/${release.version}/SHASUMS256.txt`)
    const match = checksums
      .split(/\r?\n/)
      .map((line) => /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim()))
      .find((candidate) => candidate?.[2] === asset)
    if (match?.[1] === undefined || !sha256Pattern.test(match[1])) {
      return yield* Effect.fail(new NodeReleaseError({ message: `Node checksum is missing for ${asset}` }))
    }
    return {
      name: "node",
      version: release.version.slice(1),
      integrity: `sha256:${match[1]}`,
      url: `https://nodejs.org/dist/${release.version}/${asset}`,
    }
  })
