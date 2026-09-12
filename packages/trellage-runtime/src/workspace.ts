import { createHash, type Hash } from "node:crypto"
import {
  type BigIntStats,
  type Stats,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { readFile, readdir as readdirAsync } from "node:fs/promises"
import path from "node:path"

export const sourceMarker = ".managed-by-trellage-source"
export const sourceOwnership = "trellage-source-runtime-v1"
const readyFile = ".trellage-source-ready.json"
const distributionManifest = "package.source.json"
const sourceDirectories = ["bin", "packages", "prototypes", "scripts", "profile-guides", "profiles"]
const optionalSourceDirectories = [".agents"]
const rootFiles = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.base.json", "skills.json"]
const excludedDirectories = new Set(["node_modules", "dist", "coverage", "__pycache__"])
const hiddenSourceAssets = new Set([
  ".agents",
  ".claude-plugin",
  ".env.schema",
  ".env.example",
  ".env.sample",
  ".env.template",
])
type PackageManifest = {
  name: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  bin: Record<string, string>
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`)
}

function sourceDirectoryNames(root: string): string[] {
  return [
    ...sourceDirectories,
    ...optionalSourceDirectories.filter(
      (name) => lstatSync(path.join(root, name), { throwIfNoEntry: false }) !== undefined,
    ),
  ]
}

function excludedSourceName(name: string, parent: string): boolean {
  const testDirectory =
    (name === "test" || name === "tests") && (parent === "scripts" || /^(?:packages|prototypes)\/[^/]+$/.test(parent))
  return testDirectory || excludedDirectories.has(name) || (name.startsWith(".") && !hiddenSourceAssets.has(name))
}

export function sourcePackageManifest(root: string): string {
  const manifestPath = path.join(root, "package.json")
  safePath(manifestPath, "file")
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  if (typeof manifest !== "object" || manifest === null || !("trellageSourceManifest" in manifest)) return manifestPath
  if (manifest.trellageSourceManifest !== distributionManifest) {
    throw new Error(`unpermitted source distribution manifest: ${manifestPath}`)
  }
  const sourcePath = path.join(root, distributionManifest)
  safePath(sourcePath, "file")
  const source: unknown = JSON.parse(readFileSync(sourcePath, "utf8"))
  if (
    typeof source !== "object" ||
    source === null ||
    !("name" in source) ||
    !("name" in manifest) ||
    source.name !== manifest.name ||
    !("workspaces" in source) ||
    !Array.isArray(source.workspaces) ||
    source.workspaces.length !== 1 ||
    source.workspaces[0] !== "packages/*" ||
    "trellageSourceManifest" in source
  ) {
    throw new Error(`invalid locked source workspace manifest: ${sourcePath}`)
  }
  return sourcePath
}

function sourceFilePath(root: string, relative: string): string {
  return relative === "package.json" ? sourcePackageManifest(root) : path.join(root, relative)
}

export function safePath(candidate: string, kind: "file" | "directory"): void {
  requireSafeStatus(candidate, kind, lstatSync(candidate))
}

function requireSafeStatus(candidate: string, kind: "file" | "directory", status: Stats | BigIntStats): void {
  if (status.isSymbolicLink() || (kind === "directory" ? !status.isDirectory() : !status.isFile())) {
    throw new Error(`unsafe ${kind}: ${candidate}`)
  }
  if (process.getuid === undefined || Number(status.uid) !== process.getuid() || (Number(status.mode) & 0o022) !== 0) {
    throw new Error(`runtime path must be owned by this user and not shared-writable: ${candidate}`)
  }
}

export function safeDirectory(candidate: string): string {
  safePath(candidate, "directory")
  const absolute = path.resolve(candidate)
  const resolved = realpathSync(absolute)
  if (absolute !== resolved) throw new Error(`redirected runtime directory: ${candidate}`)
  let ancestor = path.dirname(resolved)
  while (ancestor !== path.parse(ancestor).root) {
    const status = lstatSync(ancestor)
    const systemTemporary = status.uid === 0 && (status.mode & 0o1000) !== 0
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      (status.uid !== 0 && status.uid !== process.getuid?.()) ||
      ((status.mode & 0o022) !== 0 && !systemTemporary)
    ) {
      throw new Error(`unsafe runtime ancestor: ${ancestor}`)
    }
    ancestor = path.dirname(ancestor)
  }
  return resolved
}

function sourceFiles(root: string): string[] {
  const files: string[] = []
  const visit = (relative: string) => {
    const candidate = path.join(root, relative)
    const status = lstatSync(candidate)
    if (status.isSymbolicLink()) throw new Error(`source workspace contains a symlink: ${candidate}`)
    if (status.isDirectory()) {
      requireSafeStatus(candidate, "directory", status)
      for (const name of readdirSync(candidate).sort()) {
        if (excludedSourceName(name, relative)) continue
        visit(path.join(relative, name))
      }
    } else {
      requireSafeStatus(candidate, "file", status)
      if (status.nlink !== 1) throw new Error(`source workspace contains a hard link: ${candidate}`)
      files.push(relative)
    }
  }
  for (const file of rootFiles) {
    safePath(sourceFilePath(root, file), "file")
    files.push(file)
  }
  for (const directory of sourceDirectoryNames(root)) {
    safePath(path.join(root, directory), "directory")
    visit(directory)
  }
  return files.sort()
}

function updateDigest(hash: Hash, file: string, contents: Uint8Array): void {
  hash.update(file).update("\0").update(contents).update("\0")
}

function digestFiles(root: string, files: readonly string[]): string {
  const hash = createHash("sha256")
  for (const file of files) updateDigest(hash, file, readFileSync(sourceFilePath(root, file)))
  return hash.digest("hex")
}

export function sourceFingerprint(root: string): string {
  return digestFiles(root, sourceFiles(root))
}

export async function sourceFingerprintAsync(root: string): Promise<string> {
  const files = sourceFiles(root)
  const hash = createHash("sha256")
  const batchSize = 16
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = await Promise.all(
      files.slice(offset, offset + batchSize).map(async (file) => ({
        file,
        contents: await readFile(sourceFilePath(root, file)),
      })),
    )
    for (const { file, contents } of batch) updateDigest(hash, file, contents)
  }
  return hash.digest("hex")
}

export function copySources(root: string, destination: string): void {
  safeDirectory(root)
  safeDirectory(destination)
  if (readdirSync(destination).length !== 0) throw new Error(`source stage must be empty: ${destination}`)
  for (const directory of sourceDirectoryNames(root)) mkdirSync(path.join(destination, directory), { mode: 0o755 })
  for (const relative of sourceFiles(root)) {
    const source = sourceFilePath(root, relative)
    const target = path.join(destination, relative)
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 })
    copyFileSync(source, target)
    chmodSync(target, lstatSync(source).mode & 0o755)
  }
}

function manifests(root: string): string[] {
  const result = ["package.json"]
  for (const entry of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(path.join(root, "packages", entry.name, "package.json"))) {
      result.push(`packages/${entry.name}/package.json`)
    }
  }
  return result.sort()
}

function packageManifest(candidate: string): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(candidate, "utf8"))
  if (typeof value !== "object" || value === null || !("name" in value) || typeof value.name !== "string") {
    throw new Error(`invalid package manifest: ${candidate}`)
  }
  const readDependencies = (dependencies: unknown): Record<string, string> => {
    if (dependencies === undefined) return {}
    if (
      typeof dependencies !== "object" ||
      dependencies === null ||
      Array.isArray(dependencies) ||
      Object.values(dependencies).some((version) => typeof version !== "string")
    ) {
      throw new Error(`invalid dependencies: ${candidate}`)
    }
    const result: Record<string, string> = {}
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== "string") throw new Error(`invalid dependency: ${name}`)
      result[name] = version
    }
    return result
  }
  return {
    name: value.name,
    dependencies: readDependencies("dependencies" in value ? value.dependencies : undefined),
    devDependencies: readDependencies("devDependencies" in value ? value.devDependencies : undefined),
    bin:
      "bin" in value && typeof value.bin === "string"
        ? { [value.name.split("/").at(-1) ?? value.name]: value.bin }
        : readDependencies("bin" in value ? value.bin : undefined),
  }
}

function dependencyManifest(root: string, importer: string, name: string): string {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`unsafe dependency name: ${name}`)
  let directory = path.dirname(importer)
  while (inside(root, directory)) {
    const candidate = path.join(directory, "node_modules", name, "package.json")
    if (existsSync(candidate)) {
      const resolved = realpathSync(candidate)
      if (!inside(root, resolved)) throw new Error(`dependency resolves outside source workspace: ${name}`)
      safePath(resolved, "file")
      if (packageManifest(resolved).name !== name) throw new Error(`dependency name mismatch: ${candidate}`)
      return path.relative(root, resolved)
    }
    if (directory === root) break
    directory = path.dirname(directory)
  }
  throw new Error(`missing source dependency: ${name}; run scripts/build-profile-compiler.sh explicitly`)
}

function dependencyManifests(root: string): string[] {
  safePath(path.join(root, "node_modules"), "directory")
  const result = new Set<string>()
  for (const relative of manifests(root)) {
    const manifestPath = path.join(root, relative)
    const manifest = packageManifest(manifestPath)
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      result.add(dependencyManifest(root, manifestPath, name))
    }
  }
  return [...result].sort()
}

export function dependencyDirectory(root: string, name: string): string {
  return path.dirname(
    path.join(root, dependencyManifest(root, path.join(root, "packages/trellage-cli/package.json"), name)),
  )
}

function validateRuntimeLink(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (!relative.split(path.sep).includes("node_modules") || path.isAbsolute(readlinkSync(candidate))) {
    throw new Error(`unpermitted runtime link: ${candidate}`)
  }
  const resolved = realpathSync(candidate)
  if (!inside(root, resolved)) throw new Error(`runtime link escapes source workspace: ${candidate}`)
  if (path.relative(root, resolved).split(path.sep).includes("node_modules")) return
  if (path.dirname(candidate).endsWith(`${path.sep}node_modules${path.sep}.bin`)) {
    if (validWorkspaceBinary(root, path.basename(candidate), resolved)) return
    throw new Error(`unpermitted workspace binary link: ${candidate}`)
  }
  const workspace = manifests(root).find(
    (file) => file !== "package.json" && path.dirname(path.join(root, file)) === resolved,
  )
  const expected = workspace === undefined ? undefined : packageManifest(path.join(root, workspace)).name
  if (expected === undefined || !candidate.endsWith(`${path.sep}node_modules${path.sep}${expected}`)) {
    throw new Error(`unpermitted workspace link: ${candidate}`)
  }
}

function validWorkspaceBinary(root: string, name: string, resolved: string): boolean {
  return manifests(root).some((relative) => {
    const manifest = packageManifest(path.join(root, relative))
    const binary = manifest.bin[name]
    if (binary === undefined || path.isAbsolute(binary)) return false
    const packageRoot = path.dirname(path.join(root, relative))
    const target = path.resolve(packageRoot, binary)
    return inside(packageRoot, target) && target === resolved
  })
}

function workspaceBinaryEntry(
  root: string,
  packageRoot: string,
  name: string,
  binary: string,
): readonly [string, Stats] {
  if (name === "" || name === "." || name === ".." || /[\\/\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`unsafe workspace command name: ${packageRoot}`)
  }
  const target = path.resolve(packageRoot, binary)
  if (
    binary === "" ||
    path.isAbsolute(binary) ||
    !inside(packageRoot, target) ||
    path.relative(root, target).split(path.sep).includes("node_modules")
  ) {
    throw new Error(`unsafe workspace binary target: ${packageRoot}`)
  }
  safeDirectory(path.dirname(target))
  const status = lstatSync(target)
  if (!status.isFile() || status.isSymbolicLink() || status.uid !== process.getuid?.()) {
    throw new Error(`unsafe workspace binary: ${target}`)
  }
  if (status.nlink !== 1) throw new Error(`hard-linked workspace binary: ${target}`)
  return [target, status]
}

function workspaceBinaryTargets(root: string): ReadonlyMap<string, Stats> {
  safeDirectory(root)
  const packages = path.join(root, "packages")
  safeDirectory(packages)
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`unsafe workspace package: ${path.join(packages, entry.name)}`)
  }
  const targets = new Map<string, Stats>()
  for (const relative of manifests(root)) {
    const manifestPath = path.join(root, relative)
    const packageRoot = safeDirectory(path.dirname(manifestPath))
    safePath(manifestPath, "file")
    if (lstatSync(manifestPath).nlink !== 1) throw new Error(`hard-linked workspace manifest: ${manifestPath}`)
    const manifest = packageManifest(manifestPath)
    for (const [name, binary] of Object.entries(manifest.bin)) {
      const [target, status] = workspaceBinaryEntry(root, packageRoot, name, binary)
      targets.set(target, status)
    }
  }
  return targets
}

export function validateWorkspaceBinaries(root: string): void {
  workspaceBinaryTargets(root)
}

function validatePermissionIdentity(candidate: string, original: Stats, current: Stats): void {
  if (
    current.dev !== original.dev ||
    current.ino !== original.ino ||
    current.uid !== process.getuid?.() ||
    (original.isFile() ? !current.isFile() || current.nlink !== 1 : !current.isDirectory()) ||
    realpathSync(candidate) !== path.resolve(candidate)
  ) {
    throw new Error(`permission target changed during installation: ${candidate}`)
  }
}

function normalizePermission(candidate: string, status: Stats): void {
  if (status.uid !== process.getuid?.() || (!status.isFile() && !status.isDirectory())) {
    throw new Error(`unsafe installed dependency: ${candidate}`)
  }
  if ((status.mode & 0o022) === 0) return
  if (status.isFile() && status.nlink !== 1) throw new Error(`shared-writable hard-linked dependency: ${candidate}`)
  const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const current = fstatSync(descriptor)
    validatePermissionIdentity(candidate, status, current)
    if ((current.mode & 0o022) !== 0) fchmodSync(descriptor, current.mode & 0o755)
  } finally {
    closeSync(descriptor)
  }
}

export function normalizeDependencyPermissions(root: string): void {
  const binaries = workspaceBinaryTargets(root)
  const normalize = (candidate: string): void => {
    const status = lstatSync(candidate)
    if (status.isSymbolicLink()) {
      validateRuntimeLink(root, candidate)
      if (path.dirname(candidate).endsWith(`${path.sep}node_modules${path.sep}.bin`)) {
        const target = realpathSync(candidate)
        if (!lstatSync(target).isFile()) throw new Error(`invalid dependency command: ${candidate}`)
        normalize(target)
      }
      return
    }
    normalizePermission(candidate, status)
    if (status.isDirectory()) {
      for (const entry of readdirSync(candidate)) normalize(path.join(candidate, entry))
    }
  }
  normalize(path.join(root, "node_modules"))
  for (const manifest of manifests(root)) {
    if (manifest === "package.json") continue
    const dependencies = path.join(root, path.dirname(manifest), "node_modules")
    if (existsSync(dependencies)) normalize(dependencies)
  }
  for (const [target, status] of binaries) normalizePermission(target, status)
}

function inventoryIncludes(root: string, development: boolean) {
  const roots = new Set([...rootFiles, ...sourceDirectoryNames(root), "node_modules"])
  return (directory: string, name: string): boolean => {
    const relative = path.relative(root, path.join(directory, name))
    if (relative === readyFile || relative === sourceMarker) return false
    return !(
      development &&
      (directory === root
        ? !roots.has(name)
        : name !== "node_modules" &&
          !relative.split(path.sep).includes("node_modules") &&
          excludedSourceName(name, path.relative(root, directory)))
    )
  }
}

function inventoryHash(
  root: string,
  development: boolean,
  directories?: ReadonlyMap<string, readonly string[]>,
): string {
  safeDirectory(root)
  const hash = createHash("sha256")
  const include = inventoryIncludes(root, development)
  const visit = (directory: string) => {
    const names = directories === undefined ? readdirSync(directory).sort() : directories.get(directory)
    if (names === undefined) throw new Error(`missing source inventory directory: ${directory}`)
    for (const name of names) {
      if (!include(directory, name)) continue
      const candidate = path.join(directory, name)
      const relative = path.relative(root, candidate)
      const status = lstatSync(candidate, { bigint: true })
      hash
        .update(relative)
        .update("\0")
        .update(String(status.mode & 0o777n))
        .update("\0")
      if (status.isSymbolicLink()) {
        validateRuntimeLink(root, candidate)
        hash.update("link\0").update(readlinkSync(candidate)).update("\0")
      } else if (status.isDirectory()) {
        requireSafeStatus(candidate, "directory", status)
        hash.update("directory\0")
        visit(candidate)
      } else {
        requireSafeStatus(candidate, "file", status)
        // Frozen installation records identity and change time; resetting mtime cannot conceal a rewrite.
        hash
          .update("file\0")
          .update([status.dev, status.ino, status.nlink, status.size, status.mtimeNs, status.ctimeNs].join("\0"))
          .update("\0")
      }
    }
  }
  visit(root)
  return hash.digest("hex")
}

export function validateOwnedTree(root: string, development = false): string {
  return inventoryHash(root, development)
}

export async function validateOwnedTreeAsync(root: string, development = false): Promise<string> {
  safeDirectory(root)
  const include = inventoryIncludes(root, development)
  const pending = [root]
  const directories = new Map<string, readonly string[]>()
  let offset = 0
  while (offset < pending.length) {
    const batch = pending.slice(offset, offset + 16)
    offset += batch.length
    const loaded = await Promise.all(
      batch.map(async (directory) => ({
        directory,
        names: (await readdirAsync(directory)).sort(),
      })),
    )
    for (const { directory, names } of loaded) {
      directories.set(directory, names)
      for (const name of names) {
        if (!include(directory, name)) continue
        const candidate = path.join(directory, name)
        const status = lstatSync(candidate)
        if (status.isDirectory()) {
          requireSafeStatus(candidate, "directory", status)
          pending.push(candidate)
        }
      }
    }
  }
  return inventoryHash(root, development, directories)
}

export function writeReadiness(root: string): void {
  const inventory = validateOwnedTree(root, !existsSync(path.join(root, sourceMarker)))
  const value = {
    schema: 1,
    bun: "1.3.3",
    sources: sourceFingerprint(root),
    dependencies: digestFiles(root, dependencyManifests(root)),
    inventory,
  }
  const temporary = path.join(root, `${readyFile}.${process.pid}`)
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o644 })
  renameSync(temporary, path.join(root, readyFile))
}

function readinessInventory(root: string): string {
  safeDirectory(root)
  safePath(path.join(root, readyFile), "file")
  const value: unknown = JSON.parse(readFileSync(path.join(root, readyFile), "utf8"))
  if (
    typeof value !== "object" ||
    value === null ||
    !("schema" in value) ||
    value.schema !== 1 ||
    !("bun" in value) ||
    value.bun !== "1.3.3" ||
    !("sources" in value) ||
    value.sources !== sourceFingerprint(root) ||
    !("dependencies" in value) ||
    value.dependencies !== digestFiles(root, dependencyManifests(root))
  ) {
    throw new Error("source runtime is stale; run scripts/build-profile-compiler.sh explicitly")
  }
  if (!("inventory" in value) || typeof value.inventory !== "string") {
    throw new Error(`refusing changed or unrelated source runtime contents: ${root}; prepare dependencies explicitly`)
  }
  return value.inventory
}

function requireInventory(root: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new Error(`refusing changed or unrelated source runtime contents: ${root}; prepare dependencies explicitly`)
  }
}

export function requireReady(root: string): void {
  const expected = readinessInventory(root)
  requireInventory(root, expected, validateOwnedTree(root, !existsSync(path.join(root, sourceMarker))))
}

export async function requireReadyAsync(root: string): Promise<void> {
  const expected = readinessInventory(root)
  requireInventory(root, expected, await validateOwnedTreeAsync(root, !existsSync(path.join(root, sourceMarker))))
}

export function requireOwnedWorkspace(root: string): void {
  safeDirectory(root)
  safePath(path.join(root, sourceMarker), "file")
  if (readFileSync(path.join(root, sourceMarker), "utf8") !== `${sourceOwnership}\n`) {
    throw new Error(`refusing unowned source runtime: ${root}`)
  }
  const allowed = new Set([...rootFiles, ...sourceDirectoryNames(root), sourceMarker, readyFile, "node_modules"])
  for (const name of readdirSync(root)) {
    if (!allowed.has(name)) throw new Error(`refusing unrelated source runtime path: ${path.join(root, name)}`)
  }
  requireReady(root)
}
