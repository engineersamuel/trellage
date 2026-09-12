#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-env-file --no-install --config=/dev/null

import { createHash, type BinaryLike } from "node:crypto"
import type { Dirent, Stats } from "node:fs"
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

interface InventoryEntry {
  readonly path: string
  readonly sha256: string
  readonly executable: boolean
}

interface PluginSelection {
  readonly plugin: string
  readonly version: string
}

interface MarketplaceEntry {
  readonly marketplace: string
  readonly source: string
  readonly commit: string
  readonly selections: readonly PluginSelection[]
}

interface InstalledPluginRegistration {
  readonly scope: "user"
  readonly installPath: string
  readonly version: string
  readonly gitCommitSha: string
}

interface MarketplaceRegistration {
  readonly source: { readonly source: "directory"; readonly path: string }
  readonly installLocation: string
}

interface OnboardingDefaults {
  readonly hasCompletedOnboarding: boolean
  readonly lastOnboardingVersion: string
  readonly shiftEnterKeyBindingInstalled: boolean
}

type PluginOption = string | boolean | number
type ExpectedPluginConfigs = Record<string, Record<string, string>>
type PluginConfigs = Record<string, { options: Record<string, PluginOption> }>
type InstalledPlugins = Record<string, InstalledPluginRegistration[]>
type Marketplaces = Record<string, MarketplaceRegistration>

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const commitPattern = /^[0-9a-f]{40}$/
const dangerousIdentifiers = new Set(["__proto__", "prototype", "constructor"])
function fail(message: string): never {
  throw new Error(message)
}

const safeIdentifier = (value: string, label: string): void => {
  if (!identifierPattern.test(value) || dangerousIdentifiers.has(value) || Object.hasOwn(Object.prototype, value)) {
    fail(`unsafe ${label}`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const isMissing = (error: unknown): boolean => isRecord(error) && error.code === "ENOENT"
const hasControlCharacter = (value: string): boolean =>
  Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0)
    return codePoint <= 0x1f || codePoint === 0x7f
  })
const lexical = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)
const sha256 = (bytes: BinaryLike): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

const readJson = async (candidate: string, label: string): Promise<unknown> => {
  const status = await lstat(candidate)
  if (!status.isFile() || status.isSymbolicLink()) fail(`${label} must be a regular file`)
  try {
    return JSON.parse(await readFile(candidate, "utf8"))
  } catch {
    fail(`${label} is invalid`)
  }
}

/** Fail unless a plugin-relative path is safe: no absolute prefix, no backslashes, no empty/dot/dotdot segments. */
const assertSafePluginRelativePath = (relative: string): void => {
  if (
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`unsafe plugin path: ${relative}`)
  }
}

/** Fail unless `resolved` is contained within `resolvedRoot` (no escaping the plugin root via symlink or traversal). */
const assertPathContained = (resolvedRoot: string, resolved: string, relative: string, label: string): void => {
  const containment = path.relative(resolvedRoot, resolved)
  if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    fail(`${label}: ${relative}`)
  }
}

/** Resolve a plugin symlink to its real target, verifying it stays within the root and points at a regular file. */
const resolveSafePluginSymlink = async (
  absolute: string,
  relative: string,
  resolvedRoot: string,
): Promise<{ resolved: string; followed: Stats }> => {
  // Allow in-tree file symlinks (e.g. council skills/council/SKILL.md -> ../../SKILL.md).
  // Follow the link and hash target content so install may keep a symlink or materialize a file.
  let targetStatus: Stats
  try {
    targetStatus = await stat(absolute)
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      ["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(error.code)
    ) {
      fail(`plugin symlink target is broken: ${relative}`)
    }
    throw error
  }
  if (!targetStatus.isFile() && !targetStatus.isDirectory()) fail(`unsupported plugin symlink target: ${relative}`)
  let resolved: string
  try {
    resolved = await realpath(absolute)
  } catch {
    fail(`plugin symlink target is broken: ${relative}`)
  }
  assertPathContained(resolvedRoot, resolved, relative, "plugin symlink escapes root")
  const followed = await stat(resolved)
  if (followed.isDirectory()) fail(`plugin symlink to directory rejected: ${relative}`)
  if (!followed.isFile()) fail(`unsupported plugin symlink target: ${relative}`)
  return { resolved, followed }
}

/** Build the inventory entry for a plugin symlink, following it to hash its regular-file target content. */
const symlinkInventoryEntry = async (
  absolute: string,
  relative: string,
  resolvedRoot: string,
  prefix: string,
): Promise<InventoryEntry> => {
  const { resolved, followed } = await resolveSafePluginSymlink(absolute, relative, resolvedRoot)
  return {
    path: path.posix.join(prefix, relative),
    sha256: sha256(await readFile(resolved)),
    executable: (followed.mode & 0o111) !== 0,
  }
}

/** Materialize the inventory entry for one plugin directory child: recurse, hash, or fail on an unsafe entry. */
const visitPluginChild = async (
  child: Dirent,
  directory: string,
  relativeDirectory: string,
  resolvedRoot: string,
  prefix: string,
  entries: InventoryEntry[],
  visit: (directory: string, relativeDirectory: string) => Promise<void>,
): Promise<void> => {
  const absolute = path.join(directory, child.name)
  const relative = path.posix.join(relativeDirectory, child.name)
  assertSafePluginRelativePath(relative)
  const status = await lstat(absolute)
  if (status.isSymbolicLink()) {
    entries.push(await symlinkInventoryEntry(absolute, relative, resolvedRoot, prefix))
    return
  }
  // Bun 1.3.3 realpath can block on FIFOs.
  if (!status.isDirectory() && !status.isFile()) fail(`unsupported plugin entry: ${relative}`)
  const resolved = await realpath(absolute)
  assertPathContained(resolvedRoot, resolved, relative, "plugin path escapes root")
  if (status.isDirectory()) {
    await visit(absolute, relative)
    return
  }
  if (status.isFile()) {
    entries.push({
      path: path.posix.join(prefix, relative),
      sha256: sha256(await readFile(absolute)),
      executable: (status.mode & 0o111) !== 0,
    })
    return
  }
  fail(`unsupported plugin entry: ${relative}`)
}

const resolvePluginRoot = async (root: string): Promise<string> => {
  if (!(await stat(root)).isDirectory()) fail("plugin root must be a directory")
  return realpath(root)
}

const inventory = async (root: string, prefix = ""): Promise<InventoryEntry[]> => {
  const resolvedRoot = await resolvePluginRoot(root)
  const entries: InventoryEntry[] = []
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => lexical(left.name, right.name))
    for (const child of children) {
      await visitPluginChild(child, directory, relativeDirectory, resolvedRoot, prefix, entries, visit)
    }
  }
  await visit(root, "")
  return entries
}

/** Resolve one file symlink to a real regular-file target within the root, verifying containment and type. */
const resolveMaterializableSymlink = (
  absolute: string,
  resolvedRoot: string,
): Promise<{ resolved: string; followed: Stats }> =>
  resolveSafePluginSymlink(absolute, path.relative(resolvedRoot, absolute), resolvedRoot)

/** Replace one in-tree file symlink with a regular file holding the same content, mode, and executable bit. */
const materializeFileSymlink = async (absolute: string, resolvedRoot: string): Promise<void> => {
  const { resolved, followed } = await resolveMaterializableSymlink(absolute, resolvedRoot)
  const bytes = await readFile(resolved)
  const mode = followed.mode & 0o777
  await unlink(absolute)
  await writeFile(absolute, bytes, { mode: mode === 0 ? 0o644 : mode })
  if ((mode & 0o111) !== 0) await chmod(absolute, mode)
}

/** Materialize one directory child of a materialized-symlink tree: replace a file symlink, or recurse into a directory. */
const visitMaterializableChild = async (
  child: Dirent,
  directory: string,
  resolvedRoot: string,
  visit: (directory: string) => Promise<void>,
): Promise<void> => {
  const absolute = path.join(directory, child.name)
  const status = await lstat(absolute)
  if (status.isSymbolicLink()) {
    await materializeFileSymlink(absolute, resolvedRoot)
    return
  }
  if (status.isDirectory()) await visit(absolute)
}

/** Replace in-tree file symlinks with regular files so runtime managed-path checks pass. */
const materializeFileSymlinks = async (root: string): Promise<void> => {
  const resolvedRoot = await resolvePluginRoot(root)
  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => lexical(left.name, right.name))
    for (const child of children) {
      await visitMaterializableChild(child, directory, resolvedRoot, visit)
    }
  }
  await visit(root)
}

/** Parse and validate the finalizer's positional CLI arguments. */
const parseFinalizeArguments = (argv: readonly string[]) => {
  const [seed, manifestPath, harnessVersion, ...extra] = argv
  if (
    seed === undefined ||
    manifestPath === undefined ||
    harnessVersion === undefined ||
    !versionPattern.test(harnessVersion) ||
    extra.length > 0
  ) {
    fail("usage: finalize-claude-seed <seed> <marketplaces.json> <harness-version>")
  }
  return { seed, manifestPath, harnessVersion }
}

/** Fail unless the locked Claude marketplace manifest has the expected top-level shape. */
function assertValidManifestShape(manifest: unknown): asserts manifest is { marketplaces: unknown[] } {
  if (!isRecord(manifest) || !Array.isArray(manifest.marketplaces) || manifest.marketplaces.length === 0) {
    fail("locked Claude marketplace manifest is invalid")
  }
}

/** Validate and normalize one marketplace entry's locked plugin selections, registering plugin ids for uniqueness. */
const normalizePluginSelections = (
  candidates: readonly unknown[],
  marketplace: string,
  pluginIds: Set<string>,
): PluginSelection[] => {
  const selections: PluginSelection[] = []
  for (const selection of candidates) {
    if (!isRecord(selection) || typeof selection.plugin !== "string" || typeof selection.version !== "string") {
      fail("locked Claude plugin selection is invalid")
    }
    safeIdentifier(selection.plugin, "plugin identifier")
    if (!versionPattern.test(selection.version)) fail(`invalid plugin version: ${selection.plugin}`)
    const id = `${selection.plugin}@${marketplace}`
    if (pluginIds.has(id)) fail("duplicate Claude plugin selection")
    pluginIds.add(id)
    selections.push({ plugin: selection.plugin, version: selection.version })
  }
  selections.sort((left, right) => lexical(left.plugin, right.plugin))
  return selections
}

/** Validate and normalize one locked marketplace manifest entry, registering its name for uniqueness. */
const normalizeMarketplaceEntry = (
  candidate: unknown,
  marketplaceNames: Set<string>,
  pluginIds: Set<string>,
): MarketplaceEntry => {
  if (
    !isRecord(candidate) ||
    typeof candidate.marketplace !== "string" ||
    typeof candidate.source !== "string" ||
    !path.isAbsolute(candidate.source) ||
    typeof candidate.commit !== "string" ||
    !Array.isArray(candidate.plugins) ||
    candidate.plugins.length === 0
  ) {
    fail("locked Claude marketplace entry is invalid")
  }
  safeIdentifier(candidate.marketplace, "marketplace identifier")
  if (marketplaceNames.has(candidate.marketplace)) fail("duplicate Claude marketplace")
  marketplaceNames.add(candidate.marketplace)
  if (!commitPattern.test(candidate.commit)) fail("invalid source commit")
  return {
    marketplace: candidate.marketplace,
    source: candidate.source,
    commit: candidate.commit,
    selections: normalizePluginSelections(candidate.plugins, candidate.marketplace, pluginIds),
  }
}

/** Validate the locked Claude marketplace manifest and normalize it into a deterministically sorted marketplace list. */
const normalizeMarketplaceManifest = (manifest: unknown) => {
  assertValidManifestShape(manifest)
  const marketplaces: MarketplaceEntry[] = []
  const marketplaceNames = new Set<string>()
  const pluginIds = new Set<string>()
  for (const candidate of manifest.marketplaces) {
    marketplaces.push(normalizeMarketplaceEntry(candidate, marketplaceNames, pluginIds))
  }
  marketplaces.sort((left, right) => lexical(left.marketplace, right.marketplace))
  return { marketplaces, pluginIds }
}

const normalizeExpectedPluginConfig = (candidate: unknown, id: string): Record<string, string> => {
  if (!isRecord(candidate) || Object.keys(candidate).length === 0) {
    fail(`locked Claude plugin config is invalid: ${id}`)
  }
  const normalized: Record<string, string> = Object.create(null)
  for (const key of Object.keys(candidate).sort(lexical)) {
    safeIdentifier(key, "plugin config key")
    const value = candidate[key]
    if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
      fail(`locked Claude plugin config is invalid: ${id}`)
    }
    normalized[key] = value
  }
  return normalized
}

/** Read the optional profile-declared plugin config manifest written by the builder. */
const readExpectedPluginConfigs = async (
  manifestPath: string,
  pluginIds: ReadonlySet<string>,
): Promise<ExpectedPluginConfigs> => {
  const configPath = path.join(path.dirname(manifestPath), "claude-plugin-configs.json")
  let manifest: unknown
  try {
    manifest = await readJson(configPath, "locked Claude plugin config manifest")
  } catch (error) {
    if (isMissing(error)) return Object.create(null)
    throw error
  }
  if (!isRecord(manifest) || !isRecord(manifest.pluginConfigs)) {
    fail("locked Claude plugin config manifest is invalid")
  }
  const normalized: ExpectedPluginConfigs = Object.create(null)
  for (const id of Object.keys(manifest.pluginConfigs).sort(lexical)) {
    if (!pluginIds.has(id)) fail(`locked Claude plugin config has an unknown plugin: ${id}`)
    normalized[id] = normalizeExpectedPluginConfig(manifest.pluginConfigs[id], id)
  }
  return normalized
}

/** Fail unless the generated Claude settings.json enabled-plugin state matches the locked plugin selections. */
const assertGeneratedEnabledPluginsMatch = (settings: unknown, expectedEnabled: Record<string, boolean>): void => {
  if (!isRecord(settings)) fail("generated Claude enabled plugin state does not match locked selections")
  const generatedEnabled =
    settings.enabledPlugins !== null &&
    typeof settings.enabledPlugins === "object" &&
    !Array.isArray(settings.enabledPlugins)
      ? settings.enabledPlugins
      : {}
  if (
    JSON.stringify(Object.keys(generatedEnabled).sort(lexical)) !==
      JSON.stringify(Object.keys(expectedEnabled).sort(lexical)) ||
    Object.values(generatedEnabled).some((enabled) => enabled !== true)
  ) {
    fail("generated Claude enabled plugin state does not match locked selections")
  }
}

const normalizeGeneratedPluginOption = (
  value: unknown,
  expected: string | undefined,
  id: string,
  key: string,
): PluginOption => {
  const scalar =
    typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
  if (!scalar || String(value) !== expected) {
    fail(`generated Claude plugin config does not match profile: ${id}.${key}`)
  }
  return value
}

/** Validate Claude's typed plugin options against the profile strings and preserve only that exact state. */
const normalizeGeneratedPluginConfigs = (settings: unknown, expectedConfigs: ExpectedPluginConfigs): PluginConfigs => {
  if (!isRecord(settings)) fail("generated Claude plugin config is invalid")
  const generated = settings.pluginConfigs ?? {}
  if (!isRecord(generated)) fail("generated Claude plugin config is invalid")
  const expectedIds = Object.keys(expectedConfigs).sort(lexical)
  if (JSON.stringify(Object.keys(generated).sort(lexical)) !== JSON.stringify(expectedIds)) {
    fail("generated Claude plugin config does not match profile")
  }

  const normalized: PluginConfigs = Object.create(null)
  for (const [id, expected] of Object.entries(expectedConfigs).sort(([left], [right]) => lexical(left, right))) {
    const entry = generated[id]
    if (!isRecord(entry) || !isRecord(entry.options) || Object.keys(entry).some((key) => key !== "options")) {
      fail(`generated Claude plugin config is invalid: ${id}`)
    }
    const optionKeys = Object.keys(entry.options).sort(lexical)
    if (JSON.stringify(optionKeys) !== JSON.stringify(Object.keys(expected).sort(lexical))) {
      fail(`generated Claude plugin config does not match profile: ${id}`)
    }
    const options: Record<string, PluginOption> = Object.create(null)
    for (const key of optionKeys) {
      options[key] = normalizeGeneratedPluginOption(entry.options[key], expected[key], id, key)
    }
    normalized[id] = { options }
  }
  return normalized
}

/** Collect managed paths under one optional generated directory, tolerating a missing directory. */
const collectOptionalManagedDirectory = async (
  seed: string,
  dirName: string,
  prefix: string,
  label: string,
): Promise<string[]> => {
  const directory = path.join(seed, dirName)
  try {
    const status = await lstat(directory)
    if (!status.isDirectory() || status.isSymbolicLink()) fail(`generated Claude ${label} are unsafe`)
    return (await inventory(directory, prefix)).map(({ path: managedPath }) => managedPath)
  } catch (error) {
    if (!isMissing(error)) throw error
    return []
  }
}

/** Collect the managed path for one optional generated file, tolerating a missing file. */
const collectOptionalManagedFile = async (seed: string, fileName: string, label: string): Promise<string[]> => {
  const filePath = path.join(seed, fileName)
  try {
    const status = await lstat(filePath)
    if (!status.isFile() || status.isSymbolicLink()) fail(`generated Claude ${label} are unsafe`)
    return [fileName]
  } catch (error) {
    if (!isMissing(error)) throw error
    return []
  }
}

/** Collect every managed path contributed by generated generic skills, output styles, and instructions. */
const collectGeneratedManagedPaths = async (seed: string): Promise<string[]> => {
  const managed: string[] = []
  managed.push(...(await collectOptionalManagedDirectory(seed, "skills", "skills", "skills")))
  managed.push(...(await collectOptionalManagedDirectory(seed, "output-styles", "output-styles", "output styles")))
  managed.push(...(await collectOptionalManagedFile(seed, "CLAUDE.md", "instructions")))
  return managed.filter(
    (entry) => !["skills/.trellage-floating-skills", "skills/.trellage-floating-always-on.md"].includes(entry),
  )
}

/** Fail unless the generated installed-plugin registry has exactly one matching user-scope record. */
const verifyPluginRegistration = (installed: unknown, id: string, version: string): void => {
  const records = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins[id] : undefined
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    !isRecord(records[0]) ||
    records[0].scope !== "user" ||
    records[0].version !== version
  ) {
    fail(`generated Claude plugin registration is invalid: ${id}`)
  }
}

const sameInventoryEntry = (left: InventoryEntry, right: InventoryEntry): boolean =>
  left.path === right.path && left.sha256 === right.sha256 && left.executable === right.executable

const sourceInventoryByPath = (sourceInventory: readonly InventoryEntry[]): Map<string, InventoryEntry> => {
  const byPath = new Map<string, InventoryEntry>()
  for (const entry of sourceInventory) byPath.set(entry.path, entry)
  return byPath
}

/** Fail unless every installed cache file is pinned by the plugin source. npm lockfiles permit installer-generated node_modules content. */
const assertInstalledPluginMatchesSource = (
  cacheInventory: readonly InventoryEntry[],
  sourceInventory: readonly InventoryEntry[],
  id: string,
): void => {
  if (cacheInventory.length === 0) fail(`installed Claude plugin cache is empty: ${id}`)
  const sourceByPath = sourceInventoryByPath(sourceInventory)
  const permitsNodeModules = sourceByPath.has("package.json") && sourceByPath.has("package-lock.json")
  for (const entry of cacheInventory) {
    if (permitsNodeModules && entry.path.startsWith("node_modules/")) continue
    const sourceEntry = sourceByPath.get(entry.path)
    if (sourceEntry === undefined || !sameInventoryEntry(entry, sourceEntry)) {
      fail(`installed Claude plugin does not match locked marketplace source: ${id}`)
    }
  }
}

/** Verify one installed plugin's cache matches its locked marketplace source, then materialize its file symlinks. */
const materializeInstalledPluginCache = async (
  seed: string,
  marketplace: string,
  plugin: string,
  version: string,
  sourceInventory: readonly InventoryEntry[],
) => {
  const id = `${plugin}@${marketplace}`
  const cacheRelative = path.posix.join("plugins", "cache", marketplace, plugin, version)
  const cache = path.join(seed, ...cacheRelative.split("/"))
  const cacheInventory = await inventory(cache, cacheRelative)
  const relativeCacheInventory = cacheInventory.map((entry) => ({
    ...entry,
    path: entry.path.slice(cacheRelative.length + 1),
  }))
  assertInstalledPluginMatchesSource(relativeCacheInventory, sourceInventory, id)
  // Runtime seed validation requires managed paths to be regular non-symlink files.
  // Compare inventories first (content-following), then materialize cache links in place.
  await materializeFileSymlinks(cache)
  return {
    installPath: `/home/agent/.claude/${cacheRelative}`,
    managedPaths: cacheInventory.map(({ path: managedPath }) => managedPath),
  }
}

/** Resolve the locked plugin tree: marketplace root for `.`/`./`, otherwise a safe relative subdirectory. */
const pluginSourceDirectory = async (marketplaceRoot: string, pluginName: string): Promise<string> => {
  const metadata = await readJson(
    path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    "Claude marketplace metadata",
  )
  if (!isRecord(metadata) || !Array.isArray(metadata.plugins))
    fail("Claude marketplace metadata plugins array is missing")
  const plugins: unknown[] = metadata.plugins
  const plugin = plugins.find((entry) => isRecord(entry) && entry.name === pluginName)
  if (!isRecord(plugin)) fail(`Claude plugin source is missing: ${pluginName}`)
  if (typeof plugin.source !== "string") {
    fail(`Claude plugin source must be a relative marketplace path: ${pluginName}`)
  }
  if (plugin.source === "." || plugin.source === "./") return marketplaceRoot
  const relative = plugin.source.startsWith("./") ? plugin.source.slice(2) : plugin.source
  assertSafePluginRelativePath(relative)
  return path.join(marketplaceRoot, ...relative.split("/"))
}

/** Materialize every locked plugin selection for one marketplace, returning its normalized marketplace entry. */
const materializeMarketplacePlugins = async (
  seed: string,
  marketplaceEntry: MarketplaceEntry,
  installed: unknown,
  normalizedPlugins: InstalledPlugins,
  managed: string[],
): Promise<MarketplaceRegistration> => {
  const { marketplace, source, commit, selections } = marketplaceEntry
  let marketplaceInstallPath: string | undefined
  for (const { plugin, version } of selections) {
    const id = `${plugin}@${marketplace}`
    verifyPluginRegistration(installed, id, version)
    const sourceInventory = await inventory(await pluginSourceDirectory(source, plugin))
    const { installPath, managedPaths } = await materializeInstalledPluginCache(
      seed,
      marketplace,
      plugin,
      version,
      sourceInventory,
    )
    managed.push(...managedPaths)
    marketplaceInstallPath ??= installPath
    normalizedPlugins[id] = [{ scope: "user", installPath, version, gitCommitSha: commit }]
  }
  if (marketplaceInstallPath === undefined) fail("locked Claude marketplace entry is invalid")
  return {
    source: { source: "directory", path: marketplaceInstallPath },
    installLocation: marketplaceInstallPath,
  }
}

/** Materialize every locked marketplace's plugin selections into the seed's plugin cache. */
const materializeAllMarketplacePlugins = async (
  seed: string,
  marketplaces: readonly MarketplaceEntry[],
  installed: unknown,
) => {
  const normalizedPlugins: InstalledPlugins = Object.create(null)
  const normalizedMarketplaces: Marketplaces = Object.create(null)
  const managed: string[] = []
  for (const marketplaceEntry of marketplaces) {
    normalizedMarketplaces[marketplaceEntry.marketplace] = await materializeMarketplacePlugins(
      seed,
      marketplaceEntry,
      installed,
      normalizedPlugins,
      managed,
    )
  }
  return { normalizedPlugins, normalizedMarketplaces, managed }
}

/** Write the normalized installed-plugin registry, marketplace registry, enabled-plugin state, and onboarding defaults. */
const writeFinalizedClaudeSeedFiles = async (
  seed: string,
  normalizedPlugins: InstalledPlugins,
  normalizedMarketplaces: Marketplaces,
  expectedEnabled: Record<string, boolean>,
  pluginConfigs: PluginConfigs,
  onboardingDefaults: OnboardingDefaults,
): Promise<void> => {
  await writeFile(
    path.join(seed, "plugins", "installed_plugins.json"),
    json({ version: 2, plugins: normalizedPlugins }),
    { mode: 0o600 },
  )
  await writeFile(path.join(seed, "plugin-marketplaces.json"), json(normalizedMarketplaces), { mode: 0o600 })
  const pluginSettings =
    Object.keys(pluginConfigs).length === 0
      ? { enabledPlugins: expectedEnabled }
      : { enabledPlugins: expectedEnabled, pluginConfigs }
  await writeFile(path.join(seed, "plugin-settings.json"), json(pluginSettings), { mode: 0o600 })
  await writeFile(path.join(seed, "default-onboarding.json"), json(onboardingDefaults), {
    mode: 0o600,
  })
}

/** Remove generator artifacts that must not persist into the finalized seed. */
const removeStaleGeneratedFiles = (seed: string) =>
  Promise.all([
    rm(path.join(seed, ".claude.json"), { force: true }),
    rm(path.join(seed, "backups"), { recursive: true, force: true }),
    rm(path.join(seed, "plugins", "known_marketplaces.json"), { force: true }),
    rm(path.join(seed, "settings.json"), { force: true }),
  ])

/** Append the installed-plugin registry to the managed set and write the sorted managed-paths manifest. */
const writeManagedPathsManifest = async (seed: string, managed: string[]): Promise<void> => {
  managed.push("plugins/installed_plugins.json")
  managed.sort(lexical)
  await writeFile(path.join(seed, "managed-paths.txt"), `${managed.join("\n")}\n`, { mode: 0o600 })
}

const allowedSeedEntries = new Set([
  "adopt-paths.txt",
  "default-onboarding.json",
  "default-settings.json",
  "default-user-settings.json",
  "CLAUDE.md",
  "managed-paths.txt",
  "plugin-marketplaces.json",
  "output-styles",
  "plugin-settings.json",
  "plugins",
  "skills",
])

/** Fail unless every top-level entry left in the finalized seed is expected. */
const assertOnlyAllowedSeedEntries = async (seed: string): Promise<void> => {
  for (const entry of await readdir(seed)) {
    if (!allowedSeedEntries.has(entry)) fail(`unexpected generated Claude state: ${entry}`)
  }
}

const main = async (): Promise<void> => {
  const { seed, manifestPath, harnessVersion } = parseFinalizeArguments(process.argv.slice(2))
  const onboardingDefaults = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: harnessVersion,
    shiftEnterKeyBindingInstalled: true,
  }
  const manifest = await readJson(manifestPath, "locked Claude marketplace manifest")
  const { marketplaces, pluginIds } = normalizeMarketplaceManifest(manifest)

  const expectedEnabled = Object.fromEntries([...pluginIds].sort(lexical).map((id) => [id, true]))
  const expectedPluginConfigs = await readExpectedPluginConfigs(manifestPath, pluginIds)
  const settings = await readJson(path.join(seed, "settings.json"), "generated Claude settings")
  assertGeneratedEnabledPluginsMatch(settings, expectedEnabled)
  const pluginConfigs = normalizeGeneratedPluginConfigs(settings, expectedPluginConfigs)

  const installed = await readJson(
    path.join(seed, "plugins", "installed_plugins.json"),
    "generated installed plugin registry",
  )

  const managed = await collectGeneratedManagedPaths(seed)
  const {
    normalizedPlugins,
    normalizedMarketplaces,
    managed: pluginManaged,
  } = await materializeAllMarketplacePlugins(seed, marketplaces, installed)
  managed.push(...pluginManaged)

  await writeFinalizedClaudeSeedFiles(
    seed,
    normalizedPlugins,
    normalizedMarketplaces,
    expectedEnabled,
    pluginConfigs,
    onboardingDefaults,
  )
  await removeStaleGeneratedFiles(seed)
  await writeManagedPathsManifest(seed, managed)
  await assertOnlyAllowedSeedEntries(seed)
  await mkdir(path.join(seed, "plugins"), { recursive: true })
}

if (import.meta.main) await main()
