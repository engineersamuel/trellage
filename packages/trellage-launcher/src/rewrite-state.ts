import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises"
import path from "node:path"
import lockfile from "proper-lockfile"

const schemaVersion = 1
const maximumEntries = 100
// 100 results of 60,000 Unicode characters, including JSON escaping.
const maximumBytes = 40 * 1024 * 1024
const styleIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

export interface RewriteCacheKey {
  readonly sourcePrompt: string
  readonly systemPrompt: string
  readonly model: string
  readonly effort: string
  readonly version: string
}
interface RewriteCacheEntry {
  readonly key: string
  readonly markdown: string
}

export const validateSavedRewrite = (markdown: unknown): string => {
  if (typeof markdown !== "string" || markdown.trim().length === 0 || [...markdown].length > 60_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(markdown)) {
    throw new Error("Rewrite is empty, oversized, or contains invalid control characters")
  }
  return markdown
}
export const rewriteCacheKey = (key: RewriteCacheKey): string => createHash("sha256").update(JSON.stringify(key)).digest("hex")

const stateDirectory = (stateDir = process.env.HERDR_PLUGIN_STATE_DIR): string | undefined => {
  if (stateDir !== undefined && !path.isAbsolute(stateDir)) throw new Error("Plugin state directory must be absolute")
  return stateDir
}
const checkDirectory = async (directory: string, create = false): Promise<void> => {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 })
  const status = await lstat(directory)
  if (!status.isDirectory() || (process.getuid !== undefined && status.uid !== process.getuid())) throw new Error("Plugin state directory is unsafe")
  if (create) await chmod(directory, 0o700)
}
const readJson = async (directory: string, name: string, limit: number): Promise<unknown> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await checkDirectory(directory)
    handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const status = await handle.stat()
    if (!status.isFile() || status.size > limit || (status.mode & 0o077) !== 0 || (process.getuid !== undefined && status.uid !== process.getuid())) throw new Error("Private rewrite state file is unsafe or oversized")
    // Bound allocation and reads even if the file changes after fstat.
    const buffer = Buffer.alloc(Math.min(limit, status.size) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > status.size) throw new Error("Private rewrite state changed during read")
    return JSON.parse(buffer.subarray(0, length).toString("utf8"))
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  } finally {
    await handle?.close()
  }
}
const writeJson = async (directory: string, name: string, value: unknown, signal?: AbortSignal): Promise<void> => {
  await checkDirectory(directory, true)
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`)
  try {
    const source = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(source) > maximumBytes) throw new Error("Rewrite state is too large")
    const handle = await open(temporary, "wx", 0o600)
    try { await handle.writeFile(source); await handle.sync() } finally { await handle.close() }
    signal?.throwIfAborted()
    await rename(temporary, path.join(directory, name))
  } finally {
    await rm(temporary, { force: true })
  }
}
const readEntries = async (directory: string): Promise<ReadonlyArray<RewriteCacheEntry>> => {
  const value = await readJson(directory, "rewrite-cache.json", maximumBytes)
  if (value === undefined) return []
  if (!isRecord(value) || value.schemaVersion !== schemaVersion || !Array.isArray(value.entries) || value.entries.length > maximumEntries) throw new Error("Rewrite cache is invalid")
  return value.entries.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.key !== "string" || !/^[a-f0-9]{64}$/u.test(entry.key)) throw new Error("Rewrite cache entry is invalid")
    return { key: entry.key, markdown: validateSavedRewrite(entry.markdown) }
  })
}
export const readRewriteCache = async (key: RewriteCacheKey, stateDir?: string): Promise<string | undefined> => {
  const directory = stateDirectory(stateDir)
  if (directory === undefined) return undefined
  const entries = await readEntries(directory)
  return entries.find(entry => entry.key === rewriteCacheKey(key))?.markdown
}
export const writeRewriteCache = async (key: RewriteCacheKey, markdown: string, stateDir?: string, signal?: AbortSignal): Promise<void> => {
  signal?.throwIfAborted()
  validateSavedRewrite(markdown)
  const directory = stateDirectory(stateDir)
  if (directory === undefined) return
  await checkDirectory(directory, true)
  const release = await lockfile.lock(directory, { lockfilePath: path.join(directory, "rewrite-cache.lock"), realpath: false, retries: { retries: 100, factor: 1, minTimeout: 20, maxTimeout: 50 } })
  try {
    signal?.throwIfAborted()
    const wanted = rewriteCacheKey(key)
    const current = await readEntries(directory)
    const entries = [{ key: wanted, markdown }, ...current.filter(entry => entry.key !== wanted)].slice(0, maximumEntries)
    await writeJson(directory, "rewrite-cache.json", { schemaVersion, entries }, signal)
  } finally { await release() }
}
export const readPreferredStyle = async (stateDir?: string): Promise<string | undefined> => {
  const directory = stateDirectory(stateDir)
  if (directory === undefined) return undefined
  const value = await readJson(directory, "rewrite-preferences.json", 4096)
  if (value === undefined) return undefined
  if (!isRecord(value) || value.schemaVersion !== schemaVersion || typeof value.styleId !== "string" || !styleIdentifier.test(value.styleId)) throw new Error("Saved rewrite style is invalid")
  return value.styleId
}
export const writePreferredStyle = async (stateDir: string | undefined, id: string): Promise<void> => {
  if (!styleIdentifier.test(id)) throw new Error("Rewrite style identifier is invalid")
  const directory = stateDirectory(stateDir)
  if (directory !== undefined) await writeJson(directory, "rewrite-preferences.json", { schemaVersion, styleId: id })
}
