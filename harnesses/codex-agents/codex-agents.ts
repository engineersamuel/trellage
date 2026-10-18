#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

// Managed role publication is serialized by the native profile lock. Every
// destination is preflighted before writing; unrelated custom roles stay intact.
import {
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  linkSync,
  realpathSync,
} from "node:fs"
import { resolve, dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
const names = ["explorer", "worker", "tester", "researcher", "reviewer"]
const marker = "# trellage-managed-codex-role-v1\n"
function stat(path: string) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}
function directory(path: string): void {
  const parent = dirname(path)
  if (parent !== path) directory(parent)
  const info = stat(path)
  // macOS exposes its system temporary roots through these OS-owned aliases.
  if (
    process.platform === "darwin" &&
    ["/var", "/tmp"].includes(path) &&
    info?.isSymbolicLink() &&
    realpathSync(path) === `/private${path}`
  )
    return
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw Error(`unsafe agents directory: ${path}`)
}
interface ManagedRole {
  path: string
  expected: string
  previous: string | null
}

function preflightRole(mode: string, target: string, source: string, name: string): ManagedRole {
  const asset = join(source, `${name}.toml`)
  const assetInfo = stat(asset)
  if (!assetInfo?.isFile() || assetInfo.isSymbolicLink()) throw Error(`unsafe role asset: ${asset}`)
  const expected = marker + readFileSync(asset, "utf8")
  const path = join(target, `${name}.toml`)
  const info = stat(path)
  if (info && (!info.isFile() || info.isSymbolicLink())) throw Error(`unsafe managed role: ${path}`)
  const previous = info ? readFileSync(path, "utf8") : null
  if (previous !== null && !previous.startsWith(marker)) throw Error(`unmanaged role name collision: ${path}`)
  if (mode === "verify" && previous !== expected) throw Error(`managed role missing or outdated: ${path}`)
  return { path, expected, previous }
}

function publishRole(target: string, { path, expected, previous }: ManagedRole): void {
  if (previous === expected) return
  const temporary = join(target, `.role-${randomUUID()}`)
  try {
    writeFileSync(temporary, expected, { mode: 0o600, flag: "wx" })
    directory(target)
    const info = stat(path)
    if (previous === null) {
      // link is exclusive: never overwrite a role created concurrently.
      linkSync(temporary, path)
    } else {
      if (!info?.isFile() || info.isSymbolicLink() || readFileSync(path, "utf8") !== previous)
        throw Error(`role changed during publication: ${path}`)
      renameSync(temporary, path)
    }
  } finally {
    if (stat(temporary)) unlinkSync(temporary)
  }
}

export function manageRoles(mode: string, destination: string, source: string): void {
  if (!["install", "verify"].includes(mode) || !destination || !source)
    throw Error("usage: codex-agents.ts install|verify TARGET SOURCE")
  const target = resolve(destination)
  directory(target)
  directory(resolve(source))
  const entries = names.map((name) => preflightRole(mode, target, source, name))
  if (mode === "install") {
    mkdirSync(target, { recursive: true, mode: 0o700 })
    for (const entry of entries) publishRole(target, entry)
  }
}

if (import.meta.main) {
  try {
    const [mode, destination, source] = process.argv.slice(2)
    if (mode === undefined || destination === undefined || source === undefined) {
      throw Error("usage: codex-agents.ts install|verify TARGET SOURCE")
    }
    manageRoles(mode, destination, source)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
