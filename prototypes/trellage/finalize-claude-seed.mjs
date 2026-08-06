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

const inventory = async (root, prefix = "") => {
  const resolvedRoot = await realpath(root)
  const entries = []
  const visit = async (directory, relativeDirectory) => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => lexical(left.name, right.name))
    for (const child of children) {
      const absolute = path.join(directory, child.name)
      const relative = path.posix.join(relativeDirectory, child.name)
      if (
        relative.startsWith("/") ||
        relative.includes("\\") ||
        relative.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        fail(`unsafe plugin path: ${relative}`)
      }
      const status = await lstat(absolute)
      if (status.isSymbolicLink()) {
        // Allow in-tree file symlinks (e.g. council skills/council/SKILL.md -> ../../SKILL.md).
        // Follow the link and hash target content so install may keep a symlink or materialize a file.
        let resolved
        try {
          resolved = await realpath(absolute)
        } catch {
          fail(`plugin symlink target is broken: ${relative}`)
        }
        const containment = path.relative(resolvedRoot, resolved)
        if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
          fail(`plugin symlink escapes root: ${relative}`)
        }
        const followed = await stat(resolved)
        if (followed.isDirectory()) fail(`plugin symlink to directory rejected: ${relative}`)
        if (!followed.isFile()) fail(`unsupported plugin symlink target: ${relative}`)
        entries.push({
          path: path.posix.join(prefix, relative),
          sha256: sha256(await readFile(resolved)),
          executable: (followed.mode & 0o111) !== 0,
        })
        continue
      }
      const resolved = await realpath(absolute)
      const containment = path.relative(resolvedRoot, resolved)
      if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
        fail(`plugin path escapes root: ${relative}`)
      }
      if (status.isDirectory()) {
        await visit(absolute, relative)
      } else if (status.isFile()) {
        entries.push({
          path: path.posix.join(prefix, relative),
          sha256: sha256(await readFile(absolute)),
          executable: (status.mode & 0o111) !== 0,
        })
      } else {
        fail(`unsupported plugin entry: ${relative}`)
      }
    }
  }
  await visit(root, "")
  return entries
}

/** Replace in-tree file symlinks with regular files so runtime managed-path checks pass. */
const materializeFileSymlinks = async (root) => {
  const resolvedRoot = await realpath(root)
  const visit = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => lexical(left.name, right.name))
    for (const child of children) {
      const absolute = path.join(directory, child.name)
      const status = await lstat(absolute)
      if (status.isSymbolicLink()) {
        let resolved
        try {
          resolved = await realpath(absolute)
        } catch {
          fail(`plugin symlink target is broken: ${path.relative(resolvedRoot, absolute)}`)
        }
        const containment = path.relative(resolvedRoot, resolved)
        if (containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
          fail(`plugin symlink escapes root: ${path.relative(resolvedRoot, absolute)}`)
        }
        const followed = await stat(resolved)
        if (followed.isDirectory()) {
          fail(`plugin symlink to directory rejected: ${path.relative(resolvedRoot, absolute)}`)
        }
        if (!followed.isFile()) {
          fail(`unsupported plugin symlink target: ${path.relative(resolvedRoot, absolute)}`)
        }
        const bytes = await readFile(resolved)
        const mode = followed.mode & 0o777
        await unlink(absolute)
        await writeFile(absolute, bytes, { mode: mode === 0 ? 0o644 : mode })
        if ((mode & 0o111) !== 0) await chmod(absolute, mode)
        continue
      }
      if (status.isDirectory()) await visit(absolute)
    }
  }
  await visit(root)
}

const main = async () => {
  const [seed, manifestPath, harnessVersion, ...extra] = process.argv.slice(2)
  if (
    seed === undefined ||
    manifestPath === undefined ||
    harnessVersion === undefined ||
    !versionPattern.test(harnessVersion) ||
    extra.length > 0
  ) {
    fail("usage: finalize-claude-seed <seed> <marketplaces.json> <harness-version>")
  }
  const onboardingDefaults = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: harnessVersion,
    theme: "dark",
    shiftEnterKeyBindingInstalled: true,
  }
  const manifest = await readJson(manifestPath, "locked Claude marketplace manifest")
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !Array.isArray(manifest.marketplaces) ||
    manifest.marketplaces.length === 0
  ) {
    fail("locked Claude marketplace manifest is invalid")
  }
  const marketplaces = []
  const marketplaceNames = new Set()
  const pluginIds = new Set()
  for (const candidate of manifest.marketplaces) {
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
    marketplaces.push({
      marketplace: candidate.marketplace,
      source: candidate.source,
      commit: candidate.commit,
      selections,
    })
  }
  marketplaces.sort((left, right) => lexical(left.marketplace, right.marketplace))

  const settings = await readJson(path.join(seed, "settings.json"), "generated Claude settings")
  const expectedEnabled = Object.fromEntries([...pluginIds].sort(lexical).map((id) => [id, true]))
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
  const installed = await readJson(
    path.join(seed, "plugins", "installed_plugins.json"),
    "generated installed plugin registry",
  )
  const normalizedPlugins = Object.create(null)
  const normalizedMarketplaces = Object.create(null)
  const managed = []
  for (const { marketplace, source, commit, selections } of marketplaces) {
    const sourceInventory = await inventory(source)
    let marketplaceInstallPath
    for (const { plugin, version } of selections) {
      const id = `${plugin}@${marketplace}`
      const records = installed?.plugins?.[id]
      if (
        !Array.isArray(records) ||
        records.length !== 1 ||
        records[0]?.scope !== "user" ||
        records[0]?.version !== version
      ) {
        fail(`generated Claude plugin registration is invalid: ${id}`)
      }
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
      managed.push(...cacheInventory.map(({ path: managedPath }) => managedPath))
      const installPath = `/home/agent/.claude/${cacheRelative}`
      marketplaceInstallPath ??= installPath
      normalizedPlugins[id] = [
        {
          scope: "user",
          installPath,
          version,
          gitCommitSha: commit,
        },
      ]
    }
    normalizedMarketplaces[marketplace] = {
      source: {
        source: "directory",
        path: marketplaceInstallPath,
      },
      installLocation: marketplaceInstallPath,
    }
  }

  await writeFile(
    path.join(seed, "plugins", "installed_plugins.json"),
    json({ version: 2, plugins: normalizedPlugins }),
    { mode: 0o600 },
  )
  await writeFile(
    path.join(seed, "plugin-marketplaces.json"),
    json(normalizedMarketplaces),
    { mode: 0o600 },
  )
  await writeFile(path.join(seed, "plugin-settings.json"), json({ enabledPlugins: expectedEnabled }), {
    mode: 0o600,
  })
  await writeFile(path.join(seed, "default-onboarding.json"), json(onboardingDefaults), {
    mode: 0o600,
  })
  await Promise.all([
    rm(path.join(seed, ".claude.json"), { force: true }),
    rm(path.join(seed, "backups"), { recursive: true, force: true }),
    rm(path.join(seed, "plugins", "known_marketplaces.json"), { force: true }),
    rm(path.join(seed, "settings.json"), { force: true }),
  ])
  managed.push("plugins/installed_plugins.json")
  managed.sort(lexical)
  await writeFile(path.join(seed, "managed-paths.txt"), `${managed.join("\n")}\n`, { mode: 0o600 })

  const allowed = new Set([
    "default-onboarding.json",
    "default-settings.json",
    "managed-paths.txt",
    "plugin-marketplaces.json",
    "plugin-settings.json",
    "plugins",
  ])
  for (const entry of await readdir(seed)) {
    if (!allowed.has(entry)) fail(`unexpected generated Claude state: ${entry}`)
  }
  await mkdir(path.join(seed, "plugins"), { recursive: true })
}

await main()
