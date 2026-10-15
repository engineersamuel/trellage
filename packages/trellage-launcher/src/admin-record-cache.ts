import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

interface CacheRecord<Entry> {
  readonly schemaVersion: 2
  readonly entries: Readonly<Record<string, Entry>>
}

interface CachePolicy<Entry> {
  readonly maximumBytes: number
  readonly maximumEntries: number
  readonly label: string
  readonly parseEntry: (value: unknown) => Entry | undefined
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Owns schema-2 Admin cache storage; each adapter owns its result validation and freshness. */
export const createAdminRecordCache = <Entry>(policy: CachePolicy<Entry>) => {
  const emptyRecord: CacheRecord<Entry> = { schemaVersion: 2, entries: {} }
  const parse = (source: string): CacheRecord<Entry> => {
    if (Buffer.byteLength(source, "utf8") > policy.maximumBytes) return emptyRecord
    let payload: unknown
    try {
      payload = JSON.parse(source)
    } catch {
      return emptyRecord
    }
    if (!isPlainObject(payload) || payload.schemaVersion !== 2 || !isPlainObject(payload.entries)) return emptyRecord
    const entries: Record<string, Entry> = {}
    for (const [key, value] of Object.entries(payload.entries).slice(0, policy.maximumEntries)) {
      const entry = policy.parseEntry(value)
      if (entry !== undefined) entries[key] = entry
    }
    return { schemaVersion: 2, entries }
  }

  // Caches are optional optimizations: any read failure permits a fresh check.
  const load = async (cachePath: string): Promise<CacheRecord<Entry>> => {
    let source: string
    try {
      source = await readFile(cachePath, "utf8")
    } catch {
      return emptyRecord
    }
    return parse(source)
  }

  const save = async (cachePath: string, value: CacheRecord<Entry>): Promise<void> => {
    await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
    const source = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(source, "utf8") > policy.maximumBytes) {
      throw new Error(`${policy.label} exceeds ${policy.maximumBytes} bytes`)
    }
    try {
      await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 })
      await rename(temporaryPath, cachePath)
    } catch (error) {
      try {
        await unlink(temporaryPath)
      } catch (cleanupError) {
        if (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError
      }
      throw new Error(`could not write ${policy.label}: ${cachePath}`, { cause: error })
    }
  }

  return { parse, load, save }
}
