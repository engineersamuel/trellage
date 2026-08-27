import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  GuideGenerateInput,
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
  GuideProvider,
  GuideRefineInput,
  GuideRefineResult,
} from "./guide-provider.js"
import { validateGuideMatchResult } from "./guide-provider.js"
import { exactKeys, record, text } from "./guide-text.js"

const maximumCacheBytes = 256 * 1024

interface GuideMatchCacheRecord {
  readonly schemaVersion: 1
  readonly key: string
  readonly result: unknown
}

export interface CachedGuideProviderOptions {
  readonly cachePath: string
  readonly model: string
  readonly effort: string
  readonly matchPrompt: string
  readonly onWarning?: (message: string) => void
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

const cacheKey = (input: GuideMatchInput, options: CachedGuideProviderOptions): string =>
  sha256(
    JSON.stringify({
      schemaVersion: 1,
      intentDigest: sha256(input.intent),
      model: options.model,
      effort: options.effort,
      matchPromptDigest: sha256(options.matchPrompt),
      catalogDigest: sha256(JSON.stringify(input.entries)),
    }),
  )

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

const workflowIndex = (input: GuideMatchInput): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(input.entries.map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]))

const parseCacheRecord = (source: string): GuideMatchCacheRecord => {
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) {
    throw new Error(`guide match cache exceeds ${maximumCacheBytes} bytes`)
  }
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch (cause) {
    throw new Error("guide match cache contains invalid JSON", { cause })
  }
  const fields = record(payload, "guide match cache")
  exactKeys(fields, "guide match cache", ["schemaVersion", "key", "result"])
  if (fields.schemaVersion !== 1) throw new Error("guide match cache schemaVersion must equal 1")
  return {
    schemaVersion: 1,
    key: text(fields.key, "guide match cache.key", 64),
    result: fields.result,
  }
}

const readCacheRecord = async (cachePath: string): Promise<GuideMatchCacheRecord | undefined> => {
  let source: string
  try {
    source = await readFile(cachePath, "utf8")
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw new Error(`could not read guide match cache: ${cachePath}`, { cause: error })
  }
  return parseCacheRecord(source)
}

const removeTemporaryCache = async (temporaryPath: string): Promise<void> => {
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
}

const writeCacheRecord = async (cachePath: string, value: GuideMatchCacheRecord): Promise<void> => {
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await rename(temporaryPath, cachePath)
  } catch (error) {
    await removeTemporaryCache(temporaryPath)
    throw new Error(`could not write guide match cache: ${cachePath}`, { cause: error })
  }
}

export const defaultGuideMatchCachePath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const cacheRoot = env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
  return path.join(cacheRoot, "trellage", "trx-guide", "last-match.json")
}

export class CachedGuideProvider implements GuideProvider {
  constructor(
    private readonly provider: GuideProvider,
    private readonly options: CachedGuideProviderOptions,
  ) {}

  private warn(message: string): void {
    if (this.options.onWarning !== undefined) {
      this.options.onWarning(message)
      return
    }
    process.stderr.write(`trellage-launcher: warning: ${message}\n`)
  }

  private async cachedResult(input: GuideMatchInput, key: string): Promise<GuideMatchResult | undefined> {
    try {
      const cached = await readCacheRecord(this.options.cachePath)
      if (cached?.key !== key) return undefined
      return validateGuideMatchResult(cached.result, workflowIndex(input))
    } catch (error) {
      this.warn(`ignoring unreadable guide match cache: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async cacheResult(key: string, result: GuideMatchResult): Promise<void> {
    try {
      await writeCacheRecord(this.options.cachePath, { schemaVersion: 1, key, result })
    } catch (error) {
      this.warn(`could not update guide match cache: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async match(input: GuideMatchInput): Promise<GuideMatchResult> {
    const key = cacheKey(input, this.options)
    const cached = await this.cachedResult(input, key)
    if (cached !== undefined) return cached
    const result = await this.provider.match(input)
    await this.cacheResult(key, result)
    return result
  }

  generate(input: GuideGenerateInput): Promise<GuideGenerateResult> {
    return this.provider.generate(input)
  }

  refine(input: GuideRefineInput): Promise<GuideRefineResult> {
    return this.provider.refine(input)
  }
}
