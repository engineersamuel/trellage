import { readFile } from "node:fs/promises"
import path from "node:path"

import { parse } from "smol-toml"
import { Data, Effect } from "effect"

import { resolveClaudeRelease } from "./claude-release.js"
import {
  ClaudePluginError,
  pluginVersionFromCommit,
  pluginVersionFromRef,
  readClaudeMarketplace,
} from "./claude-plugin.js"
import { resolveCodexRelease } from "./codex-release.js"
import { CopilotPluginError, readCopilotMarketplace } from "./copilot-plugin.js"
import { resolveCopilotRelease } from "./copilot-release.js"
import { resolveGitHubSource } from "./github-cache.js"
import {
  isExactSemver,
  pythonConstraintsFromPackages,
  sha256Text,
  withPythonConstraints,
  type LockResolvers,
} from "./lock.js"
import { resolvePiRelease } from "./pi-release.js"
import { resolvePrimeRelease } from "./prime-release.js"
import { sourceIncludes, sourceInventoryPolicy } from "./source-policy.js"
import { resolveOciImage } from "./oci-image.js"
import { resolveNodeRelease } from "./node-release.js"
import { resolvePythonRelease } from "./python-release.js"
import { compilePythonConstraints, type PythonConstraintInput } from "./python-constraints.js"
import { resolveUvRelease } from "./uv-release.js"
import { resolveDebianPackages } from "./debian-packages.js"
import { resolveToolArtifacts } from "./tool-artifacts.js"
import { resolveGraphRustToolchain, resolveRustToolchain } from "./rust-release.js"
import { resolvePlaywrightRelease } from "./playwright-release.js"
import type { Platform } from "./platform.js"

export const developmentBuilderImage = "docker.io/jdxcode/mise:latest"
export const developmentImporterImage = "quay.io/skopeo/stable:latest"
const supportedBaseImage = /^node:(?:bookworm-slim|\d+\.\d+\.\d+-bookworm-slim)$/
const supportedRuntimePackages = new Set([
  "bash",
  "bubblewrap",
  "ca-certificates",
  "curl",
  "fish",
  "gh",
  "git",
  "jq",
  "libasound2",
  "libatk-bridge2.0-0",
  "libatk1.0-0",
  "libcairo2",
  "libcups2",
  "libdbus-1-3",
  "libgbm1",
  "libglib2.0-0",
  "libnspr4",
  "libnss-wrapper",
  "libnss3",
  "libpango-1.0-0",
  "libx11-6",
  "libxcb1",
  "libxcomposite1",
  "libxdamage1",
  "libxext6",
  "libxfixes3",
  "libxkbcommon0",
  "libxrandr2",
  "make",
  "ripgrep",
  "zsh",
])

class HyperresearchSourceError extends Data.TaggedError("HyperresearchSourceError")<{
  readonly message: string
}> {}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readHyperresearchPackageVersion = (directory: string): Effect.Effect<string, HyperresearchSourceError> =>
  Effect.tryPromise({
    try: async () => {
      const source = await readFile(path.join(directory, "pyproject.toml"), "utf8")
      const pyproject = parse(source) as unknown
      const project = isRecord(pyproject) && isRecord(pyproject.project) ? pyproject.project : undefined
      if (project === undefined || typeof project.version !== "string") {
        throw new HyperresearchSourceError({ message: "Hyperresearch package version is missing" })
      }
      if (!isExactSemver(project.version)) {
        throw new HyperresearchSourceError({
          message: `Hyperresearch package version is not exact: ${project.version}`,
        })
      }
      return project.version
    },
    catch: (cause) =>
      cause instanceof HyperresearchSourceError
        ? cause
        : new HyperresearchSourceError({
            message: `cannot read Hyperresearch package metadata: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
  })

const runtimeClosureIntegrity = (
  runtime: ReadonlyArray<{
    readonly name: string
    readonly version: string
    readonly integrity: string
    readonly size?: number
    readonly url?: string
    readonly direct?: boolean
  }>,
): string =>
  sha256Text(
    JSON.stringify(
      [...runtime]
        .sort((left, right) => left.name.localeCompare(right.name, "en"))
        .map(({ name, version, integrity, size, url, direct }) => ({
          name,
          version,
          integrity,
          size,
          url,
          direct,
        })),
    ),
  )

const resolveManagedTools = (platform: "linux/arm64" | "linux/amd64") =>
  Effect.all([resolveNodeRelease(platform), resolveUvRelease(platform)], { concurrency: 2 })

const resolveHeadlongPackages = (
  cacheHome: string,
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  headlongSource?: { readonly commit: string; readonly integrity: string },
) =>
  Effect.gen(function* () {
    if (headlongSource === undefined) return yield* Effect.fail("Headlong source resolution is missing")
    const managedTools = yield* resolveManagedTools(platform)
    return {
      harness: {
        kind: "headlong" as const,
        selector,
        commit: headlongSource.commit,
        integrity: headlongSource.integrity,
      },
      artifacts: [...managedTools, ...(yield* resolveRustToolchain(cacheHome, platform))],
    }
  })

const resolvePrimePackages = (
  cacheHome: string,
  npmRegistry: string | undefined,
  selector: string,
  platform: Platform,
) =>
  Effect.gen(function* () {
    const managedTools = yield* resolveManagedTools(platform)
    const uv = managedTools.find((artifact) => artifact.name === "uv")!
    const constraints = yield* compilePythonConstraints({
      cacheHome,
      input: { kind: "requirements", requirements: ["platformdirs"] },
      uvVersion: uv.version,
      pythonVersion: "3.11",
      platform,
      ...(npmRegistry === undefined ? {} : { npmRegistry }),
    })
    return withPythonConstraints(
      {
        harness: yield* resolvePrimeRelease(selector, platform),
        artifacts: managedTools,
        python_lock_integrity: sha256Text(constraints),
      },
      constraints,
    )
  })

const pythonConstraintInput = (
  pythonProjectPath: string | undefined,
  pythonRequirements: ReadonlyArray<string>,
): PythonConstraintInput | undefined => {
  if (pythonProjectPath !== undefined) return { kind: "project", path: pythonProjectPath }
  return pythonRequirements.length === 0 ? undefined : { kind: "requirements", requirements: pythonRequirements }
}

const resolveGeneratedConstraints = (options: {
  readonly cacheHome: string
  readonly npmRegistry?: string
  readonly platform: Platform
  readonly managedTools: ReadonlyArray<{ readonly name: string; readonly version: string }>
  readonly python: { readonly version: string } | undefined
  readonly input: PythonConstraintInput | undefined
}) => {
  if (options.python === undefined || options.input === undefined) return Effect.succeed(undefined)
  const uv = options.managedTools.find((artifact) => artifact.name === "uv")
  if (uv === undefined) return Effect.fail("uv resolution is missing")
  return compilePythonConstraints({
    cacheHome: options.cacheHome,
    input: options.input,
    uvVersion: uv.version,
    pythonVersion: options.python.version.split(".").slice(0, 2).join("."),
    platform: options.platform,
    ...(options.npmRegistry === undefined ? {} : { npmRegistry: options.npmRegistry }),
  }).pipe(Effect.map((content) => content as string | undefined))
}

const resolveClaudePackages = (
  cacheHome: string,
  npmRegistry: string | undefined,
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  claudeAdapter?: "claude-marketplace" | "hyperresearch",
  extraArtifactNames?: ReadonlyArray<string>,
  needsPython = false,
  pythonRequirements: ReadonlyArray<string> = [],
  pythonProjectPath?: string,
  needsGraphRustToolchain = false,
) =>
  Effect.gen(function* () {
    const managedTools = yield* resolveManagedTools(platform)
    if (claudeAdapter === "hyperresearch" && npmRegistry === undefined) {
      return yield* Effect.fail("npm registry is required for Playwright resolution")
    }
    const selectedExtraArtifacts =
      claudeAdapter === "hyperresearch"
        ? [
            ...(yield* resolvePlaywrightRelease({ cacheHome, registry: npmRegistry!, platform })),
            ...(yield* resolveToolArtifacts(cacheHome, platform, ["obscura"])),
          ]
        : yield* resolveToolArtifacts(cacheHome, platform, extraArtifactNames ?? [])
    const graphRustArtifacts = needsGraphRustToolchain ? yield* resolveGraphRustToolchain(cacheHome, platform) : []
    const python = claudeAdapter === "hyperresearch" || needsPython ? yield* resolvePythonRelease(platform) : undefined
    const constraints = yield* resolveGeneratedConstraints({
      cacheHome,
      ...(npmRegistry === undefined ? {} : { npmRegistry }),
      platform,
      managedTools,
      python,
      input: pythonConstraintInput(pythonProjectPath, pythonRequirements),
    })
    const packages = {
      harness: yield* resolveClaudeRelease(selector, platform),
      artifacts: [
        ...managedTools,
        ...selectedExtraArtifacts.filter((artifact) => artifact.name !== "python"),
        ...graphRustArtifacts,
        ...(python === undefined ? [] : [python]),
      ],
      ...(constraints === undefined ? {} : { python_lock_integrity: sha256Text(constraints) }),
    }
    return constraints === undefined ? packages : withPythonConstraints(packages, constraints)
  })

const resolveHarnessPackages = (
  cacheHome: string,
  npmRegistry: string | undefined,
  kind: Parameters<LockResolvers["resolvePackages"]>[0]["kind"],
  selector: string,
  platform: "linux/arm64" | "linux/amd64",
  claudeAdapter?: "claude-marketplace" | "hyperresearch",
  extraArtifactNames?: ReadonlyArray<string>,
  needsPython = false,
  pythonRequirements: ReadonlyArray<string> = [],
  pythonProjectPath?: string,
  headlongSource?: { readonly commit: string; readonly integrity: string },
  needsGraphRustToolchain = false,
) => {
  return Effect.gen(function* () {
    if (kind === "codex") {
      const [release, uv] = yield* Effect.all([resolveCodexRelease(selector, platform), resolveUvRelease(platform)], {
        concurrency: 2,
      })
      return { harness: release.harness, artifacts: [...release.artifacts, uv] }
    }
    if (kind === "copilot") {
      return {
        harness: yield* resolveCopilotRelease(selector, platform),
        artifacts: [yield* resolveNodeRelease(platform)],
      }
    }
    if (kind === "pi") return { harness: yield* resolvePiRelease(selector, platform) }
    if (kind === "prime") {
      return yield* resolvePrimePackages(cacheHome, npmRegistry, selector, platform)
    }
    if (kind === "headlong") return yield* resolveHeadlongPackages(cacheHome, selector, platform, headlongSource)
    return yield* resolveClaudePackages(
      cacheHome,
      npmRegistry,
      selector,
      platform,
      claudeAdapter,
      extraArtifactNames,
      needsPython,
      pythonRequirements,
      pythonProjectPath,
      needsGraphRustToolchain,
    )
  })
}

export const productionResolvers = (
  xdgCacheHome: string,
  platform: "linux/arm64" | "linux/amd64",
  npmRegistry = process.env.npm_config_registry,
): LockResolvers => {
  const resolvedSources = new Map<string, string>()
  return {
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
        resolvedSources.set(`${request.repository}\0${cached.commit}`, cached.directory)
        const resolution = {
          commit: cached.commit,
          integrity: cached.integrity,
          files: cached.files,
        }
        if (request.adapter === "hyperresearch") {
          const package_version = yield* readHyperresearchPackageVersion(cached.directory)
          return { ...resolution, package_version }
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
        const versionFallback = pluginVersionFromRef(request.ref) ?? pluginVersionFromCommit(cached.commit)
        const plugin_versions = yield* readClaudeMarketplace(
          cached.directory,
          request.marketplace,
          request.select,
          versionFallback === undefined ? undefined : { versionFallback },
        )
        return { ...resolution, plugin_versions }
      }),
    resolvePackages: ({
      kind,
      selector,
      platform: requestedPlatform,
      packages: runtimePackages,
      base,
      claudeAdapter,
      extraArtifactNames,
      needsPython,
      needsGraphRustToolchain,
      pythonRequirements,
      pythonProject,
      headlongSource,
    }) =>
      Effect.gen(function* () {
        if (requestedPlatform !== platform) return yield* Effect.fail("resolver platform mismatch")
        const unsupportedPackage = runtimePackages.find((name) => !supportedRuntimePackages.has(name))
        if (unsupportedPackage !== undefined) {
          return yield* Effect.fail(`unsupported runtime package: ${unsupportedPackage}`)
        }
        const resolvedBase = base ?? (yield* resolveOciImage("node:bookworm-slim", requestedPlatform))
        const runtimeResolution = yield* resolveDebianPackages(runtimePackages, resolvedBase, requestedPlatform)
        const pythonProjectPath =
          pythonProject === undefined
            ? undefined
            : path.join(
                resolvedSources.get(`${pythonProject.repository}\0${pythonProject.commit}`) ??
                  (yield* resolveGitHubSource(xdgCacheHome, {
                    repository: pythonProject.repository,
                    ref: pythonProject.ref,
                    lockedCommit: pythonProject.commit,
                    include: ["pyproject.toml"],
                    inventoryPolicy: {},
                  })).directory,
                "pyproject.toml",
              )
        const resolved = yield* resolveHarnessPackages(
          xdgCacheHome,
          npmRegistry,
          kind,
          selector,
          requestedPlatform,
          claudeAdapter,
          extraArtifactNames,
          needsPython,
          pythonRequirements,
          pythonProjectPath,
          headlongSource,
          needsGraphRustToolchain,
        )
        const packageLock = {
          ...resolved,
          runtime: runtimeResolution.runtime,
          runtime_direct: runtimeResolution.direct,
          runtime_closure_integrity: runtimeClosureIntegrity(runtimeResolution.runtime),
        }
        const constraints = pythonConstraintsFromPackages(resolved)
        return constraints === undefined ? packageLock : withPythonConstraints(packageLock, constraints)
      }),
    resolveBase: ({ reference, platform: requestedPlatform }) => {
      if (requestedPlatform !== platform) return Effect.fail("resolver platform mismatch")
      if (!supportedBaseImage.test(reference)) {
        return Effect.fail(`unsupported base image resolution: ${reference} (${requestedPlatform})`)
      }
      return resolveOciImage(reference, requestedPlatform)
    },
    resolveBuild: ({ platform: requestedPlatform }) =>
      requestedPlatform !== platform
        ? Effect.fail("resolver platform mismatch")
        : Effect.all(
            {
              builder: resolveOciImage(developmentBuilderImage, requestedPlatform),
              importer: resolveOciImage(developmentImporterImage, requestedPlatform),
            },
            { concurrency: 2 },
          ),
  }
}
