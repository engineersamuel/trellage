import { Effect } from "effect"

import { arm64ArtifactCatalog } from "./artifact-catalog.js"
import { resolveClaudeRelease } from "./claude-release.js"
import { ClaudePluginError, readClaudeMarketplace } from "./claude-plugin.js"
import { resolveCodexRelease } from "./codex-release.js"
import { CopilotPluginError, readCopilotMarketplace } from "./copilot-plugin.js"
import { resolveCopilotRelease } from "./copilot-release.js"
import { resolveGitHubSource } from "./github-cache.js"
import type { LockResolvers } from "./lock.js"
import { resolvePiRelease } from "./pi-release.js"
import { sourceIncludes, sourceInventoryPolicy } from "./source-policy.js"

const versions: Readonly<Record<string, string>> = arm64ArtifactCatalog.runtimeVersions
const integrities: Readonly<Record<string, string>> = arm64ArtifactCatalog.runtimeIntegrities

export const productionResolvers = (xdgCacheHome: string, platform: "linux/arm64" | "linux/amd64"): LockResolvers => ({
  platform,
  resolveSource: (request) =>
    Effect.gen(function* () {
      const cached = yield* resolveGitHubSource(xdgCacheHome, {
        repository: request.repository,
        ref: request.ref,
        include: sourceIncludes(request),
        inventoryPolicy: sourceInventoryPolicy(request),
        ...(!request.update && request.previousCommit ? { lockedCommit: request.previousCommit } : {}),
      })
      const resolution = {
        commit: cached.commit,
        integrity: cached.integrity,
        files: cached.files,
      }
      if (request.adapter !== "copilot-marketplace" && request.adapter !== "claude-marketplace") return resolution
      if (request.marketplace === undefined) {
        return yield* Effect.fail(
          request.adapter === "copilot-marketplace"
            ? new CopilotPluginError({ message: "Copilot marketplace selection is missing" })
            : new ClaudePluginError({ message: "Claude marketplace selection is missing" }),
        )
      }
      const plugin_versions =
        request.adapter === "copilot-marketplace"
          ? yield* readCopilotMarketplace(cached.directory, request.marketplace, request.select)
          : yield* readClaudeMarketplace(cached.directory, request.marketplace, request.select)
      return { ...resolution, plugin_versions }
    }),
  resolvePackages: ({ kind, selector, platform: requestedPlatform, packages, needsSkillsCli, claudeAdapter }) =>
    Effect.gen(function* () {
      if (requestedPlatform !== platform) return yield* Effect.fail("resolver platform mismatch")
      const runtime = []
      for (const name of packages) {
        if (!Object.hasOwn(versions, name) || !Object.hasOwn(integrities, name)) {
          return yield* Effect.fail(`unsupported runtime package: ${name}`)
        }
        const version = versions[name]
        const integrity = integrities[name]
        if (!version || !integrity) return yield* Effect.fail(`unsupported runtime package: ${name}`)
        runtime.push({ name, version, integrity })
      }
      const harness =
        kind === "copilot"
          ? yield* resolveCopilotRelease(selector, requestedPlatform)
          : kind === "pi"
            ? yield* resolvePiRelease(selector, requestedPlatform)
            : kind === "claude"
              ? yield* resolveClaudeRelease(selector, requestedPlatform)
              : yield* resolveCodexRelease(selector, requestedPlatform)
      const claudeCommonArtifacts = [...arm64ArtifactCatalog.fixedArtifacts]
      const artifacts =
        kind === "claude"
          ? claudeAdapter === "hyperresearch"
            ? [...claudeCommonArtifacts, ...arm64ArtifactCatalog.hyperresearchArtifacts]
            : claudeCommonArtifacts
          : undefined
      return {
        harness,
        ...(needsSkillsCli
          ? {
              skills_cli_version: "1.5.19",
              skills_cli_integrity:
                "sha512-SR05cbNk+R17GfaCFv94Hlq5EXDpUCbG0ZL9+EYi5UEHzUPAAl+kls2LxCT+67wAWlOAanUwzZekIVQvpCmp5w==",
            }
          : {}),
        runtime,
        ...(artifacts === undefined
          ? {}
          : {
              artifacts,
              ...(claudeAdapter === "hyperresearch"
                ? {
                    python_lock_integrity: arm64ArtifactCatalog.hyperresearchPythonLockIntegrity,
                  }
                : {}),
            }),
      }
    }),
  resolveBase: ({ reference, platform: requestedPlatform }) => {
    if (requestedPlatform !== platform) return Effect.fail("resolver platform mismatch")
    if (reference === arm64ArtifactCatalog.base.reference && requestedPlatform === "linux/arm64") {
      return Effect.succeed(arm64ArtifactCatalog.base)
    }
    return Effect.fail(`unsupported base image resolution: ${reference} (${requestedPlatform})`)
  },
})
