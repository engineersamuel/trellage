// Factory config: shipped defaults < the user's ~/.config/trellage/factory/config.toml.
// Runtime overrides (UI and agent) stay in settings.json. An invalid edit keeps the last good config.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import {
  nativePresetProfiles,
  nativeSharedPresets,
} from "../../../../packages/trellage-runtime/src/native-run/presets.ts"

const Probability = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Model = Schema.String.check(Schema.isNonEmpty())

const Text = Schema.String.check(Schema.isNonEmpty())
const Texts = Schema.Array(Text)
const Gate = Schema.Struct({ threshold: Probability, question: Text })

const Step = Schema.Struct({
  description: Text,
  best_for: Texts,
  avoid_for: Texts,
  skills: Texts,
  skill_dirs: Schema.optional(Texts),
  /** Extra rules after the skill sentence, e.g. where to stop in the skill. */
  instructions: Schema.optional(Text),
  gate_tools: Schema.optional(Schema.Boolean),
  factory_only: Schema.optional(Schema.Boolean),
  harness: Schema.optional(
    Schema.Struct({ kind: Schema.Literals(["claude", "pi"]), profiles: Texts, entry: Schema.optional(Text) }),
  ),
})

const FactoryConfigSchema = Schema.Struct({
  models: Schema.Struct({
    coordinator: Model,
    sub_coordinator: Model,
    worker: Model,
    review: Schema.Struct({ claude: Model, gpt: Model, gemini: Model }),
    claude_worker: Model,
  }),
  review: Schema.Struct({
    lenses: Schema.Record(Schema.String, Schema.Struct({ focus: Text })),
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
  /** Fixed ids: code decides each gate's phase and floors. */
  gates: Schema.Struct({
    design: Gate,
    testFirst: Gate,
    codeReview: Gate,
    supplyChain: Gate,
    docs: Gate,
    postMerge: Gate,
  }),
  research: Schema.Record(Schema.String, Schema.Struct({ description: Text })),
  steps: Schema.Record(Schema.String, Step),
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

/** Schema, then the links between sections. */
const decode = (raw: unknown): FactoryConfig => {
  const c = decodeSchema(raw)
  for (const id of Object.keys(c.research)) if (!c.steps[id]) throw new Error(`research.${id} has no [steps.${id}]`)
  if (Object.keys(c.review.lenses).length < 2) throw new Error("review.lenses needs at least 2 lenses")
  return c
}

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

/** The current config, reloaded when the user file changes. Keeps the last good config on an invalid edit. */
export class ConfigStore {
  current: FactoryConfig
  error: string | null = null
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly user = userConfigPath(),
    readonly defaults = defaultsPath,
  ) {
    // The shipped defaults must be valid; a bad user file then falls back to them.
    this.current = loadFactoryConfig("", defaults)
    this.reload()
  }

  /** Load again; true when the config is valid (it becomes current). */
  reload(): boolean {
    try {
      this.current = loadFactoryConfig(this.user, this.defaults)
      this.error = null
      return true
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      return false
    }
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
export const configStore = (): ConfigStore => (shared ??= new ConfigStore())
/** The current factory config. Read it at use time, not at import time, so edits apply. */
export const factoryConfig = (): FactoryConfig => configStore().current
/** Replace the process-wide store (tests). */
export const setConfigStore = (store: ConfigStore): void => {
  shared = store
}
