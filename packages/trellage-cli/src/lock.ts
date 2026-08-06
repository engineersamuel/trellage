import { createHash } from "node:crypto"
import path from "node:path"

import { Data, Effect } from "effect"

import type { InventoryEntry } from "./inventory.js"
import type { ProfileDocument } from "./profile.js"
import { assertProductionPlatform, productionPlatforms, type Platform } from "./platform.js"
import { lockedArtifactError } from "./artifact-catalog.js"

const legacySourceProvenance = Symbol("legacySourceProvenance")
const persistedLockProvenance = Symbol("persistedLockProvenance")

interface LegacyLockProvenance {
  readonly packages: true
  readonly sourceIndexes: ReadonlyArray<number>
}

export interface SourceLock {
  readonly kind: "skill" | "plugin"
  readonly adapter?:
    | "claude-marketplace"
    | "codex-native"
    | "copilot-marketplace"
    | "hyperresearch"
    | "omp-native"
    | "wshobson-agents"
  readonly marketplace?: string
  readonly plugin_versions?: Readonly<Record<string, string>>
  readonly repository: string
  readonly ref: string
  readonly select: ReadonlyArray<string>
  readonly commit: string
  readonly integrity: string
  readonly files: ReadonlyArray<InventoryEntry>
}

export type HarnessPackageLock =
  | {
      readonly kind: "codex"
      readonly selector: string
      readonly version: string
      readonly integrity: string
      readonly url: string
      readonly size: number
    }
  | {
      readonly kind: "copilot"
      readonly selector: string
      readonly version: string
      readonly integrity: string
      readonly url: string
      readonly size: number
    }
  | {
      readonly kind: "claude"
      readonly selector: string
      readonly version: string
      readonly integrity: string
      readonly url: string
      readonly size: number
    }
  | {
      readonly kind: "pi"
      readonly selector: string
      readonly version: string
      readonly integrity: string
      readonly url: string
      readonly size: number
    }

export interface ArtifactLock {
  readonly name: string
  readonly version: string
  readonly integrity: string
  readonly url: string
  readonly size?: number
}

export interface RuntimePackageLock {
  readonly name: string
  readonly version: string
  readonly integrity: string
}

export interface PackageLock {
  readonly harness: HarnessPackageLock
  readonly skills_cli_version?: string
  readonly skills_cli_integrity?: string
  readonly runtime: ReadonlyArray<RuntimePackageLock>
  readonly artifacts?: ReadonlyArray<ArtifactLock>
  readonly python_lock_integrity?: string
}

export interface ProfileLock {
  readonly schema: 1
  readonly platform: Platform
  readonly source_date_epoch: number
  readonly profile_hash: string
  readonly sources: ReadonlyArray<SourceLock>
  readonly packages: PackageLock
  readonly image: {
    readonly base: string
    readonly base_digest: string
    readonly final_digest?: string
  }
  readonly [legacySourceProvenance]?: LegacyLockProvenance
  readonly [persistedLockProvenance]?: true
}

export const markPersistedLock = (lock: ProfileLock): ProfileLock => {
  Object.defineProperty(lock, persistedLockProvenance, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return lock
}

const isPersistedLock = (lock: ProfileLock): boolean => lock[persistedLockProvenance] === true

export const markParsedLegacyProvenance = (lock: ProfileLock, sourceIndexes: ReadonlyArray<number>): ProfileLock => {
  Object.defineProperty(lock, legacySourceProvenance, {
    value: Object.freeze({ packages: true as const, sourceIndexes: Object.freeze([...sourceIndexes]) }),
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return lock
}

export const hasLegacyPackageProvenance = (lock: ProfileLock): boolean =>
  lock[legacySourceProvenance]?.packages === true

export const hasLegacySourceProvenance = (lock: ProfileLock, sourceIndex: number): boolean =>
  lock[legacySourceProvenance]?.sourceIndexes.includes(sourceIndex) === true

export const withFinalDigest = (lock: ProfileLock, finalDigest: string): ProfileLock => {
  const updated: ProfileLock = {
    ...lock,
    image: { ...lock.image, final_digest: finalDigest },
  }
  const provenance = lock[legacySourceProvenance]
  const preserved = provenance === undefined ? updated : markParsedLegacyProvenance(updated, provenance.sourceIndexes)
  return isPersistedLock(lock) ? markPersistedLock(preserved) : preserved
}

export interface SourceResolution {
  readonly commit: string
  readonly integrity: string
  readonly files: ReadonlyArray<InventoryEntry>
  readonly plugin_versions?: Readonly<Record<string, string>>
}

export interface LockResolvers {
  readonly platform: Platform
  readonly resolveSource: (request: {
    readonly kind: "skill" | "plugin"
    readonly adapter?:
      | "claude-marketplace"
      | "codex-native"
      | "copilot-marketplace"
      | "hyperresearch"
      | "omp-native"
      | "wshobson-agents"
    readonly marketplace?: string
    readonly repository: string
    readonly ref: string
    readonly select: ReadonlyArray<string>
    readonly previousCommit?: string
    readonly update: boolean
  }) => Effect.Effect<SourceResolution, unknown>
  readonly resolvePackages: (request: {
    readonly kind: "claude" | "codex" | "copilot" | "pi"
    readonly selector: string
    readonly platform: "linux/arm64" | "linux/amd64"
    readonly packages: ReadonlyArray<string>
    readonly needsSkillsCli: boolean
    readonly claudeAdapter?: "claude-marketplace" | "hyperresearch"
  }) => Effect.Effect<PackageLock, unknown>
  readonly resolveBase: (request: {
    readonly reference: string
    readonly platform: string
  }) => Effect.Effect<{ readonly reference: string; readonly digest: string }, unknown>
}

export class LockError extends Data.TaggedError("LockError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const sha256Text = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`

export const profileHash = (document: ProfileDocument): string =>
  sha256Text(
    document.initialPromptIntegrity === undefined
      ? document.source
      : `${document.source}\u0000${document.initialPromptIntegrity}`,
  )

type SourceRequest = Pick<SourceLock, "kind" | "adapter" | "marketplace" | "repository" | "ref" | "select">

const sameSource = (current: SourceLock, requested: SourceRequest): boolean =>
  current.kind === requested.kind &&
  current.adapter === requested.adapter &&
  current.marketplace === requested.marketplace &&
  current.repository === requested.repository &&
  current.ref === requested.ref &&
  JSON.stringify(current.select) === JSON.stringify(requested.select)

const sourceRequests = (document: ProfileDocument): Array<SourceRequest> => [
  ...document.profile.skills.map((skill) => ({
    kind: "skill" as const,
    ...(skill.adapter === undefined ? {} : { adapter: skill.adapter }),
    repository: skill.repository,
    ref: skill.ref,
    select: skill.select,
  })),
  ...document.profile.plugins.map((plugin) => ({
    kind: "plugin" as const,
    adapter: plugin.adapter,
    ...("marketplace" in plugin ? { marketplace: plugin.marketplace } : {}),
    repository: plugin.repository,
    ref: plugin.ref,
    select: plugin.select,
  })),
]

const sha256Pattern = /^sha256:[0-9a-f]{64}$/
const commitPattern = /^[0-9a-f]{40}$/
const sha512IntegrityPattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/
const exactSemverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const stableSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const exactRuntimeVersionPattern = /^(?:[0-9]+:)?[0-9][0-9A-Za-z.+~]*(?:-[0-9A-Za-z.+~]+)?$/
const runtimeWildcardPattern = /(?:^|[.+:~-])[xX*](?=$|[.+:~-])/
const safePluginKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const dangerousPluginKeys = new Set(["__proto__", "prototype", "constructor"])

const isExactRuntimeVersion = (version: string): boolean =>
  exactRuntimeVersionPattern.test(version) && !runtimeWildcardPattern.test(version)

const isSafePluginKey = (value: string): boolean =>
  safePluginKeyPattern.test(value) && !dangerousPluginKeys.has(value) && !Object.hasOwn(Object.prototype, value)

const sortedRecord = (record: Readonly<Record<string, string>>): Readonly<Record<string, string>> => {
  const sorted = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(record).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    sorted[key] = value
  }
  return Object.freeze(sorted)
}

const unsafeSymlinkTarget = (filePath: string, target: string): boolean => {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    /^[A-Za-z]:/.test(target) ||
    path.posix.isAbsolute(target) ||
    path.win32.isAbsolute(target)
  )
    return true
  const inventoryRoot = "/inventory"
  const resolved = path.posix.resolve(inventoryRoot, path.posix.dirname(filePath), target)
  const relative = path.posix.relative(inventoryRoot, resolved)
  return relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)
}

const lockSemanticError = (
  document: ProfileDocument,
  current: ProfileLock,
  requireFinalDigest: boolean,
  platform: Platform,
): string | undefined => {
  if (current.platform !== platform) {
    return `lock platform does not match Docker server: ${current.platform}`
  }
  if (!sha256Pattern.test(current.profile_hash)) return "profile hash is invalid"
  if (!sha256Pattern.test(current.image.base_digest)) return "base image digest is invalid"
  if (requireFinalDigest && current.image.final_digest === undefined) return "final OCI digest is missing"
  if (current.image.final_digest !== undefined && !sha256Pattern.test(current.image.final_digest)) {
    return "final OCI digest is invalid"
  }
  const harness = current.packages.harness
  const harnessLabel =
    harness.kind === "codex"
      ? "Codex"
      : harness.kind === "copilot"
        ? "Copilot"
        : harness.kind === "pi"
          ? "Pi"
          : "Claude"
  if (harness.kind !== document.profile.harness.kind) return "harness package kind does not match profile"
  if (harness.selector.length === 0) return `${harnessLabel} package selector is missing`
  if (!stableSemverPattern.test(harness.version)) return `${harnessLabel} package version is not stable`
  if (harness.selector !== "latest" && harness.version !== harness.selector) {
    return "explicit harness selector does not match resolved version"
  }
  if (harness.kind === "copilot") {
    const asset = platform === "linux/arm64" ? "copilot-linux-arm64.tar.gz" : "copilot-linux-x64.tar.gz"
    const expected = `https://github.com/github/copilot-cli/releases/download/v${harness.version}/${asset}`
    if (harness.url !== expected) return "Copilot package artifact URL is invalid"
  }
  if (harness.kind === "pi") {
    const asset = platform === "linux/arm64" ? "omp-linux-arm64" : "omp-linux-x64"
    const expected = `https://github.com/can1357/oh-my-pi/releases/download/v${harness.version}/${asset}`
    if (harness.url !== expected) return "Pi package artifact URL is invalid"
  }
  if (harness.kind === "claude") {
    const asset = platform === "linux/arm64" ? "claude-linux-arm64.tar.gz" : "claude-linux-x64.tar.gz"
    const expected = `https://github.com/anthropics/claude-code/releases/download/v${harness.version}/${asset}`
    if (harness.url !== expected) return "Claude package artifact URL is invalid"
  }
  if (harness.kind === "codex") {
    const asset =
      platform === "linux/arm64" ? "codex-aarch64-unknown-linux-musl.tar.gz" : "codex-x86_64-unknown-linux-musl.tar.gz"
    const expected = `https://github.com/openai/codex/releases/download/rust-v${harness.version}/${asset}`
    if (harness.url !== expected) return "Codex package artifact URL is invalid"
  }
  if (!sha256Pattern.test(harness.integrity)) {
    return `${harnessLabel} package integrity is missing or invalid`
  }
  try {
    if (new URL(harness.url).protocol !== "https:") {
      return `${harnessLabel} package URL is missing or invalid`
    }
  } catch {
    return `${harnessLabel} package URL is missing or invalid`
  }
  if (!Number.isSafeInteger(harness.size) || harness.size <= 0) {
    return `${harnessLabel} package size is missing or invalid`
  }
  const artifactNames = new Set<string>()
  for (const artifact of current.packages.artifacts ?? []) {
    if (artifactNames.has(artifact.name)) return `duplicate artifact: ${artifact.name}`
    artifactNames.add(artifact.name)
    if (!sha256Pattern.test(artifact.integrity)) return `artifact integrity is invalid: ${artifact.name}`
    if (artifact.name.length === 0 || artifact.version.length === 0) return "artifact identity is incomplete"
    if (artifact.size !== undefined && (!Number.isSafeInteger(artifact.size) || artifact.size <= 0)) {
      return `artifact size is invalid: ${artifact.name}`
    }
    try {
      const protocol = new URL(artifact.url).protocol
      if (protocol !== "https:" && protocol !== "oci:") return `artifact URL is invalid: ${artifact.name}`
    } catch {
      return `artifact URL is invalid: ${artifact.name}`
    }
  }
  if (harness.kind === "claude") {
    const claudeAdapter = document.profile.harness.kind === "claude" ? document.profile.plugins[0]?.adapter : undefined
    for (const name of ["node", "builder-oci", "skopeo-oci"]) {
      if (!artifactNames.has(name)) return `required Claude artifact is missing: ${name}`
    }
    if (claudeAdapter === "hyperresearch") {
      if (!sha256Pattern.test(current.packages.python_lock_integrity ?? "")) {
        return "Python dependency lock integrity is missing or invalid"
      }
      for (const name of [
        "python",
        "playwright-mcp",
        "playwright",
        "playwright-core",
        "chromium",
        "chromium-headless-shell",
        "obscura",
      ]) {
        if (!artifactNames.has(name)) return `required Claude artifact is missing: ${name}`
      }
    } else if (current.packages.python_lock_integrity !== undefined) {
      return "Python dependency lock requires Hyperresearch"
    }
  } else if (current.packages.artifacts !== undefined || current.packages.python_lock_integrity !== undefined) {
    return "Claude artifact locks require the Claude harness"
  }
  const needsSkillsCli = document.profile.skills.some((skill) => skill.adapter === undefined)
  if (needsSkillsCli && !current.packages.skills_cli_version) return "Skills CLI version is missing"
  if (
    current.packages.skills_cli_version !== undefined &&
    !exactSemverPattern.test(current.packages.skills_cli_version)
  ) {
    return "Skills CLI version is not exact"
  }
  if (needsSkillsCli && !sha512IntegrityPattern.test(current.packages.skills_cli_integrity ?? "")) {
    return "Skills CLI integrity is missing or invalid"
  }
  if (
    !needsSkillsCli &&
    current.packages.skills_cli_version !== undefined &&
    !sha512IntegrityPattern.test(current.packages.skills_cli_integrity ?? "")
  ) {
    return "Skills CLI integrity is invalid"
  }
  if (!needsSkillsCli && current.packages.skills_cli_integrity !== undefined && !current.packages.skills_cli_version) {
    return "Skills CLI version is missing"
  }
  const runtimeNames = new Set<string>()
  for (const runtime of current.packages.runtime) {
    if (runtimeNames.has(runtime.name)) return `duplicate runtime package: ${runtime.name}`
    runtimeNames.add(runtime.name)
    if (!isExactRuntimeVersion(runtime.version)) return `runtime package version is not exact: ${runtime.name}`
    if (!sha256Pattern.test(runtime.integrity)) return `runtime package integrity is invalid: ${runtime.name}`
  }
  const requestedSources = sourceRequests(document)
  for (const [sourceIndex, source] of current.sources.entries()) {
    if (!commitPattern.test(source.commit)) return `source commit is invalid: ${source.repository}`
    if (commitPattern.test(source.ref) && source.ref !== source.commit) {
      return `exact source ref does not match commit: ${source.repository}`
    }
    if (
      source.kind === "skill"
        ? source.adapter !== undefined && source.adapter !== "omp-native"
        : source.adapter === undefined || source.adapter === "omp-native"
    ) {
      return `source adapter is incompatible with source kind: ${source.repository}`
    }
    if (source.adapter === "copilot-marketplace" || source.adapter === "claude-marketplace") {
      const label = source.adapter === "copilot-marketplace" ? "Copilot" : "Claude"
      if (!source.marketplace) return `${label} marketplace is missing: ${source.repository}`
      if (source.marketplace !== requestedSources[sourceIndex]?.marketplace) {
        return `${label} marketplace does not match profile: ${source.repository}`
      }
      const versions = source.plugin_versions
      if (versions === undefined) return `${label} plugin versions are missing: ${source.repository}`
      for (const key of source.select) {
        if (!isSafePluginKey(key)) return `${label} plugin version key is unsafe: ${key}`
      }
      const keys = Object.keys(versions)
      for (const key of keys) {
        if (!isSafePluginKey(key)) return `${label} plugin version key is unsafe: ${key}`
      }
      const sortedKeys = [...keys].sort((left, right) => left.localeCompare(right, "en"))
      if (JSON.stringify(keys) !== JSON.stringify(sortedKeys)) {
        return `${label} plugin version keys are not sorted: ${source.repository}`
      }
      const selected = [...source.select].sort((left, right) => left.localeCompare(right, "en"))
      if (JSON.stringify(keys) !== JSON.stringify(selected)) {
        return `${label} plugin version keys do not match selections: ${source.repository}`
      }
      for (const key of keys) {
        if (!exactSemverPattern.test(versions[key] ?? "")) {
          return `${label} plugin version is not exact: ${key}`
        }
      }
    } else if (source.marketplace !== undefined || source.plugin_versions !== undefined) {
      return `marketplace fields require a marketplace adapter: ${source.repository}`
    }
    const seen = new Set<string>()
    let previous = ""
    for (const file of source.files) {
      if (
        file.path.length === 0 ||
        file.path.startsWith("/") ||
        file.path.includes("\\") ||
        file.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        return `source inventory path is unsafe: ${file.path}`
      }
      if (seen.has(file.path)) return `duplicate source inventory path: ${file.path}`
      if (previous.localeCompare(file.path, "en") > 0) return `source inventory is not sorted: ${file.path}`
      if (file.kind === "file") {
        if (!sha256Pattern.test(file.sha256)) return `source file hash is invalid: ${file.path}`
      } else if (unsafeSymlinkTarget(file.path, file.target)) {
        return `source symlink target is unsafe: ${file.path}`
      }
      seen.add(file.path)
      previous = file.path
    }
    const expectedIntegrity = sha256Text(JSON.stringify(source.files))
    if (source.integrity !== expectedIntegrity) {
      const legacyIntegrity =
        document.profile.harness.kind === "codex" &&
        hasLegacySourceProvenance(current, sourceIndex) &&
        source.files.every((file) => file.kind === "file" && file.executable !== true)
          ? sha256Text(
              JSON.stringify(
                source.files.map((file) => ({
                  path: file.path,
                  sha256: "sha256" in file ? file.sha256 : "",
                })),
              ),
            )
          : undefined
      if (source.integrity !== legacyIntegrity) return `source integrity mismatch: ${source.repository}`
    }
  }
  return isPersistedLock(current) ? lockedArtifactError(document, current, platform) : undefined
}

const lockMatchesProfile = (document: ProfileDocument, current: ProfileLock): boolean => {
  const requested = sourceRequests(document)
  return (
    current.profile_hash === profileHash(document) &&
    current.sources.length === requested.length &&
    requested.every((source, index) => sameSource(current.sources[index]!, source)) &&
    current.packages.harness.kind === document.profile.harness.kind &&
    current.packages.harness.selector === document.profile.harness.version &&
    JSON.stringify(current.packages.runtime.map((runtime) => runtime.name)) ===
      JSON.stringify(document.profile.image.packages) &&
    current.image.base === document.profile.image.base
  )
}

export const lockIsReady = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  platform?: Platform,
): boolean => {
  if (current === undefined) return false
  const selectedPlatform = platform ?? current.platform
  return (
    productionPlatforms.includes(selectedPlatform as "linux/arm64") &&
    lockSemanticError(document, current, true, selectedPlatform) === undefined &&
    lockMatchesProfile(document, current)
  )
}

const resolveSources = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  update: boolean,
  resolvers: LockResolvers,
): Effect.Effect<ReadonlyArray<SourceLock>, LockError> =>
  Effect.forEach(
    sourceRequests(document),
    (request) => {
      const compatibleIndex = current?.sources.findIndex((source) => sameSource(source, request)) ?? -1
      const compatible = compatibleIndex < 0 ? undefined : current?.sources[compatibleIndex]
      if (current !== undefined && compatible && !update && !hasLegacySourceProvenance(current, compatibleIndex)) {
        return Effect.succeed(compatible)
      }
      return resolvers
        .resolveSource({
          kind: request.kind,
          ...(request.adapter === undefined ? {} : { adapter: request.adapter }),
          ...(request.marketplace === undefined ? {} : { marketplace: request.marketplace }),
          repository: request.repository,
          ref: request.ref,
          select: request.select,
          update,
          ...(compatible === undefined ? {} : { previousCommit: compatible.commit }),
        })
        .pipe(
          Effect.map((resolution) => ({
            ...request,
            ...resolution,
            ...(resolution.plugin_versions === undefined
              ? {}
              : { plugin_versions: sortedRecord(resolution.plugin_versions) }),
          })),
          Effect.mapError(
            (cause) =>
              new LockError({ message: `source resolution failed: ${request.repository}@${request.ref}`, cause }),
          ),
        )
    },
    { concurrency: 1 },
  )

export const compileLock = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  update: boolean,
  resolvers: LockResolvers,
): Effect.Effect<ProfileLock, LockError> =>
  Effect.gen(function* () {
    const platform = resolvers.platform
    yield* assertProductionPlatform(platform).pipe(
      Effect.mapError((cause) => new LockError({ message: cause.message, cause })),
    )
    const hash = profileHash(document)
    const validCurrent =
      current !== undefined && lockSemanticError(document, current, false, platform) === undefined ? current : undefined
    if (validCurrent !== undefined && lockMatchesProfile(document, validCurrent) && !update) return validCurrent
    const sources = yield* resolveSources(document, validCurrent, update, resolvers)
    const claudeAdapter =
      document.profile.harness.kind === "claude" &&
      (document.profile.plugins[0]?.adapter === "hyperresearch" ||
        document.profile.plugins[0]?.adapter === "claude-marketplace")
        ? document.profile.plugins[0].adapter
        : undefined
    const packages = yield* resolvers
      .resolvePackages({
        kind: document.profile.harness.kind,
        selector: document.profile.harness.version,
        platform,
        packages: document.profile.image.packages,
        needsSkillsCli: document.profile.skills.some((skill) => skill.adapter === undefined),
        ...(claudeAdapter === undefined ? {} : { claudeAdapter }),
      })
      .pipe(Effect.mapError((cause) => new LockError({ message: "package resolution failed", cause })))
    const base = yield* resolvers
      .resolveBase({
        reference: document.profile.image.base,
        platform,
      })
      .pipe(Effect.mapError((cause) => new LockError({ message: "base image resolution failed", cause })))
    return {
      schema: 1,
      platform,
      source_date_epoch: 1784379906,
      profile_hash: hash,
      sources,
      packages,
      image: {
        base: base.reference,
        base_digest: base.digest,
      },
    }
  })

export const requireLocked = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  platform?: Platform,
): Effect.Effect<ProfileLock, LockError> => {
  if (current === undefined) return Effect.fail(new LockError({ message: "missing lock" }))
  const selectedPlatform = platform ?? current.platform
  if (current.platform !== selectedPlatform) {
    return Effect.fail(new LockError({ message: `lock platform does not match Docker server: ${current.platform}` }))
  }
  if (!productionPlatforms.includes(selectedPlatform as "linux/arm64")) {
    return Effect.fail(new LockError({ message: `production artifacts are unavailable for ${selectedPlatform}` }))
  }
  if (current.profile_hash !== profileHash(document)) return Effect.fail(new LockError({ message: "stale lock" }))
  const semanticError = lockSemanticError(document, current, true, selectedPlatform)
  if (semanticError !== undefined)
    return Effect.fail(new LockError({ message: `lock is incomplete or invalid: ${semanticError}` }))
  if (!lockMatchesProfile(document, current)) return Effect.fail(new LockError({ message: "incompatible lock" }))
  return Effect.succeed(current)
}
