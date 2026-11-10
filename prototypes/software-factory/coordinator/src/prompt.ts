// Prompt templates: defaults/prompts/<name>.md, overridden one by one by ~/.config/trellage/factory/prompts/<name>.md.
// `{{name}}` inserts a value; `{{#name}}...{{/name}}` keeps its body only when the value is truthy, `{{^name}}...{{/name}}` only when not.
// Config values are available as `{{section.key}}`. Inserted values are never scanned again.
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { factoryConfig, userConfigPath, type FactoryConfig } from "./config.ts"

export type Vars = Record<string, string | number | boolean | null | undefined>

export const defaultPromptsDir = path.join(import.meta.dir, "..", "defaults", "prompts")
export const userPromptsDir = (env = process.env): string => path.join(path.dirname(userConfigPath(env)), "prompts")

/** Last render error per prompt name, for a user file that could not be used. */
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

/** One file's text without its final newline (editors add one). */
const read = (file: string): string => readFileSync(file, "utf8").replace(/\n$/, "")

/** Render prompt `name`. A user file that fails to render falls back to the shipped default; the error is kept. */
export const loadPrompt = (name: string, vars: Vars = {}): string => {
  const all = { ...configVars(factoryConfig()), ...vars }
  const user = path.join(userPromptsDir(), `${name}.md`)
  if (existsSync(user)) {
    try {
      const text = render(read(user), all)
      promptErrors.delete(name)
      return text
    } catch (e) {
      const msg = `${user}: ${e instanceof Error ? e.message : String(e)}`
      if (promptErrors.get(name) !== msg) console.error(`prompt ${name}: using the default; ${msg}`)
      promptErrors.set(name, msg)
    }
  } else promptErrors.delete(name)
  return render(read(path.join(defaultPromptsDir, `${name}.md`)), all)
}
