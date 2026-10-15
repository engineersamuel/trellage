import { Data, Effect } from "effect"

import { createStrictHarnessRelease } from "./strict-harness-release.ts"

import type { HarnessPackageLock } from "./lock.ts"

export interface ClaudeReleaseClient {
  readonly release: (selector: string) => Effect.Effect<unknown, unknown>
}

export class ClaudeReleaseError extends Data.TaggedError("ClaudeReleaseError")<{
  readonly message: string
}> {}

const releases = createStrictHarnessRelease({
  repository: "anthropics/claude-code",
  tagPrefix: "v",
  label: "Claude",
  error: (message) => new ClaudeReleaseError({ message }),
})

export const GitHubClaudeReleaseClient: ClaudeReleaseClient = releases.client

const assetName = (platform: "linux/arm64" | "linux/amd64"): string =>
  platform === "linux/arm64" ? "claude-linux-arm64.tar.gz" : "claude-linux-x64.tar.gz"

export const resolveClaudeRelease = (
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  client: ClaudeReleaseClient = GitHubClaudeReleaseClient,
): Effect.Effect<HarnessPackageLock, ClaudeReleaseError> =>
  Effect.gen(function* () {
    const artifacts = yield* releases.resolve(
      selector,
      [
        {
          name: assetName(platform),
          label: "Claude release asset",
          missing: "Claude release platform asset is missing or ambiguous",
        },
      ],
      client,
    )
    return { kind: "claude", selector, ...artifacts[0]! }
  })
