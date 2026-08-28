import { createHash } from "node:crypto"
import path from "node:path"

import { Data, Effect } from "effect"

import type { InventoryEntry } from "./inventory.js"
import { claudePypiToolNames, isClaudeProfile, type ProfileDocument } from "./profile.js"
import { assertProductionPlatform, productionPlatforms, type Platform } from "./platform.js"
import { arm64ArtifactCatalog, extraClaudeMarketplaceArtifacts, lockedArtifactError } from "./artifact-catalog.js"

const legacySourceProvenance = Symbol("legacySourceProvenance")
const persistedLockProvenance = Symbol("persistedLockProvenance")

interface LegacyLockProvenance {
  readonly packages: true
  readonly sourceIndexes: ReadonlyArray<number>
}

export interface SourceLock {
  readonly kind: "plugin" | "harness"
  readonly adapter:
    | "claude-marketplace"
    | "codex-native"
    | "copilot-marketplace"
    | "headlong"
    | "hyperresearch"
    | "prime-extension"
    | "wshobson-agents"
  readonly marketplace?: string
  readonly plugin_versions?: Readonly<Record<string, string>>
  readonly package_version?: string
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
  | {
      readonly kind: "prime"
      readonly selector: string
      readonly version: string
      readonly integrity: string
      readonly url: string
      readonly size: number
    }
  | {
      readonly kind: "headlong"
      readonly selector: string
      readonly commit: string
      readonly integrity: string
    }

export type ReleaseHarnessPackageLock = Exclude<HarnessPackageLock, { readonly kind: "headlong" }>

export const harnessPackageRevision = (harness: HarnessPackageLock): string =>
  harness.kind === "headlong" ? harness.commit : harness.version

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
  readonly package_version?: string
}

export interface LockResolvers {
  readonly platform: Platform
  readonly resolveSource: (request: {
    readonly kind: "plugin" | "harness"
    readonly adapter:
      | "claude-marketplace"
      | "codex-native"
      | "copilot-marketplace"
      | "headlong"
      | "hyperresearch"
      | "prime-extension"
      | "wshobson-agents"
    readonly marketplace?: string
    readonly repository: string
    readonly ref: string
    readonly select: ReadonlyArray<string>
    readonly previousCommit?: string
    readonly update: boolean
  }) => Effect.Effect<SourceResolution, unknown>
  readonly resolvePackages: (request: {
    readonly kind: "claude" | "codex" | "copilot" | "headlong" | "pi" | "prime"
    readonly selector: string
    readonly platform: "linux/arm64" | "linux/amd64"
    readonly packages: ReadonlyArray<string>
    readonly claudeAdapter?: "claude-marketplace" | "hyperresearch"
    readonly extraArtifacts?: ReadonlyArray<ArtifactLock>
    readonly extraPythonLockIntegrity?: string
    readonly headlongSource?: Pick<SourceLock, "commit" | "integrity">
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
    [document.source, document.initialPromptIntegrity, document.floatingSkillPolicy]
      .filter((value): value is string => value !== undefined)
      .join("\u0000"),
  )

type SourceRequest = Pick<SourceLock, "kind" | "adapter" | "marketplace" | "repository" | "ref" | "select">

const sameSource = (current: SourceLock, requested: SourceRequest): boolean =>
  current.kind === requested.kind &&
  current.adapter === requested.adapter &&
  current.marketplace === requested.marketplace &&
  current.repository === requested.repository &&
  current.ref === requested.ref &&
  JSON.stringify(current.select) === JSON.stringify(requested.select)

const sourceRequests = (document: ProfileDocument): Array<SourceRequest> => {
  const plugins = document.profile.plugins.map((plugin) => ({
    kind: "plugin" as const,
    adapter: plugin.adapter,
    ...("marketplace" in plugin ? { marketplace: plugin.marketplace } : {}),
    repository: plugin.repository,
    ref: plugin.ref,
    select: plugin.select,
  }))
  return document.profile.harness.kind === "headlong"
    ? [
        ...plugins,
        {
          kind: "harness",
          adapter: "headlong",
          repository: "https://github.com/laude-institute/headlong.git",
          ref: "main",
          select: [],
        } as const,
      ]
    : plugins
}

const sha256Pattern = /^sha256:[0-9a-f]{64}$/
const commitPattern = /^[0-9a-f]{40}$/
const exactSemverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const stableSemverPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const exactRuntimeVersionPattern = /^(?:[0-9]+:)?[0-9][0-9A-Za-z.+~]*(?:-[0-9A-Za-z.+~]+)?$/
const runtimeWildcardPattern = /(?:^|[.+:~-])[xX*](?=$|[.+:~-])/
const safePluginKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const dangerousPluginKeys = new Set(["__proto__", "prototype", "constructor"])

export const isExactSemver = (version: string): boolean => exactSemverPattern.test(version)

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

const hasFloatingSkills = (document: ProfileDocument): boolean => document.profile.skill_bundles.length > 0

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

const validateLockIdentity = (
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
  return undefined
}

const harnessLabels: Readonly<Record<HarnessPackageLock["kind"], string>> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  headlong: "Headlong",
  pi: "Pi",
  prime: "Prime",
}

const expectedHarnessUrl = (harness: ReleaseHarnessPackageLock, platform: Platform): string => {
  if (harness.kind === "copilot") {
    const asset = platform === "linux/arm64" ? "copilot-linux-arm64.tar.gz" : "copilot-linux-x64.tar.gz"
    return `https://github.com/github/copilot-cli/releases/download/v${harness.version}/${asset}`
  }
  if (harness.kind === "pi") {
    const asset = platform === "linux/arm64" ? "omp-linux-arm64" : "omp-linux-x64"
    return `https://github.com/can1357/oh-my-pi/releases/download/v${harness.version}/${asset}`
  }
  if (harness.kind === "prime") {
    return `https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v${harness.version}/prime-agent-${harness.version}.tgz`
  }
  if (harness.kind === "claude") {
    const asset = platform === "linux/arm64" ? "claude-linux-arm64.tar.gz" : "claude-linux-x64.tar.gz"
    return `https://github.com/anthropics/claude-code/releases/download/v${harness.version}/${asset}`
  }
  const asset =
    platform === "linux/arm64" ? "codex-aarch64-unknown-linux-musl.tar.gz" : "codex-x86_64-unknown-linux-musl.tar.gz"
  return `https://github.com/openai/codex/releases/download/rust-v${harness.version}/${asset}`
}

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

const validateHeadlongHarnessPackage = (
  current: ProfileLock,
  harness: Extract<HarnessPackageLock, { readonly kind: "headlong" }>,
): string | undefined => {
  const source = current.sources.find((candidate) => candidate.kind === "harness" && candidate.adapter === "headlong")
  if (source === undefined) return "Headlong harness source is missing"
  if (!commitPattern.test(harness.commit)) return "Headlong package commit is invalid"
  if (harness.commit !== source.commit) return "Headlong package commit does not match harness source"
  if (!sha256Pattern.test(harness.integrity)) return "Headlong package integrity is missing or invalid"
  return harness.integrity === source.integrity ? undefined : "Headlong package integrity does not match harness source"
}

const validateReleaseHarnessPackage = (harness: ReleaseHarnessPackageLock, platform: Platform): string | undefined => {
  const harnessLabel = harnessLabels[harness.kind]
  if (!stableSemverPattern.test(harness.version)) return `${harnessLabel} package version is not stable`
  if (harness.selector !== "latest" && harness.version !== harness.selector) {
    return "explicit harness selector does not match resolved version"
  }
  if (harness.url !== expectedHarnessUrl(harness, platform)) return `${harnessLabel} package artifact URL is invalid`
  if (!sha256Pattern.test(harness.integrity)) {
    return `${harnessLabel} package integrity is missing or invalid`
  }
  if (!isHttpsUrl(harness.url)) return `${harnessLabel} package URL is missing or invalid`
  if (!Number.isSafeInteger(harness.size) || harness.size <= 0) {
    return `${harnessLabel} package size is missing or invalid`
  }
  return undefined
}

const validateHarnessPackage = (
  document: ProfileDocument,
  current: ProfileLock,
  platform: Platform,
): string | undefined => {
  const harness = current.packages.harness
  const harnessLabel = harnessLabels[harness.kind]
  if (harness.kind !== document.profile.harness.kind) return "harness package kind does not match profile"
  if (harness.selector.length === 0) return `${harnessLabel} package selector is missing`
  return harness.kind === "headlong"
    ? validateHeadlongHarnessPackage(current, harness)
    : validateReleaseHarnessPackage(harness, platform)
}

interface ArtifactValidation {
  readonly names: ReadonlySet<string>
  readonly error?: string
}

const isArtifactUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol
    return protocol === "https:" || protocol === "oci:"
  } catch {
    return false
  }
}

const validateArtifactList = (current: ProfileLock): ArtifactValidation => {
  const artifactNames = new Set<string>()
  for (const artifact of current.packages.artifacts ?? []) {
    if (artifactNames.has(artifact.name)) return { names: artifactNames, error: `duplicate artifact: ${artifact.name}` }
    artifactNames.add(artifact.name)
    if (!sha256Pattern.test(artifact.integrity)) {
      return { names: artifactNames, error: `artifact integrity is invalid: ${artifact.name}` }
    }
    if (artifact.name.length === 0 || artifact.version.length === 0) {
      return { names: artifactNames, error: "artifact identity is incomplete" }
    }
    if (artifact.size !== undefined && (!Number.isSafeInteger(artifact.size) || artifact.size <= 0)) {
      return { names: artifactNames, error: `artifact size is invalid: ${artifact.name}` }
    }
    if (!isArtifactUrl(artifact.url)) {
      return { names: artifactNames, error: `artifact URL is invalid: ${artifact.name}` }
    }
  }
  return { names: artifactNames }
}

const missingArtifact = (names: ReadonlySet<string>, required: ReadonlyArray<string>): string | undefined => {
  for (const name of required) {
    if (!names.has(name)) return name
  }
  return undefined
}

const validateClaudePythonIntegrity = (integrity: string | undefined): string | undefined => {
  if (!sha256Pattern.test(integrity ?? "")) return "Python dependency lock integrity is missing or invalid"
}

const validateClaudeMarketplaceArtifacts = (
  document: ProfileDocument,
  current: ProfileLock,
  artifactNames: ReadonlySet<string>,
): string | undefined => {
  const extraPython = isClaudeProfile(document.profile) && claudePypiToolNames(document.profile).length > 0
  if (!extraPython) {
    return current.packages.python_lock_integrity === undefined
      ? undefined
      : "Python dependency lock requires Hyperresearch"
  }
  const integrityError = validateClaudePythonIntegrity(current.packages.python_lock_integrity)
  if (integrityError !== undefined) return integrityError
  return missingArtifact(artifactNames, ["python"]) === undefined
    ? undefined
    : "required Claude artifact is missing: python"
}

const validateHyperresearchArtifacts = (
  current: ProfileLock,
  artifactNames: ReadonlySet<string>,
): string | undefined => {
  const integrityError = validateClaudePythonIntegrity(current.packages.python_lock_integrity)
  if (integrityError !== undefined) return integrityError
  const missingHyperresearch = missingArtifact(artifactNames, [
    "python",
    "playwright-mcp",
    "playwright",
    "playwright-core",
    "chromium",
    "chromium-headless-shell",
    "obscura",
  ])
  return missingHyperresearch === undefined ? undefined : `required Claude artifact is missing: ${missingHyperresearch}`
}

const validateClaudeArtifacts = (
  document: ProfileDocument,
  current: ProfileLock,
  artifactNames: ReadonlySet<string>,
): string | undefined => {
  if (current.packages.harness.kind !== "claude") return undefined
  const missingCommon = missingArtifact(artifactNames, ["node", "builder-oci", "skopeo-oci"])
  if (missingCommon !== undefined) return `required Claude artifact is missing: ${missingCommon}`
  const claudeAdapter = document.profile.harness.kind === "claude" ? document.profile.plugins[0]?.adapter : undefined
  if (claudeAdapter === "hyperresearch") return validateHyperresearchArtifacts(current, artifactNames)
  return validateClaudeMarketplaceArtifacts(document, current, artifactNames)
}

const codexCodeModeHostUrl = (version: string, platform: Platform): string => {
  const asset =
    platform === "linux/arm64"
      ? "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz"
      : "codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz"
  return `https://github.com/openai/codex/releases/download/rust-v${version}/${asset}`
}

const validateCodexArtifacts = (current: ProfileLock, platform: Platform): string | undefined => {
  const harness = current.packages.harness
  if (harness.kind !== "codex") return undefined
  if (!hasLegacyPackageProvenance(current)) {
    const artifacts = current.packages.artifacts ?? []
    const codeModeHost = artifacts.find((artifact) => artifact.name === "codex-code-mode-host")
    if (codeModeHost === undefined) return "required Codex artifact is missing: codex-code-mode-host"
    if (artifacts.length !== 1) return "Codex artifact locks require exactly one artifact: codex-code-mode-host"
    if (codeModeHost.version !== harness.version) {
      return "Codex code-mode host artifact version does not match harness version"
    }
    if (codeModeHost.url !== codexCodeModeHostUrl(harness.version, platform)) {
      return "Codex code-mode host artifact URL is invalid"
    }
  }
  return current.packages.python_lock_integrity === undefined
    ? undefined
    : "Python dependency lock requires the Claude harness"
}

const validateHeadlongArtifacts = (current: ProfileLock, artifactNames: ReadonlySet<string>): string | undefined => {
  if (current.packages.harness.kind !== "headlong") return undefined
  const missing = missingArtifact(artifactNames, ["node", "uv", "rust", "rust-std-musl"])
  if (missing !== undefined) return `required Headlong artifact is missing: ${missing}`
  if (artifactNames.size !== 4) return "Headlong artifact locks require exactly node, uv, rust, and rust-std-musl"
  return current.packages.python_lock_integrity === undefined
    ? undefined
    : "Python dependency lock requires the Claude harness"
}

const validateOtherHarnessArtifacts = (current: ProfileLock): string | undefined => {
  const kind = current.packages.harness.kind
  if (kind === "claude" || kind === "codex" || kind === "headlong") return undefined
  return current.packages.artifacts === undefined && current.packages.python_lock_integrity === undefined
    ? undefined
    : "Claude artifact locks require the Claude harness"
}

const validateRuntimePackages = (current: ProfileLock): string | undefined => {
  const runtimeNames = new Set<string>()
  for (const runtime of current.packages.runtime) {
    if (runtimeNames.has(runtime.name)) return `duplicate runtime package: ${runtime.name}`
    runtimeNames.add(runtime.name)
    if (!isExactRuntimeVersion(runtime.version)) return `runtime package version is not exact: ${runtime.name}`
    if (!sha256Pattern.test(runtime.integrity)) return `runtime package integrity is invalid: ${runtime.name}`
  }
  return undefined
}

const validatePluginVersions = (
  label: string,
  source: SourceLock,
  versions: Readonly<Record<string, string>>,
): string | undefined => {
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
    if (!isExactSemver(versions[key] ?? "")) return `${label} plugin version is not exact: ${key}`
  }
  return undefined
}

const marketplaceLabel = (source: SourceLock): string | undefined => {
  if (source.adapter === "copilot-marketplace") return "Copilot"
  if (source.adapter === "claude-marketplace") return "Claude"
  return undefined
}

const validateMarketplaceSource = (source: SourceLock, requested?: SourceRequest): string | undefined => {
  const label = marketplaceLabel(source)
  if (label === undefined) {
    return source.marketplace === undefined && source.plugin_versions === undefined
      ? undefined
      : `marketplace fields require a marketplace adapter: ${source.repository}`
  }
  if (!source.marketplace) return `${label} marketplace is missing: ${source.repository}`
  if (source.marketplace !== requested?.marketplace) {
    return `${label} marketplace does not match profile: ${source.repository}`
  }
  if (source.plugin_versions === undefined) return `${label} plugin versions are missing: ${source.repository}`
  return validatePluginVersions(label, source, source.plugin_versions)
}

const validateSourcePackageVersion = (source: SourceLock): string | undefined => {
  if (source.adapter === "hyperresearch") {
    if (source.package_version === undefined) {
      return `Hyperresearch package version is missing: ${source.repository}`
    }
    return isExactSemver(source.package_version)
      ? undefined
      : `Hyperresearch package version is not exact: ${source.repository}`
  }
  return source.package_version === undefined
    ? undefined
    : `package version requires the Hyperresearch adapter: ${source.repository}`
}

const unsafeInventoryPath = (filePath: string): boolean =>
  filePath.length === 0 ||
  filePath.startsWith("/") ||
  filePath.includes("\\") ||
  filePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")

const validateSourceInventory = (source: SourceLock): string | undefined => {
  const seen = new Set<string>()
  let previous = ""
  for (const file of source.files) {
    if (unsafeInventoryPath(file.path)) return `source inventory path is unsafe: ${file.path}`
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
  return undefined
}

const legacySourceIntegrity = (
  document: ProfileDocument,
  current: ProfileLock,
  source: SourceLock,
  sourceIndex: number,
): string | undefined => {
  const supportsLegacy =
    document.profile.harness.kind === "codex" &&
    hasLegacySourceProvenance(current, sourceIndex) &&
    source.files.every((file) => file.kind === "file" && file.executable !== true)
  if (!supportsLegacy) return undefined
  return sha256Text(
    JSON.stringify(
      source.files.map((file) => ({
        path: file.path,
        sha256: "sha256" in file ? file.sha256 : "",
      })),
    ),
  )
}

const validateSourceIntegrity = (
  document: ProfileDocument,
  current: ProfileLock,
  source: SourceLock,
  sourceIndex: number,
): string | undefined => {
  const expectedIntegrity = sha256Text(JSON.stringify(source.files))
  if (source.integrity === expectedIntegrity) return undefined
  return source.integrity === legacySourceIntegrity(document, current, source, sourceIndex)
    ? undefined
    : `source integrity mismatch: ${source.repository}`
}

const validateSourceIdentity = (source: SourceLock): string | undefined => {
  if (!commitPattern.test(source.commit)) return `source commit is invalid: ${source.repository}`
  if (commitPattern.test(source.ref) && source.ref !== source.commit) {
    return `exact source ref does not match commit: ${source.repository}`
  }
  return undefined
}

const validateSources = (document: ProfileDocument, current: ProfileLock): string | undefined => {
  const requestedSources = sourceRequests(document)
  for (const [sourceIndex, source] of current.sources.entries()) {
    const identityError = validateSourceIdentity(source)
    if (identityError !== undefined) return identityError
    const packageVersionError = validateSourcePackageVersion(source)
    if (packageVersionError !== undefined) return packageVersionError
    const marketplaceError = validateMarketplaceSource(source, requestedSources[sourceIndex])
    if (marketplaceError !== undefined) return marketplaceError
    const inventoryError = validateSourceInventory(source)
    if (inventoryError !== undefined) return inventoryError
    const integrityError = validateSourceIntegrity(document, current, source, sourceIndex)
    if (integrityError !== undefined) return integrityError
  }
  return undefined
}

const lockSemanticError = (
  document: ProfileDocument,
  current: ProfileLock,
  requireFinalDigest: boolean,
  platform: Platform,
): string | undefined => {
  const identityError = validateLockIdentity(current, requireFinalDigest, platform)
  if (identityError !== undefined) return identityError
  const harnessError = validateHarnessPackage(document, current, platform)
  if (harnessError !== undefined) return harnessError
  const artifacts = validateArtifactList(current)
  if (artifacts.error !== undefined) return artifacts.error
  const claudeArtifactError = validateClaudeArtifacts(document, current, artifacts.names)
  if (claudeArtifactError !== undefined) return claudeArtifactError
  const codexArtifactError = validateCodexArtifacts(current, platform)
  if (codexArtifactError !== undefined) return codexArtifactError
  const headlongArtifactError = validateHeadlongArtifacts(current, artifacts.names)
  if (headlongArtifactError !== undefined) return headlongArtifactError
  const otherArtifactError = validateOtherHarnessArtifacts(current)
  if (otherArtifactError !== undefined) return otherArtifactError
  const runtimeError = validateRuntimePackages(current)
  if (runtimeError !== undefined) return runtimeError
  const sourceError = validateSources(document, current)
  if (sourceError !== undefined) return sourceError
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

/**
 * Package resolution inputs that a profile edit may legitimately change.
 *
 * `lockMatchesProfile` is all-or-nothing: an edit to any unrelated field (a skill
 * entry, tmpfs size) makes it false and sends `compileLock` back to the network for
 * the harness release and the base image. Profiles that declare `version = "latest"`
 * then silently rebase onto whatever is current. Reuse is keyed on the inputs
 * `resolvePackages` actually consumes instead. The remaining Claude adapter
 * input is already validated against the document by
 * `lockSemanticError`, which every caller runs before offering a lock here.
 */
const reusablePackages = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  update: boolean,
  platform: Platform,
): ProfileLock["packages"] | undefined => {
  if (current === undefined || update) return undefined
  if (hasLegacyPackageProvenance(current)) return undefined
  if (current.platform !== platform) return undefined
  if (current.packages.harness.kind !== document.profile.harness.kind) return undefined
  if (current.packages.harness.selector !== document.profile.harness.version) return undefined
  if (
    JSON.stringify(current.packages.runtime.map((runtime) => runtime.name)) !==
    JSON.stringify(document.profile.image.packages)
  ) {
    return undefined
  }
  return current.packages
}

/** Base image reuse, keyed on the only input `resolveBase` consumes. */
const reusableBase = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  update: boolean,
  platform: Platform,
): { readonly reference: string; readonly digest: string } | undefined => {
  if (current === undefined || update) return undefined
  if (current.platform !== platform) return undefined
  if (current.image.base !== document.profile.image.base) return undefined
  return { reference: current.image.base, digest: current.image.base_digest }
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
    lockSemanticError(document, current, !hasFloatingSkills(document), selectedPlatform) === undefined &&
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
          adapter: request.adapter,
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

type PackageRequest = Parameters<LockResolvers["resolvePackages"]>[0]

const validCurrentLock = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  platform: Platform,
): ProfileLock | undefined =>
  current !== undefined && lockSemanticError(document, current, false, platform) === undefined ? current : undefined

const claudeLockAdapter = (document: ProfileDocument): PackageRequest["claudeAdapter"] => {
  if (document.profile.harness.kind !== "claude") return undefined
  const adapter = document.profile.plugins[0]?.adapter
  if (adapter === "hyperresearch" || adapter === "claude-marketplace") return adapter
}

const extraPackageFields = (
  document: ProfileDocument,
): Pick<PackageRequest, "extraArtifacts" | "extraPythonLockIntegrity"> => {
  const extraArtifacts = extraClaudeMarketplaceArtifacts(document)
  if (extraArtifacts.length === 0) return {}
  if (extraArtifacts.some((artifact) => artifact.name === "python")) {
    return { extraArtifacts, extraPythonLockIntegrity: arm64ArtifactCatalog.graphOfLoopsPythonLockIntegrity }
  }
  return { extraArtifacts }
}

const packageResolutionRequest = (
  document: ProfileDocument,
  platform: Platform,
  sources: ReadonlyArray<SourceLock>,
): PackageRequest => {
  const claudeAdapter = claudeLockAdapter(document)
  const headlongSource =
    document.profile.harness.kind === "headlong"
      ? sources.find((source) => source.kind === "harness" && source.adapter === "headlong")
      : undefined
  return {
    kind: document.profile.harness.kind,
    selector: document.profile.harness.version,
    platform,
    packages: document.profile.image.packages,
    ...(claudeAdapter === undefined ? {} : { claudeAdapter }),
    ...(headlongSource === undefined
      ? {}
      : { headlongSource: { commit: headlongSource.commit, integrity: headlongSource.integrity } }),
    ...extraPackageFields(document),
  }
}

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
    const validCurrent = validCurrentLock(document, current, platform)
    if (validCurrent !== undefined && lockMatchesProfile(document, validCurrent) && !update) return validCurrent
    const sources = yield* resolveSources(document, validCurrent, update, resolvers)
    const packages =
      reusablePackages(document, validCurrent, update, platform) ??
      (yield* resolvers
        .resolvePackages(packageResolutionRequest(document, platform, sources))
        .pipe(Effect.mapError((cause) => new LockError({ message: "package resolution failed", cause }))))
    const base =
      reusableBase(document, validCurrent, update, platform) ??
      (yield* resolvers
        .resolveBase({
          reference: document.profile.image.base,
          platform,
        })
        .pipe(Effect.mapError((cause) => new LockError({ message: "base image resolution failed", cause }))))
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
  const semanticError = lockSemanticError(document, current, !hasFloatingSkills(document), selectedPlatform)
  if (semanticError !== undefined)
    return Effect.fail(new LockError({ message: `lock is incomplete or invalid: ${semanticError}` }))
  if (!lockMatchesProfile(document, current)) return Effect.fail(new LockError({ message: "incompatible lock" }))
  return Effect.succeed(current)
}
