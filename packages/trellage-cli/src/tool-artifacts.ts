import { Effect } from "effect"

import { resolveCodexRelease } from "./codex-release.js"
import { resolveGitHubArtifactRelease } from "./github-artifact-release.js"
import type { ArtifactLock } from "./lock.js"
import type { Platform } from "./platform.js"

const semverTag = (tag: string): string | undefined => {
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(tag)
  return match?.[1]
}

const githubTool = (
  cacheHome: string,
  platform: Platform,
  name: string,
  repository: string,
  assetName: (version: string, platform: Platform) => string,
) =>
  resolveGitHubArtifactRelease({
    cacheHome,
    name,
    repository,
    platform,
    versionFromTag: semverTag,
    assetName,
  })

const resolveCodexArtifacts = (platform: Platform): Effect.Effect<ReadonlyArray<ArtifactLock>, unknown> =>
  resolveCodexRelease("latest", platform).pipe(
    Effect.map((release) => [
      {
        name: "codex",
        version: release.harness.version,
        integrity: release.harness.integrity,
        url: release.harness.url,
        size: release.harness.size,
      },
      ...release.artifacts,
    ]),
  )

export const resolveToolArtifacts = (
  cacheHome: string,
  platform: Platform,
  names: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ArtifactLock>, unknown> =>
  Effect.gen(function* () {
    const requested = new Set(names)
    const supported = new Set(["bd", "bv", "raindrop", "codex", "lefthook-linux-arm64", "obscura"])
    const unsupported = [...requested].find((name) => !supported.has(name))
    if (unsupported !== undefined) return yield* Effect.fail(`unsupported managed artifact: ${unsupported}`)
    const artifacts: Array<ArtifactLock> = []
    if (requested.has("bd")) {
      artifacts.push(
        yield* githubTool(cacheHome, platform, "bd", "gastownhall/beads", (version, selectedPlatform) =>
          selectedPlatform === "linux/arm64"
            ? `beads_${version}_linux_arm64.tar.gz`
            : `beads_${version}_linux_amd64.tar.gz`,
        ),
      )
    }
    if (requested.has("bv")) {
      artifacts.push(
        yield* githubTool(cacheHome, platform, "bv", "Dicklesworthstone/beads_viewer", (_version, selectedPlatform) =>
          selectedPlatform === "linux/arm64" ? "bv_linux_arm64.tar.gz" : "bv_linux_amd64.tar.gz",
        ),
      )
    }
    if (requested.has("raindrop")) {
      artifacts.push(
        yield* githubTool(cacheHome, platform, "raindrop", "raindrop-ai/workshop", (_version, selectedPlatform) =>
          selectedPlatform === "linux/arm64" ? "raindrop-bun-linux-arm64.gz" : "raindrop-bun-linux-x64.gz",
        ),
      )
    }
    if (requested.has("codex")) artifacts.push(...(yield* resolveCodexArtifacts(platform)))
    if (requested.has("lefthook-linux-arm64")) {
      artifacts.push(
        yield* githubTool(
          cacheHome,
          platform,
          "lefthook-linux-arm64",
          "evilmartians/lefthook",
          (version, selectedPlatform) =>
            selectedPlatform === "linux/arm64" ? `lefthook_${version}_Linux_arm64` : `lefthook_${version}_Linux_x86_64`,
        ),
      )
    }
    if (requested.has("obscura")) {
      artifacts.push(
        yield* githubTool(cacheHome, platform, "obscura", "h4ckf0r0day/obscura", (_version, selectedPlatform) =>
          selectedPlatform === "linux/arm64"
            ? "obscura-aarch64-linux-stealth.tar.gz"
            : "obscura-x86_64-linux-stealth.tar.gz",
        ),
      )
    }
    return artifacts
  })
