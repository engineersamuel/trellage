import { Data, Effect } from "effect"

import { createStrictHarnessRelease } from "./strict-harness-release.ts"

import type { HarnessPackageLock } from "./lock.ts"

export interface PiReleaseClient {
  readonly release: (selector: string) => Effect.Effect<unknown, unknown>
}

export class PiReleaseError extends Data.TaggedError("PiReleaseError")<{
  readonly message: string
}> {}

const releases = createStrictHarnessRelease({
  repository: "can1357/oh-my-pi",
  tagPrefix: "v",
  label: "Pi",
  error: (message) => new PiReleaseError({ message }),
})

export const GitHubPiReleaseClient: PiReleaseClient = releases.client

const assetName = (platform: "linux/arm64" | "linux/amd64"): string =>
  platform === "linux/arm64" ? "omp-linux-arm64" : "omp-linux-x64"

export const resolvePiRelease = (
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  client: PiReleaseClient = GitHubPiReleaseClient,
): Effect.Effect<HarnessPackageLock, PiReleaseError> =>
  Effect.gen(function* () {
    const artifacts = yield* releases.resolve(
      selector,
      [
        {
          name: assetName(platform),
          label: "Pi release asset",
          missing: "Pi release platform asset is missing or ambiguous",
        },
      ],
      client,
    )
    return { kind: "pi", selector, ...artifacts[0]! }
  })
