import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type {
  GuideGenerateInput,
  GuideGenerateResult,
  GuideMatchInput,
  GuideMatchResult,
  GuideOptimizeInput,
  GuideOptimizeResult,
  GuideProvider,
  GuideRefineInput,
  GuideRefineResult,
} from "./guide-provider.js"
import {
  validateGuideGenerateResult,
  validateGuideMatchResult,
  validateGuideOptimizeResult,
} from "./guide-provider.js"
import type { GuideModelRouting } from "./guide-model-routing.js"
import { array, exactKeys, record, text } from "./guide-text.js"

const maximumCacheBytes = 256 * 1024
const maximumCacheEntries = 16

type GuideCachePhase = "match" | "generate" | "optimize"

interface GuideCacheEntry {
  readonly phase: GuideCachePhase
  readonly key: string
  readonly result: unknown
}

interface GuideCacheRecord {
  readonly schemaVersion: 2
  readonly entries: ReadonlyArray<GuideCacheEntry>
}

export interface CachedGuideProviderOptions {
  readonly cachePath: string
  readonly routing: GuideModelRouting
  readonly matchPrompt: string
  readonly generatePrompt: string
  readonly optimizePrompt: string
  readonly onWarning?: (message: string) => void
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

const matchCacheKey = (input: GuideMatchInput, options: CachedGuideProviderOptions): string =>
  sha256(
    JSON.stringify({
      schemaVersion: 1,
      intentDigest: sha256(input.intent),
      model: options.routing.match.model,
      effort: options.routing.match.effort,
      matchPromptDigest: sha256(options.matchPrompt),
      catalogDigest: sha256(JSON.stringify(input.entries)),
    }),
  )

const generateCacheKey = (input: GuideGenerateInput, options: CachedGuideProviderOptions): string =>
  sha256(
    JSON.stringify({
      schemaVersion: 1,
      intentDigest: sha256(input.intent),
      profileRef: input.profileRef,
      workflowId: input.workflowId,
      guideDigest: sha256(JSON.stringify(input.guide)),
      guideBodyDigest: sha256(input.guideBody),
      model: options.routing.generate.model,
      effort: options.routing.generate.effort,
      generatePromptDigest: sha256(options.generatePrompt),
    }),
  )

const optimizeCacheKey = (input: GuideOptimizeInput, options: CachedGuideProviderOptions): string =>
  sha256(
    JSON.stringify({
      schemaVersion: 1,
      targetTool: input.targetTool,
      profileRef: input.profileRef,
      candidatesDigest: sha256(JSON.stringify(input.candidates)),
      model: options.routing.optimize.model,
      effort: options.routing.optimize.effort,
      optimizePromptDigest: sha256(options.optimizePrompt),
    }),
  )

const isMissingFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

const workflowIndex = (input: GuideMatchInput): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(input.entries.map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]))

const parseCacheEntry = (value: unknown, path: string): GuideCacheEntry => {
  const fields = record(value, path)
  exactKeys(fields, path, ["phase", "key", "result"])
  if (fields.phase !== "match" && fields.phase !== "generate" && fields.phase !== "optimize") {
    throw new Error(`${path}.phase must be match, generate, or optimize`)
  }
  return {
    phase: fields.phase,
    key: text(fields.key, `${path}.key`, 64),
    result: fields.result,
  }
}

const parseCacheRecord = (source: string): GuideCacheRecord => {
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
  if (fields.schemaVersion === 1) {
    exactKeys(fields, "guide match cache", ["schemaVersion", "key", "result"])
    return {
      schemaVersion: 2,
      entries: [{ phase: "match", key: text(fields.key, "guide match cache.key", 64), result: fields.result }],
    }
  }
  exactKeys(fields, "guide cache", ["schemaVersion", "entries"])
  if (fields.schemaVersion !== 2) throw new Error("guide cache schemaVersion must equal 1 or 2")
  return {
    schemaVersion: 2,
    entries: array(fields.entries, "guide cache.entries", { maximum: maximumCacheEntries }).map((entry, index) =>
      parseCacheEntry(entry, `guide cache.entries[${index}]`),
    ),
  }
}

const readCacheRecord = async (cachePath: string): Promise<GuideCacheRecord | undefined> => {
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

const writeCacheRecord = async (cachePath: string, value: GuideCacheRecord): Promise<void> => {
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`
  const source = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(source, "utf8") > maximumCacheBytes) {
    throw new Error(`guide cache exceeds ${maximumCacheBytes} bytes`)
  }
  try {
    await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 })
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
      const entry = cached?.entries.find((candidate) => candidate.phase === "match" && candidate.key === key)
      if (entry === undefined) return undefined
      return validateGuideMatchResult(entry.result, workflowIndex(input))
    } catch (error) {
      this.warn(`ignoring unreadable guide match cache: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async cachedGenerateResult(key: string): Promise<GuideGenerateResult | undefined> {
    try {
      const cached = await readCacheRecord(this.options.cachePath)
      const entry = cached?.entries.find((candidate) => candidate.phase === "generate" && candidate.key === key)
      return entry === undefined ? undefined : validateGuideGenerateResult(entry.result)
    } catch (error) {
      this.warn(`ignoring unreadable guide cache: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async cachedOptimizeResult(input: GuideOptimizeInput, key: string): Promise<GuideOptimizeResult | undefined> {
    try {
      const cached = await readCacheRecord(this.options.cachePath)
      const entry = cached?.entries.find((candidate) => candidate.phase === "optimize" && candidate.key === key)
      return entry === undefined ? undefined : validateGuideOptimizeResult(entry.result, input.candidates.length)
    } catch (error) {
      this.warn(`ignoring unreadable guide cache: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async cacheResult(phase: GuideCachePhase, key: string, result: unknown): Promise<void> {
    try {
      let current: GuideCacheRecord
      try {
        current = (await readCacheRecord(this.options.cachePath)) ?? { schemaVersion: 2, entries: [] }
      } catch {
        current = { schemaVersion: 2, entries: [] }
      }
      let entries: ReadonlyArray<GuideCacheEntry> = [
        ...current.entries.filter((entry) => entry.phase !== phase || entry.key !== key),
        { phase, key, result },
      ].slice(-maximumCacheEntries)
      while (
        entries.length > 1 &&
        Buffer.byteLength(JSON.stringify({ schemaVersion: 2, entries }), "utf8") > maximumCacheBytes
      ) {
        entries = entries.slice(1)
      }
      await writeCacheRecord(this.options.cachePath, { schemaVersion: 2, entries })
    } catch (error) {
      this.warn(`could not update guide cache: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async match(input: GuideMatchInput): Promise<GuideMatchResult> {
    const key = matchCacheKey(input, this.options)
    const cached = await this.cachedResult(input, key)
    if (cached !== undefined) return cached
    const result = await this.provider.match(input)
    await this.cacheResult("match", key, result)
    return result
  }

  async generate(input: GuideGenerateInput): Promise<GuideGenerateResult> {
    const key = generateCacheKey(input, this.options)
    const cached = await this.cachedGenerateResult(key)
    if (cached !== undefined) return cached
    const result = await this.provider.generate(input)
    await this.cacheResult("generate", key, result)
    return result
  }

  refine(input: GuideRefineInput): Promise<GuideRefineResult> {
    return this.provider.refine(input)
  }

  async optimize(input: GuideOptimizeInput): Promise<GuideOptimizeResult> {
    const key = optimizeCacheKey(input, this.options)
    const cached = await this.cachedOptimizeResult(input, key)
    if (cached !== undefined) return cached
    const result = await this.provider.optimize(input)
    await this.cacheResult("optimize", key, result)
    return result
  }
}
