import { Effect } from "effect"

import { arm64ArtifactCatalog } from "./artifact-catalog.js"
import { resolveClaudeRelease } from "./claude-release.js"
import { ClaudePluginError, pluginVersionFromRef, readClaudeMarketplace } from "./claude-plugin.js"
import { resolveCodexRelease } from "./codex-release.js"
import { CopilotPluginError, readCopilotMarketplace } from "./copilot-plugin.js"
import { resolveCopilotRelease } from "./copilot-release.js"
import { resolveGitHubSource } from "./github-cache.js"
import type { LockResolvers } from "./lock.js"
import { resolvePiRelease } from "./pi-release.js"
import { resolvePrimeRelease } from "./prime-release.js"
import { sourceIncludes, sourceInventoryPolicy } from "./source-policy.js"

const versions: Readonly<Record<string, string>> = arm64ArtifactCatalog.runtimeVersions
const integrities: Readonly<Record<string, string>> = arm64ArtifactCatalog.runtimeIntegrities

const resolveRuntimePackages = (packages: ReadonlyArray<string>) =>
  Effect.forEach(packages, (name) => {
    if (!Object.hasOwn(versions, name) || !Object.hasOwn(integrities, name)) {
      return Effect.fail(`unsupported runtime package: ${name}`)
    }
    const version = versions[name]
    const integrity = integrities[name]
    return !version || !integrity
      ? Effect.fail(`unsupported runtime package: ${name}`)
      : Effect.succeed({ name, version, integrity })
  })

const resolveHarnessPackages = (
  kind: Parameters<LockResolvers["resolvePackages"]>[0]["kind"],
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  claudeAdapter?: "claude-marketplace" | "hyperresearch",
) => {
  if (kind === "codex") {
    return resolveCodexRelease(selector, platform).pipe(
      Effect.map((release) => ({ harness: release.harness, artifacts: release.artifacts })),
    )
  }
  if (kind === "copilot") return resolveCopilotRelease(selector, platform).pipe(Effect.map((harness) => ({ harness })))
  if (kind === "pi") return resolvePiRelease(selector, platform).pipe(Effect.map((harness) => ({ harness })))
  if (kind === "prime") return resolvePrimeRelease(selector, platform).pipe(Effect.map((harness) => ({ harness })))
  return resolveClaudeRelease(selector, platform).pipe(
    Effect.map((harness) => ({
      harness,
      artifacts:
        claudeAdapter === "hyperresearch"
          ? [...arm64ArtifactCatalog.fixedArtifacts, ...arm64ArtifactCatalog.hyperresearchArtifacts]
          : [...arm64ArtifactCatalog.fixedArtifacts],
      ...(claudeAdapter === "hyperresearch"
        ? { python_lock_integrity: arm64ArtifactCatalog.hyperresearchPythonLockIntegrity }
        : {}),
    })),
  )
}

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
      if (request.adapter === "copilot-marketplace") {
        const plugin_versions = yield* readCopilotMarketplace(cached.directory, request.marketplace, request.select)
        return { ...resolution, plugin_versions }
      }
      const versionFallback = pluginVersionFromRef(request.ref)
      const plugin_versions = yield* readClaudeMarketplace(
        cached.directory,
        request.marketplace,
        request.select,
        versionFallback === undefined ? undefined : { versionFallback },
      )
      return { ...resolution, plugin_versions }
    }),
  resolvePackages: ({ kind, selector, platform: requestedPlatform, packages, claudeAdapter }) =>
    Effect.gen(function* () {
      if (requestedPlatform !== platform) return yield* Effect.fail("resolver platform mismatch")
      const runtime = yield* resolveRuntimePackages(packages)
      const resolved = yield* resolveHarnessPackages(kind, selector, requestedPlatform, claudeAdapter)
      return { ...resolved, runtime }
    }),
  resolveBase: ({ reference, platform: requestedPlatform }) => {
    if (requestedPlatform !== platform) return Effect.fail("resolver platform mismatch")
    if (reference === arm64ArtifactCatalog.base.reference && requestedPlatform === "linux/arm64") {
      return Effect.succeed(arm64ArtifactCatalog.base)
    }
    return Effect.fail(`unsupported base image resolution: ${reference} (${requestedPlatform})`)
  },
})
