// Prompt files: every text a model reads that code does not also parse or enforce.
// A file is defaults/prompts/<name>.md; ~/.config/trellage/factory/prompts/<name>.md replaces it whole.
// Optional TOML front matter between `+++` lines holds structured fields (a catalog item's skills, a prompt's
// declared `inputs`, `based_on` of a user copy). The body is a template:
// `{{name}}` inserts a value; `{{#name}}...{{/name}}` keeps its body only when the value is truthy, `{{^name}}...{{/name}}`
// only when not. Config values are available as `{{section.key}}`. Inserted values are never scanned again.
import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { factoryConfig, userConfigPath, type FactoryConfig } from "./config.ts"

export type Vars = Record<string, string | number | boolean | null | undefined>
export type PromptFile = { meta: Record<string, unknown>; body: string; hash: string }

export const defaultPromptsDir = path.join(import.meta.dir, "..", "defaults", "prompts")
export const userPromptsDir = (env = process.env): string => path.join(path.dirname(userConfigPath(env)), "prompts")

/** Last error per prompt name, for a user file that could not be used. */
export const promptErrors = new Map<string, string>()

export const render = (template: string, vars: Vars): string => {
  const has = (name: string) => Object.hasOwn(vars, name)
  const kept = template.replace(
    /\{\{([#^])([\w.-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (_m, kind: string, name: string, body: string) => {
      if (!has(name)) throw new Error(`unknown section {{${kind}${name}}}`)
      return !vars[name] === (kind === "^") ? body : ""
    },
  )
  return kept.replace(/\{\{([^}]*)\}\}/g, (_m, name: string) => {
    if (!has(name)) throw new Error(`unknown placeholder {{${name}}}`)
    return String(vars[name] ?? "")
  })
}

/** Config scalars as `section.key` (nested tables joined with dots, arrays with ", "). */
export const configVars = (c: FactoryConfig): Vars => {
  const out: Vars = {}
  const walk = (prefix: string, v: unknown) => {
    if (Array.isArray(v)) out[prefix] = v.join(", ")
    else if (v !== null && typeof v === "object")
      for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}.${k}` : k, x)
    else out[prefix] = v as Vars[string]
  }
  walk("", c)
  return out
}

/** Placeholder and section names a template uses. */
export const placeholders = (body: string): Set<string> =>
  new Set([...body.matchAll(/\{\{[#^/]?([\w.-]+)\}\}/g)].map((m) => m[1]!))

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12)

/** Split `+++` TOML front matter from the body. The body loses one final newline (editors add one). */
export const parsePromptFile = (text: string): PromptFile => {
  const m = /^\+\+\+\n([\s\S]*?)\n\+\+\+\n?([\s\S]*)$/.exec(text)
  const meta = m ? (Bun.TOML.parse(m[1]!) as Record<string, unknown>) : {}
  const body = (m ? m[2]! : text).replace(/\n$/, "")
  return { meta, body, hash: hashText(text) }
}

const fileOf = (dir: string, name: string) => path.join(dir, `${name}.md`)

// ---------- Prompt sets: the shipped files plus the user's, live or pinned by a delivery run ----------

/** Every prompt file of a set, name → raw text. */
export type PromptSet = Record<string, string>

const readSet = (dir: string): PromptSet =>
  existsSync(dir)
    ? Object.fromEntries(
        (readdirSync(dir, { recursive: true }) as string[])
          .filter((f) => f.endsWith(".md"))
          .map((f) => [f.slice(0, -3).split(path.sep).join("/"), readFileSync(path.join(dir, f), "utf8")]),
      )
    : {}

/** Every shipped prompt name, e.g. `coordinator`, `jev/lens`, `steps/plan`. */
export const promptNames = (dir = defaultPromptsDir): string[] => Object.keys(readSet(dir)).sort()

type Pinned = { shipped: PromptSet; user: PromptSet; config: FactoryConfig }
const pinScope = new AsyncLocalStorage<Pinned>()
const pinCache = new Map<string, Pinned>()
const promptSnapshotFile = (root: string, id: string) => path.join(root, "prompt-snapshots", `${id}.json`)

/** Save the current shipped and user prompt files under the state root by content hash (once); return the id. */
export const snapshotPrompts = (root: string): string => {
  const sets = { shipped: readSet(defaultPromptsDir), user: readSet(userPromptsDir()) }
  const json = JSON.stringify(sets)
  const id = hashText(json)
  const file = promptSnapshotFile(root, id)
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, json)
  }
  return id
}

/**
 * Run `f` with a delivery run's pinned prompts and config: every loadPrompt and promptFile below it reads the pinned
 * copy. No id (an older run) or a missing snapshot reads the live files.
 */
export const withPinned = <T>(
  root: string,
  ids: { promptsId?: string; configId?: string },
  config: FactoryConfig,
  f: () => T,
): T => {
  const { promptsId, configId } = ids
  if (!promptsId) return f()
  const key = `${promptsId}:${configId ?? "live"}`
  let pin = pinCache.get(key)
  if (!pin) {
    try {
      const sets = JSON.parse(readFileSync(promptSnapshotFile(root, promptsId), "utf8")) as Omit<Pinned, "config">
      pin = { ...sets, config }
      pinCache.set(key, pin)
    } catch {
      return f()
    }
  }
  return pinScope.run(pin, f)
}

/** The config a prompt render reads: the pinned run's, or the live one. */
export const activeConfig = (): FactoryConfig => pinScope.getStore()?.config ?? factoryConfig()

/** The text of one prompt file: the user's copy when it parses, else the shipped one. Pinned when in a run. */
const rawPrompt = (name: string): { shipped: string | undefined; user: string | undefined } => {
  const pin = pinScope.getStore()
  if (pin) return { shipped: pin.shipped[name], user: pin.user[name] }
  const shipped = fileOf(defaultPromptsDir, name)
  const user = fileOf(userPromptsDir(), name)
  return {
    shipped: existsSync(shipped) ? readFileSync(shipped, "utf8") : undefined,
    user: existsSync(user) ? readFileSync(user, "utf8") : undefined,
  }
}

const noteError = (name: string, msg: string) => {
  if (promptErrors.get(name) !== msg) console.error(`prompt ${name}: using the shipped one; ${msg}`)
  promptErrors.set(name, msg)
}

/** A prompt file (front matter and template). A user copy that does not parse falls back to the shipped one. */
export const promptFile = (name: string): PromptFile => {
  const { shipped, user } = rawPrompt(name)
  if (user !== undefined) {
    try {
      const f = parsePromptFile(user)
      promptErrors.delete(name)
      return f
    } catch (e) {
      noteError(name, `${fileOf(userPromptsDir(), name)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (shipped === undefined) throw new Error(`unknown prompt ${name}`)
  return parsePromptFile(shipped)
}

/** A prompt's declared inputs: `inputs` in its front matter. */
export const declaredInputs = (f: PromptFile): string[] =>
  Array.isArray(f.meta.inputs) ? f.meta.inputs.map(String) : []

/**
 * Check a template against the inputs its prompt declares: it may use only those and config keys. Without a
 * declaration, any placeholder that is neither a config key nor passed fails at render. Throws a readable message.
 */
export const checkTemplate = (body: string, inputs: readonly string[], config = activeConfig()): void => {
  const known = new Set([...inputs, ...Object.keys(configVars(config))])
  const unknown = [...placeholders(body)].filter((n) => !known.has(n))
  if (unknown.length) throw new Error(`unknown placeholder ${unknown.map((n) => `{{${n}}}`).join(", ")}`)
}

/** Render one parsed file: the caller must pass every declared input; the body may use only those and config keys. */
const renderFile = (name: string, f: PromptFile, vars: Vars, config: FactoryConfig): string => {
  const inputs = declaredInputs(f)
  const missing = inputs.filter((n) => !Object.hasOwn(vars, n))
  if (missing.length) throw new Error(`prompt ${name}: caller did not pass ${missing.join(", ")}`)
  if (inputs.length) checkTemplate(f.body, inputs, config)
  return render(f.body, { ...configVars(config), ...vars })
}

/** Render prompt `name`. A user file that fails to render falls back to the shipped one; the error is kept. */
export const loadPrompt = (name: string, vars: Vars = {}): string => {
  const config = activeConfig()
  const { shipped, user } = rawPrompt(name)
  if (user !== undefined) {
    try {
      // A user copy keeps the shipped declaration: the caller passes what the shipped prompt declares.
      const own = parsePromptFile(user)
      const declared =
        shipped === undefined ? own : { ...own, meta: { ...own.meta, inputs: parsePromptFile(shipped).meta.inputs } }
      const text = renderFile(name, declared, vars, config)
      promptErrors.delete(name)
      return text
    } catch (e) {
      noteError(name, `${fileOf(userPromptsDir(), name)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else promptErrors.delete(name)
  if (shipped === undefined) throw new Error(`unknown prompt ${name}`)
  return renderFile(name, parsePromptFile(shipped), vars, config)
}

/** Names of the prompts in a catalog folder (`steps`, `lenses`, ...): shipped plus the user's additions, ordered by
 *  `order` in front matter (files without one last), then by name. Order matters: it is the list a model reads. */
export const catalogNames = (folder: string): string[] => {
  const pin = pinScope.getStore()
  const names = pin
    ? [...Object.keys(pin.shipped), ...Object.keys(pin.user)]
    : [...promptNames(), ...Object.keys(readSet(userPromptsDir()))]
  const ids = [...new Set(names.filter((n) => n.startsWith(`${folder}/`)).map((n) => n.slice(folder.length + 1)))]
  const order = (id: string) => Number(promptFile(`${folder}/${id}`).meta.order ?? Number.MAX_SAFE_INTEGER)
  return ids.sort((x, y) => order(x) - order(y) || x.localeCompare(y))
}

// ---------- User copies: what they replaced, and when the shipped prompt moved on ----------

/** A user copy that was made from an older shipped prompt: `based_on` names that version. */
export type StalePrompt = { name: string; basedOn: string; shipped: string }

/** User copies whose `based_on` is not the current shipped version (the repo improved the default under them). */
export const stalePrompts = (): StalePrompt[] =>
  Object.entries(readSet(userPromptsDir())).flatMap(([name, text]) => {
    const shipped = fileOf(defaultPromptsDir, name)
    if (!existsSync(shipped)) return []
    let basedOn: unknown
    try {
      basedOn = parsePromptFile(text).meta.based_on
    } catch {
      return []
    }
    const current = hashText(readFileSync(shipped, "utf8"))
    return typeof basedOn === "string" && basedOn !== current ? [{ name, basedOn, shipped: current }] : []
  })

/** A user copy of `name` with new body text: shipped front matter, plus `based_on` = the shipped version. */
export const userCopy = (name: string, body: string): string => {
  const shipped = readFileSync(fileOf(defaultPromptsDir, name), "utf8")
  const meta = Object.entries({ ...parsePromptFile(shipped).meta, based_on: hashText(shipped) })
    .map(([k, v]) => `${k} = ${tomlInline(v)}`)
    .join("\n")
  return `+++\n${meta}\n+++\n${body.replace(/\n$/, "")}\n`
}

const tomlInline = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(tomlInline).join(", ")}]`
    : v !== null && typeof v === "object"
      ? `{ ${Object.entries(v)
          .map(([k, x]) => `${k} = ${tomlInline(x)}`)
          .join(", ")} }`
      : JSON.stringify(v)
