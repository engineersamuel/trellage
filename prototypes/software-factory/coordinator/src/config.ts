// Factory config: numbers, model names and switches. Shipped defaults < the user's
// ~/.config/trellage/factory/config.toml < runtime overrides ($SF_STATE_DIR/config-overrides.json, UI and approved
// agent proposals). An invalid edit keeps the last good config. Text a model reads is in prompt files (prompt.ts).
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { stateDir } from "./statedir.ts"
import {
  nativePresetProfiles,
  nativeSharedPresets,
} from "../../../../packages/trellage-runtime/src/native-run/presets.ts"

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Model = Schema.String.check(Schema.isNonEmpty())

const FactoryConfigSchema = Schema.Struct({
  models: Schema.Struct({
    coordinator: Model,
    sub_coordinator: Model,
    worker: Model,
    review: Schema.Struct({ claude: Model, gpt: Model, gemini: Model }),
    claude_worker: Model,
    goal_page: Model,
  }),
  /** Small-model gate in Factory.spawnModel: Jev's low-complexity score at or above the threshold picks small_model. */
  routing: Schema.Struct({ small_model: Model, small_threshold: Probability }),
  review: Schema.Struct({
    lens_threshold: Probability,
    max_lenses: Count,
    min_lenses_t2: Count,
    real_threshold: Probability,
    worth_threshold: Probability,
    min_severity: Schema.Array(Schema.Literals(["low", "medium", "high", "critical"])),
    rereview_lines: Count,
    max_rounds: Count,
  }),
  sdlc: Schema.Struct({ done_below: Probability, max_fix_rounds: Count }),
  fanout: Schema.Struct({ max_workers: Count, select_threshold: Probability }),
  /** Hard limits per worker on paid MCP calls (src/mcp.ts); a call over the limit is refused. */
  mcp: Schema.Struct({ perplexity_max_calls: Count, perplexity_research_max_calls: Count }),
  /** Jev probability at or above which each gate runs. The question is prompts/gates/<id>.md. */
  gates: Schema.Struct({
    design: Probability,
    testFirst: Probability,
    codeReview: Probability,
    supplyChain: Probability,
    docs: Probability,
    postMerge: Probability,
  }),
  /** Guided goal page (src/goalPage.ts): its model's effort and Jev's bars. */
  goal_page: Schema.Struct({
    effort: Schema.Literals(["low", "medium", "high", "xhigh"]),
    ready_threshold: Probability,
    deep_need: Probability,
    deep_stable: Probability,
    finding_change: Probability,
  }),
  costs: Schema.Struct({ usd_per_ai_credit: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) }),
  /** Independent acceptance evaluator (src/evaluate.ts): contract at sdlc_plan, verdicts before the security review. */
  evaluate: Schema.Struct({
    enabled: Schema.Boolean,
    contract_rounds: Count,
    max_rounds: Count,
  }),
  /** Gate workers (gateWorker.ts): when one counts as stuck, how often it is replaced, and the backstop wait. */
  workers: Schema.Struct({
    wait_minutes: Count,
    stuck_quiet_minutes: Count,
    stuck_failed_tools: Count,
    retries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
})
export type FactoryConfig = typeof FactoryConfigSchema.Type

const decodeSchema = Schema.decodeUnknownSync(FactoryConfigSchema, { onExcessProperty: "error" })

/** The main Trellage config (`trx`), the source of declared profiles. */
export const trellageConfigPath = (env = process.env): string =>
  env.TRELLAGE_CONFIG ??
  path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config"), "trellage", "config.toml")

/** Profiles a harness can run: trx presets, shared presets, and [native.profiles] of the main config for that harness. */
export const knownProfiles = (harness: string, env = process.env): Set<string> | null => {
  const known = new Set([...nativePresetProfiles(harness), ...nativeSharedPresets])
  const file = trellageConfigPath(env)
  if (!existsSync(file)) return known
  let doc: { native?: { profiles?: Record<string, { harnesses?: string[] }> } }
  try {
    doc = Bun.TOML.parse(readFileSync(file, "utf8")) as typeof doc
  } catch {
    return null // trx reports a broken main config itself; do not block the factory on it.
  }
  for (const [id, p] of Object.entries(doc.native?.profiles ?? {}))
    if (!p.harnesses || p.harnesses.includes(harness)) known.add(id)
  return known
}

/** A step's harness profiles that trx cannot run, as readable errors. Checked when a worker for the step spawns. */
export const missingProfiles = (
  id: string,
  harness: { kind: string; profiles: readonly string[] } | undefined,
  env = process.env,
): string[] => {
  if (!harness) return []
  const known = knownProfiles(harness.kind, env)
  if (!known) return []
  return harness.profiles
    .filter((p) => !known.has(p))
    .map(
      (p) =>
        `step ${id}: profile '${p}' is not a ${harness.kind} profile; add [native.profiles.${p}] to ${trellageConfigPath(env)}`,
    )
}

const decode = (raw: unknown): FactoryConfig => decodeSchema(raw)

export const defaultsPath = path.join(import.meta.dir, "..", "defaults", "config.toml")

export const userConfigPath = (env = process.env): string =>
  env.SF_CONFIG ??
  path.join(env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? "", ".config"), "trellage", "factory", "config.toml")

const isTable = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)

/** Tables merge key by key; any other value (arrays too) replaces. */
const overlay = (base: unknown, top: unknown): unknown => {
  if (!isTable(base) || !isTable(top)) return top
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(top)) out[k] = k in base ? overlay(base[k], v) : v
  return out
}

const readToml = (file: string): unknown => {
  try {
    return Bun.TOML.parse(readFileSync(file, "utf8"))
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
}

/** Defaults with the user file over them. Throws a readable message naming the user file. */
export const loadFactoryConfig = (user: string, defaults = defaultsPath): FactoryConfig => {
  const base = readToml(defaults)
  if (!existsSync(user)) return decode(base)
  const merged = overlay(base, readToml(user))
  try {
    return decode(merged)
  } catch (e) {
    throw new Error(`${user}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
}

// ---------- Value sources, runtime overrides, promote to file ----------

export type Source = "default" | "file" | "override"
/** live: the next use reads it. run: a delivery run keeps the value it pinned at its first plan. */
export type Reload = "live" | "run"
export type Scalar = string | number | boolean | readonly string[]
export type ConfigValue = { key: string; value: Scalar; source: Source; reload: Reload }

/** Keys a running delivery reads from its pinned snapshot. */
const RUN_KEYS = /^(review\.|gates\.|sdlc\.|evaluate\.|models\.review\.)/

const isScalar = (v: unknown): v is Scalar =>
  ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === "string"))

/** Scalar leaves of a table as `section.key`. */
const leaves = (v: unknown, prefix = ""): [string, Scalar][] =>
  isTable(v)
    ? Object.entries(v).flatMap(([k, x]) => leaves(x, prefix ? `${prefix}.${k}` : k))
    : isScalar(v)
      ? [[prefix, v]]
      : []

const getPath = (v: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((x, k) => (isTable(x) ? x[k] : undefined), v)

/** `{"a.b": 1}` as `{a: {b: 1}}`. */
const nest = (flat: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(flat)) {
    const parts = key.split(".")
    let t = out
    for (const p of parts.slice(0, -1)) t = (t[p] ??= {}) as Record<string, unknown>
    t[parts.at(-1)!] = v
  }
  return out
}

/** TOML for one scalar. JSON strings, numbers, booleans and string arrays are valid TOML values. */
const tomlValue = (v: Scalar): string => JSON.stringify(v)

/**
 * Set `section.key = value` in TOML text, keeping comments and order. Adds the key under its table, or the table at
 * the end. Throws when the key is written in another form (inline table, dotted key) that a line edit cannot change.
 */
export const setTomlKey = (text: string, dotted: string, value: Scalar): string => {
  const parts = dotted.split(".")
  const key = parts.at(-1)!
  const section = parts.slice(0, -1).join(".")
  const lines = text.split("\n")
  const header = (l: string) => /^\s*\[([^[\]]+)\]\s*(#.*)?$/.exec(l)?.[1]?.trim()
  const start = lines.findIndex((l) => header(l) === section)
  const line = `${key} = ${tomlValue(value)}`
  let next: string[]
  if (start === -1) {
    const body = text.replace(/\n*$/, "")
    next = [...(body ? [body, ""] : []), `[${section}]`, line, ""]
  } else {
    let end = lines.findIndex((l, i) => i > start && header(l) !== undefined)
    if (end === -1) end = lines.length
    const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l))
    next = [...lines]
    if (at !== -1) next[at] = line
    else {
      let last = end
      while (last - 1 > start && next[last - 1]!.trim() === "") last--
      next.splice(last, 0, line)
    }
  }
  const out = next.join("\n")
  const refuse = () => new Error(`cannot safely edit ${dotted}; edit the file by hand`)
  let parsed: unknown
  try {
    parsed = getPath(Bun.TOML.parse(out), dotted)
  } catch (e) {
    throw Object.assign(refuse(), { cause: e })
  }
  if (JSON.stringify(parsed) !== JSON.stringify(value)) throw refuse()
  return out
}

/** The current config, reloaded when the user file changes. Keeps the last good config on an invalid edit.
 *  Runtime overrides (UI, agent) sit over the user file and are saved in `overridesFile`. */
export class ConfigStore {
  current: FactoryConfig
  error: string | null = null
  private overrides: Record<string, Scalar> = {}
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly user = userConfigPath(),
    readonly defaults = defaultsPath,
    readonly overridesFile: string | null = null,
  ) {
    // The shipped defaults must be valid; a bad user file then falls back to them.
    this.current = loadFactoryConfig("", defaults)
    if (overridesFile && existsSync(overridesFile)) {
      try {
        const raw: unknown = JSON.parse(readFileSync(overridesFile, "utf8"))
        if (isTable(raw)) for (const [k, v] of Object.entries(raw)) if (isScalar(v)) this.overrides[k] = v
      } catch (e) {
        console.error(`factory config: ignoring unreadable ${overridesFile}: ${e}`)
      }
    }
    this.reload()
  }

  private load(overrides: Record<string, Scalar>): FactoryConfig {
    const base = loadFactoryConfig(this.user, this.defaults)
    if (!Object.keys(overrides).length) return base
    try {
      return decode(overlay(base, nest(overrides)))
    } catch (e) {
      throw new Error(`runtime override: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
  }

  /** Load again; true when the config is valid (it becomes current). */
  reload(): boolean {
    try {
      this.current = this.load(this.overrides)
      this.error = null
      return true
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      return false
    }
  }

  /** Every scalar key with its value, where it comes from, and when a change applies. */
  values(): ConfigValue[] {
    const fileDoc = existsSync(this.user)
      ? (() => {
          try {
            return Bun.TOML.parse(readFileSync(this.user, "utf8"))
          } catch {
            return {}
          }
        })()
      : {}
    return leaves(this.current).map(([key, value]) => ({
      key,
      value,
      source: key in this.overrides ? "override" : getPath(fileDoc, key) !== undefined ? "file" : "default",
      reload: RUN_KEYS.test(key) ? "run" : "live",
    }))
  }

  /** Set (or with null, clear) one runtime override. Throws, and changes nothing, when the result is invalid. */
  setOverride(key: string, value: Scalar | null): void {
    if (value !== null && !leaves(this.current).some(([k]) => k === key)) throw new Error(`unknown config key ${key}`)
    const next = { ...this.overrides }
    if (value === null) delete next[key]
    else next[key] = value
    this.current = this.load(next)
    this.overrides = next
    this.error = null
    this.saveOverrides()
  }

  /** Write one key's current value into the user file (comments kept), then drop its override. */
  promote(key: string): void {
    const v = leaves(this.current).find(([k]) => k === key)?.[1]
    if (v === undefined) throw new Error(`unknown config key ${key}`)
    const text = existsSync(this.user) ? readFileSync(this.user, "utf8") : ""
    const out = setTomlKey(text, key, v)
    mkdirSync(path.dirname(this.user), { recursive: true })
    const tmp = `${this.user}.tmp-${process.pid}`
    writeFileSync(tmp, out)
    renameSync(tmp, this.user)
    const next = { ...this.overrides }
    delete next[key]
    this.overrides = next
    this.saveOverrides()
    this.reload()
  }

  private saveOverrides(): void {
    if (!this.overridesFile) return
    mkdirSync(path.dirname(this.overridesFile), { recursive: true })
    writeFileSync(this.overridesFile, JSON.stringify(this.overrides, null, 2))
  }

  /** Watch the user file's folder (editors replace files), debounced. `onChange` gets each reload result. */
  watch(onChange: (store: ConfigStore) => void, debounceMs = 150): void {
    const dir = path.dirname(this.user)
    if (this.watcher || !existsSync(dir)) return
    const name = path.basename(this.user)
    this.watcher = watch(dir, (_event, file) => {
      if (file !== null && file !== name) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.reload()
        onChange(this)
      }, debounceMs)
    })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
  }
}

// ---------- Per-run snapshots: a delivery run keeps the config it started with ----------

const snapshots = new Map<string, FactoryConfig>()
const snapshotFile = (root: string, id: string) => path.join(root, "config-snapshots", `${id}.json`)

/** Save `c` under the state root by content hash (once) and return its id. */
export const snapshotConfig = (root: string, c: FactoryConfig = factoryConfig()): string => {
  const json = JSON.stringify(c)
  const id = createHash("sha256").update(json).digest("hex").slice(0, 12)
  const file = snapshotFile(root, id)
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, json)
  }
  snapshots.set(id, c)
  return id
}

/** The pinned config of a run; no id or an unreadable snapshot gives the current config. */
export const pinnedConfig = (root: string, id: string | undefined): FactoryConfig => {
  if (!id) return factoryConfig()
  const hit = snapshots.get(id)
  if (hit) return hit
  try {
    const c = decode(JSON.parse(readFileSync(snapshotFile(root, id), "utf8")))
    snapshots.set(id, c)
    return c
  } catch {
    return factoryConfig()
  }
}

let shared: ConfigStore | null = null
/** The process-wide store. main.ts starts its watcher; tests point SF_CONFIG at a temp file. */
export const configStore = (): ConfigStore =>
  (shared ??= new ConfigStore(userConfigPath(), defaultsPath, path.join(stateDir(), "config-overrides.json")))
/** The current factory config. Read it at use time, not at import time, so edits apply. */
export const factoryConfig = (): FactoryConfig => configStore().current
/** Replace the process-wide store (tests). */
export const setConfigStore = (store: ConfigStore): void => {
  shared = store
}
/** Drop the process-wide store; the next use builds it again from the env (tests). */
export const resetConfigStore = (): void => {
  shared?.close()
  shared = null
}
