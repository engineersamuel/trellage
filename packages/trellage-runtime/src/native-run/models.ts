import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { NativeRunPaths } from "./paths.ts"

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export const DEFAULT_MODELS_URL = "http://127.0.0.1:8080/v1/models"

export interface ModelGroup {
  readonly title: string
  readonly models: ReadonlyArray<string>
}

export interface ModelCatalog {
  /** Frontier models first, then the other host groups, then everything else the endpoint serves. */
  readonly groups: ReadonlyArray<ModelGroup>
  readonly source: "endpoint" | "cache" | "host-list" | "none"
}

export interface ModelCatalogOptions {
  readonly paths: NativeRunPaths
  readonly url?: string
  /** Path of the host model grouping file (~/.copilot/models.json). */
  readonly hostModelsPath?: string
  readonly fetchImpl?: FetchLike
  readonly timeoutMs?: number
}

const groupTitles: ReadonlyArray<readonly [string, string]> = [
  ["balanced-workhorse", "Balanced"],
  ["coding-specialist", "Coding"],
  ["fast-efficient", "Fast"],
]

// The inline picker cycles only these; other host "frontier" models are listed under Balanced.
const FRONTIER_MODELS: ReadonlyArray<string> = ["gpt-6.1-sol", "claude-opus-5.5", "grok-4.7", "gpt-6-astra"]

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : []

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

const fetchIds = async (url: string, fetchImpl: FetchLike, timeoutMs: number): Promise<string[] | undefined> => {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (body.data ?? []).flatMap((entry) => (typeof entry.id === "string" && entry.id.length > 0 ? [entry.id] : []))
    return ids.length > 0 ? ids : undefined
  } catch {
    return undefined
  }
}

/** Query the model endpoint, falling back to the last cached list, then the host grouping file. */
export const loadModelCatalog = async (options: ModelCatalogOptions): Promise<ModelCatalog> => {
  const cacheFile = path.join(options.paths.cache, "models.json")
  const hostGroups = ((await readJson(options.hostModelsPath ?? "")) as { groups?: Record<string, unknown> } | undefined)?.groups ?? {}

  let source: ModelCatalog["source"] = "none"
  let available = await fetchIds(options.url ?? DEFAULT_MODELS_URL, options.fetchImpl ?? fetch, options.timeoutMs ?? 2000)
  if (available) {
    source = "endpoint"
    try {
      await mkdir(options.paths.cache, { recursive: true, mode: 0o700 })
      const staged = `${cacheFile}.${process.pid}.tmp`
      await writeFile(staged, `${JSON.stringify({ fetched_at: new Date().toISOString(), ids: available })}\n`, { mode: 0o600 })
      await rename(staged, cacheFile)
    } catch {
      // The cache only speeds up later launches.
    }
  } else {
    const cached = strings(((await readJson(cacheFile)) as { ids?: unknown } | undefined)?.ids)
    if (cached.length > 0) {
      available = cached
      source = "cache"
    } else {
      const all = strings(hostGroups.all)
      if (all.length > 0) {
        available = all
        source = "host-list"
      }
    }
  }
  if (!available) return { groups: [], source }

  const offered = new Set(available)
  const used = new Set<string>()
  const groups: ModelGroup[] = []
  const frontier = FRONTIER_MODELS.filter((id) => offered.has(id))
  frontier.forEach((id) => used.add(id))
  if (frontier.length > 0) groups.push({ title: "Frontier", models: frontier })
  for (const [key, title] of groupTitles) {
    const hostKeys = key === "balanced-workhorse" ? ["frontier", key] : [key]
    const models = hostKeys.flatMap((hostKey) => strings(hostGroups[hostKey])).filter((id, at, all) => offered.has(id) && !used.has(id) && all.indexOf(id) === at)
    models.forEach((id) => used.add(id))
    if (models.length > 0) groups.push({ title, models })
  }
  const other = available.filter((id) => !used.has(id)).sort()
  if (other.length > 0) groups.push({ title: "Other", models: other })
  return { groups, source }
}
