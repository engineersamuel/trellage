#!/usr/bin/env node

import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const commitPattern = /^[0-9a-f]{40}$/
const dangerousIdentifiers = new Set(["__proto__", "prototype", "constructor"])
const fail = (message) => {
  throw new Error(message)
}

const safeIdentifier = (value, label) => {
  if (
    !identifierPattern.test(value) ||
    dangerousIdentifiers.has(value) ||
    Object.hasOwn(Object.prototype, value)
  ) {
    fail(`unsafe ${label}`)
  }
}

const lexical = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const readJson = async (candidate, label) => {
  const status = await lstat(candidate)
  if (!status.isFile() || status.isSymbolicLink()) fail(`${label} must be a regular file`)
  try {
    return JSON.parse(await readFile(candidate, "utf8"))
  } catch {
    fail(`${label} is invalid`)
  }
}

/** Fail unless a plugin-relative path is safe: no absolute prefix, no backslashes, no empty/dot/dotdot segments. */
const assertSafePluginRelativePath = (relative) => {
  if (
    relative.startsWith("/") ||
    relative.includes("\\") ||
    relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`unsafe plugin path: ${relative}`)
  }
}

/** Fail unless `resolved` is contained within `resolvedRoot` (no escaping the plugin root via symlink or traversal). */
const assertPathContained = (resolvedRoot, resolved, relative, label) => {
  const containment = path.relative(resolvedRoot, resolved)
  if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    fail(`${label}: ${relative}`)
  }
}

/** Resolve a plugin symlink to its real target, verifying it stays within the root and points at a regular file. */
const resolveSafePluginSymlink = async (absolute, relative, resolvedRoot) => {
  // Allow in-tree file symlinks (e.g. council skills/council/SKILL.md -> ../../SKILL.md).
  // Follow the link and hash target content so install may keep a symlink or materialize a file.
  let resolved
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
const symlinkInventoryEntry = async (absolute, relative, resolvedRoot, prefix) => {
  const { resolved, followed } = await resolveSafePluginSymlink(absolute, relative, resolvedRoot)
  return {
    path: path.posix.join(prefix, relative),
    sha256: sha256(await readFile(resolved)),
    executable: (followed.mode & 0o111) !== 0,
  }
}

/** Materialize the inventory entry for one plugin directory child: recurse, hash, or fail on an unsafe entry. */
const visitPluginChild = async (child, directory, relativeDirectory, resolvedRoot, prefix, entries, visit) => {
  const absolute = path.join(directory, child.name)
  const relative = path.posix.join(relativeDirectory, child.name)
  assertSafePluginRelativePath(relative)
  const status = await lstat(absolute)
  if (status.isSymbolicLink()) {
    entries.push(await symlinkInventoryEntry(absolute, relative, resolvedRoot, prefix))
    return
  }
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

const inventory = async (root, prefix = "") => {
  const resolvedRoot = await realpath(root)
  const entries = []
  const visit = async (directory, relativeDirectory) => {
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
const resolveMaterializableSymlink = async (absolute, resolvedRoot) => {
  const relative = path.relative(resolvedRoot, absolute)
  let resolved
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

/** Replace one in-tree file symlink with a regular file holding the same content, mode, and executable bit. */
const materializeFileSymlink = async (absolute, resolvedRoot) => {
  const { resolved, followed } = await resolveMaterializableSymlink(absolute, resolvedRoot)
  const bytes = await readFile(resolved)
  const mode = followed.mode & 0o777
  await unlink(absolute)
  await writeFile(absolute, bytes, { mode: mode === 0 ? 0o644 : mode })
  if ((mode & 0o111) !== 0) await chmod(absolute, mode)
}

/** Materialize one directory child of a materialized-symlink tree: replace a file symlink, or recurse into a directory. */
const visitMaterializableChild = async (child, directory, resolvedRoot, visit) => {
  const absolute = path.join(directory, child.name)
  const status = await lstat(absolute)
  if (status.isSymbolicLink()) {
    await materializeFileSymlink(absolute, resolvedRoot)
    return
  }
  if (status.isDirectory()) await visit(absolute)
}

/** Replace in-tree file symlinks with regular files so runtime managed-path checks pass. */
const materializeFileSymlinks = async (root) => {
  const resolvedRoot = await realpath(root)
  const visit = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => lexical(left.name, right.name))
    for (const child of children) {
      await visitMaterializableChild(child, directory, resolvedRoot, visit)
    }
  }
  await visit(root)
}

/** Parse and validate the finalizer's positional CLI arguments. */
const parseFinalizeArguments = (argv) => {
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
const assertValidManifestShape = (manifest) => {
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !Array.isArray(manifest.marketplaces) ||
    manifest.marketplaces.length === 0
  ) {
    fail("locked Claude marketplace manifest is invalid")
  }
}

/** Validate and normalize one marketplace entry's locked plugin selections, registering plugin ids for uniqueness. */
const normalizePluginSelections = (candidate, pluginIds) => {
  const selections = []
  for (const selection of candidate.plugins) {
    if (
      selection === null ||
      typeof selection !== "object" ||
      Array.isArray(selection) ||
      typeof selection.plugin !== "string" ||
      typeof selection.version !== "string"
    ) {
      fail("locked Claude plugin selection is invalid")
    }
    safeIdentifier(selection.plugin, "plugin identifier")
    if (!versionPattern.test(selection.version)) fail(`invalid plugin version: ${selection.plugin}`)
    const id = `${selection.plugin}@${candidate.marketplace}`
    if (pluginIds.has(id)) fail("duplicate Claude plugin selection")
    pluginIds.add(id)
    selections.push({ plugin: selection.plugin, version: selection.version })
  }
  selections.sort((left, right) => lexical(left.plugin, right.plugin))
  return selections
}

/** Validate and normalize one locked marketplace manifest entry, registering its name for uniqueness. */
const normalizeMarketplaceEntry = (candidate, marketplaceNames, pluginIds) => {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
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
    selections: normalizePluginSelections(candidate, pluginIds),
  }
}

/** Validate the locked Claude marketplace manifest and normalize it into a deterministically sorted marketplace list. */
const normalizeMarketplaceManifest = (manifest) => {
  assertValidManifestShape(manifest)
  const marketplaces = []
  const marketplaceNames = new Set()
  const pluginIds = new Set()
  for (const candidate of manifest.marketplaces) {
    marketplaces.push(normalizeMarketplaceEntry(candidate, marketplaceNames, pluginIds))
  }
  marketplaces.sort((left, right) => lexical(left.marketplace, right.marketplace))
  return { marketplaces, pluginIds }
}

/** Fail unless the generated Claude settings.json enabled-plugin state matches the locked plugin selections. */
const assertGeneratedEnabledPluginsMatch = async (seed, expectedEnabled) => {
  const settings = await readJson(path.join(seed, "settings.json"), "generated Claude settings")
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

/** Collect managed paths under one optional generated directory, tolerating a missing directory. */
const collectOptionalManagedDirectory = async (seed, dirName, prefix, label) => {
  const directory = path.join(seed, dirName)
  try {
    const status = await lstat(directory)
    if (!status.isDirectory() || status.isSymbolicLink()) fail(`generated Claude ${label} are unsafe`)
    return (await inventory(directory, prefix)).map(({ path: managedPath }) => managedPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    return []
  }
}

/** Collect the managed path for one optional generated file, tolerating a missing file. */
const collectOptionalManagedFile = async (seed, fileName, label) => {
  const filePath = path.join(seed, fileName)
  try {
    const status = await lstat(filePath)
    if (!status.isFile() || status.isSymbolicLink()) fail(`generated Claude ${label} are unsafe`)
    return [fileName]
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
    return []
  }
}

/** Collect every managed path contributed by generated generic skills, output styles, and instructions. */
const collectGeneratedManagedPaths = async (seed) => {
  const managed = []
  managed.push(...(await collectOptionalManagedDirectory(seed, "skills", "skills", "skills")))
  managed.push(...(await collectOptionalManagedDirectory(seed, "output-styles", "output-styles", "output styles")))
  managed.push(...(await collectOptionalManagedFile(seed, "CLAUDE.md", "instructions")))
  return managed
}

/** Fail unless the generated installed-plugin registry has exactly one matching user-scope record. */
const verifyPluginRegistration = (installed, id, version) => {
  const records = installed?.plugins?.[id]
  if (
    !Array.isArray(records) ||
    records.length !== 1 ||
    records[0]?.scope !== "user" ||
    records[0]?.version !== version
  ) {
    fail(`generated Claude plugin registration is invalid: ${id}`)
  }
}

/** Verify one installed plugin's cache matches its locked marketplace source, then materialize its file symlinks. */
const materializeInstalledPluginCache = async (seed, marketplace, plugin, version, sourceInventory) => {
  const id = `${plugin}@${marketplace}`
  const cacheRelative = path.posix.join("plugins", "cache", marketplace, plugin, version)
  const cache = path.join(seed, ...cacheRelative.split("/"))
  const cacheInventory = await inventory(cache, cacheRelative)
  const relativeCacheInventory = cacheInventory.map((entry) => ({
    ...entry,
    path: entry.path.slice(cacheRelative.length + 1),
  }))
  if (JSON.stringify(relativeCacheInventory) !== JSON.stringify(sourceInventory)) {
    fail(`installed Claude plugin does not match locked marketplace source: ${id}`)
  }
  // Runtime seed validation requires managed paths to be regular non-symlink files.
  // Compare inventories first (content-following), then materialize cache links in place.
  await materializeFileSymlinks(cache)
  return {
    installPath: `/home/agent/.claude/${cacheRelative}`,
    managedPaths: cacheInventory.map(({ path: managedPath }) => managedPath),
  }
}

/** Materialize every locked plugin selection for one marketplace, returning its normalized marketplace entry. */
const materializeMarketplacePlugins = async (seed, marketplaceEntry, installed, normalizedPlugins, managed) => {
  const { marketplace, source, commit, selections } = marketplaceEntry
  const sourceInventory = await inventory(source)
  let marketplaceInstallPath
  for (const { plugin, version } of selections) {
    const id = `${plugin}@${marketplace}`
    verifyPluginRegistration(installed, id, version)
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
  return {
    source: { source: "directory", path: marketplaceInstallPath },
    installLocation: marketplaceInstallPath,
  }
}

/** Materialize every locked marketplace's plugin selections into the seed's plugin cache. */
const materializeAllMarketplacePlugins = async (seed, marketplaces, installed) => {
  const normalizedPlugins = Object.create(null)
  const normalizedMarketplaces = Object.create(null)
  const managed = []
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
  seed,
  normalizedPlugins,
  normalizedMarketplaces,
  expectedEnabled,
  onboardingDefaults,
) => {
  await writeFile(
    path.join(seed, "plugins", "installed_plugins.json"),
    json({ version: 2, plugins: normalizedPlugins }),
    { mode: 0o600 },
  )
  await writeFile(path.join(seed, "plugin-marketplaces.json"), json(normalizedMarketplaces), { mode: 0o600 })
  await writeFile(path.join(seed, "plugin-settings.json"), json({ enabledPlugins: expectedEnabled }), {
    mode: 0o600,
  })
  await writeFile(path.join(seed, "default-onboarding.json"), json(onboardingDefaults), {
    mode: 0o600,
  })
}

/** Remove generator artifacts that must not persist into the finalized seed. */
const removeStaleGeneratedFiles = (seed) =>
  Promise.all([
    rm(path.join(seed, ".claude.json"), { force: true }),
    rm(path.join(seed, "backups"), { recursive: true, force: true }),
    rm(path.join(seed, "plugins", "known_marketplaces.json"), { force: true }),
    rm(path.join(seed, "settings.json"), { force: true }),
  ])

/** Append the installed-plugin registry to the managed set and write the sorted managed-paths manifest. */
const writeManagedPathsManifest = async (seed, managed) => {
  managed.push("plugins/installed_plugins.json")
  managed.sort(lexical)
  await writeFile(path.join(seed, "managed-paths.txt"), `${managed.join("\n")}\n`, { mode: 0o600 })
}

const allowedSeedEntries = new Set([
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
const assertOnlyAllowedSeedEntries = async (seed) => {
  for (const entry of await readdir(seed)) {
    if (!allowedSeedEntries.has(entry)) fail(`unexpected generated Claude state: ${entry}`)
  }
}

const main = async () => {
  const { seed, manifestPath, harnessVersion } = parseFinalizeArguments(process.argv.slice(2))
  const onboardingDefaults = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: harnessVersion,
    theme: "dark",
    shiftEnterKeyBindingInstalled: true,
  }
  const manifest = await readJson(manifestPath, "locked Claude marketplace manifest")
  const { marketplaces, pluginIds } = normalizeMarketplaceManifest(manifest)

  const expectedEnabled = Object.fromEntries([...pluginIds].sort(lexical).map((id) => [id, true]))
  await assertGeneratedEnabledPluginsMatch(seed, expectedEnabled)

  const installed = await readJson(
    path.join(seed, "plugins", "installed_plugins.json"),
    "generated installed plugin registry",
  )

  const managed = await collectGeneratedManagedPaths(seed)
  const { normalizedPlugins, normalizedMarketplaces, managed: pluginManaged } = await materializeAllMarketplacePlugins(
    seed,
    marketplaces,
    installed,
  )
  managed.push(...pluginManaged)

  await writeFinalizedClaudeSeedFiles(
    seed,
    normalizedPlugins,
    normalizedMarketplaces,
    expectedEnabled,
    onboardingDefaults,
  )
  await removeStaleGeneratedFiles(seed)
  await writeManagedPathsManifest(seed, managed)
  await assertOnlyAllowedSeedEntries(seed)
  await mkdir(path.join(seed, "plugins"), { recursive: true })
}

await main()
