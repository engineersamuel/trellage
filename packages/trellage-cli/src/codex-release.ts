import { Data, Effect } from "effect"

import { createStrictHarnessRelease } from "./strict-harness-release.ts"

import type { ArtifactLock, HarnessPackageLock } from "./lock.ts"

export interface CodexReleaseClient {
  readonly release: (selector: string) => Effect.Effect<unknown, unknown>
}

export class CodexReleaseError extends Data.TaggedError("CodexReleaseError")<{
  readonly message: string
}> {}

const releases = createStrictHarnessRelease({
  repository: "openai/codex",
  tagPrefix: "rust-v",
  label: "Codex",
  error: (message) => new CodexReleaseError({ message }),
})

export const GitHubCodexReleaseClient: CodexReleaseClient = releases.client

const assetName = (platform: "linux/arm64" | "linux/amd64"): string =>
  platform === "linux/arm64" ? "codex-aarch64-unknown-linux-musl.tar.gz" : "codex-x86_64-unknown-linux-musl.tar.gz"

export const codeModeHostArtifactName = "codex-code-mode-host"

const codeModeHostAssetName = (platform: "linux/arm64" | "linux/amd64"): string =>
  platform === "linux/arm64"
    ? "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz"
    : "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz"

export interface CodexReleaseLock {
  readonly harness: HarnessPackageLock & { readonly kind: "codex" }
  readonly artifacts: ReadonlyArray<ArtifactLock>
}

export const resolveCodexRelease = (
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  client: CodexReleaseClient = GitHubCodexReleaseClient,
): Effect.Effect<CodexReleaseLock, CodexReleaseError> =>
  Effect.gen(function* () {
    const artifacts = yield* releases.resolve(
      selector,
      [
        {
          name: assetName(platform),
          label: "Codex release asset",
          missing: "Codex release platform asset is missing or ambiguous",
        },
        {
          name: codeModeHostAssetName(platform),
          label: "Codex code-mode host asset",
          missing: "Codex code-mode host asset is missing or ambiguous",
        },
      ],
      client,
    )
    return {
      harness: { kind: "codex", selector, ...artifacts[0]! },
      artifacts: [{ name: codeModeHostArtifactName, ...artifacts[1]! }],
    }
  })
