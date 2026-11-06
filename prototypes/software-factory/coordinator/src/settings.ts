// Factory settings: one JSON document shared by the UI and the coordinator agent.
// The UI changes it with `PATCH /api/settings`; the agent changes it with the
// `update_settings` tool. Both send the same JSON merge patch (agent access parity).
import { DIFF_STYLES } from "../../shared/diff.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"

export const NAVBAR_ITEMS = ["status", "workers", "model", "context", "auth", "crons", "repo"]
export const PANEL_POSITIONS = ["right", "left", "hidden"]
export const HOTKEY_ACTIONS = ["toggleSettings", "togglePanel", "cycleTheme", "focusCoordinator", "abortCoordinator"]
export const EFFORTS = ["default", "low", "medium", "high", "xhigh"]
export const TOOL_KINDS = ["shell", "write", "read", "url", "mcp"]
export const MIN_CRON_SECONDS = 30
/** Named mount points both UIs expose to extensions. */
export const SLOTS = ["chat-background", "page-background", "navbar", "banner", "panel-top", "overlay"]

const Palette = Schema.Struct({
  bg: Schema.String,
  surface: Schema.String,
  border: Schema.String,
  text: Schema.String,
  muted: Schema.String,
  accent: Schema.String,
})
export type Palette = typeof Palette.Type

const Cron = Schema.Struct({
  everySeconds: Schema.Number,
  prompt: Schema.String,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
})

/** UI extension. `js` is the body of `function (el, api) { ... }` run in the browser. */
const Extension = Schema.Struct({
  slot: Schema.String,
  js: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  css: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  description: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
})

const SettingsSchema = Schema.Struct({
  theme: Schema.String,
  themes: Schema.Record(Schema.String, Palette),
  layout: Schema.Struct({ panel: Schema.String, panelWidth: Schema.Number }),
  navbar: Schema.Array(Schema.String),
  animations: Schema.Boolean,
  /** How tool calls show file changes in every chat and transcript. */
  diffStyle: Schema.Literals(DIFF_STYLES).pipe(Schema.withDecodingDefaultKey(Effect.succeed("terminal" as const))),
  hotkeys: Schema.Record(Schema.String, Schema.String),
  focus: Schema.String,
  banner: Schema.NullOr(Schema.String),
  agent: Schema.Struct({
    model: Schema.String,
    reasoningEffort: Schema.String,
    disabledTools: Schema.Array(Schema.String),
    instructions: Schema.String,
  }),
  crons: Schema.Record(Schema.String, Cron),
  extensions: Schema.Record(Schema.String, Extension),
  /** Absolute path of the git repository the factory works on. Empty = no target. */
  repo: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  /** Periodic worker check; issues go to the coordinator to resolve. */
  supervisor: Schema.Struct({
    enabled: Schema.Boolean,
    everySeconds: Schema.Number,
    stallSeconds: Schema.Number,
    offTrackCheck: Schema.Boolean,
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ enabled: true, everySeconds: 60, stallSeconds: 300, offTrackCheck: true }))),
})
export type Settings = typeof SettingsSchema.Type

const decode = Schema.decodeUnknownSync(SettingsSchema, { onExcessProperty: "error" })

const palette = (bg: string, surface: string, border: string, text: string, muted: string, accent: string): Palette => ({
  bg,
  surface,
  border,
  text,
  muted,
  accent,
})

export const defaultSettings = (): Settings => ({
  theme: "default",
  themes: {
    default: palette("#0a0a0a", "#171717", "#262626", "#e5e5e5", "#a3a3a3", "#6366f1"),
    midnight: palette("#0b1020", "#121a33", "#1f2a4d", "#dbe4ff", "#8b9bc8", "#60a5fa"),
    dracula: palette("#282a36", "#343746", "#44475a", "#f8f8f2", "#a9adc1", "#bd93f9"),
    nord: palette("#2e3440", "#3b4252", "#4c566a", "#eceff4", "#a3acbd", "#88c0d0"),
    forest: palette("#0d1410", "#15201a", "#22342a", "#e0efe4", "#94b39f", "#34d399"),
    ember: palette("#140d0b", "#20140f", "#3a2219", "#f5e6df", "#b99d90", "#f97316"),
  },
  layout: { panel: "right", panelWidth: 45 },
  navbar: ["status", "workers", "model", "context"],
  animations: true,
  diffStyle: "terminal",
  hotkeys: { ",": "toggleSettings", p: "togglePanel", t: "cycleTheme", ".": "focusCoordinator" },
  focus: "coordinator",
  banner: null,
  agent: { model: "", reasoningEffort: "default", disabledTools: [], instructions: "" },
  crons: {},
  extensions: {},
  repo: "",
  supervisor: { enabled: true, everySeconds: 60, stallSeconds: 300, offTrackCheck: true },
})

export const settingsPath = (root: string): string => path.join(root, "settings.json")

/** Stored settings over the defaults; unreadable or invalid files give the defaults. */
export const loadSettings = (file: string): Settings => {
  try {
    if (!existsSync(file)) return defaultSettings()
    const doc = structuredClone(defaultSettings()) as unknown
    merge(doc, JSON.parse(readFileSync(file, "utf8")))
    return decode(doc)
  } catch {
    return defaultSettings()
  }
}

export const saveSettings = (file: string, s: Settings): void => writeFileSync(file, JSON.stringify(s, null, 2))

/** Apply a JSON merge patch (RFC 7386) and validate the result. Throws a readable message. */
export const patched = (current: Settings, patch: unknown): Settings => {
  const doc = structuredClone(current) as unknown
  const merged = merge(doc, patch)
  let next: Settings
  try {
    next = decode(merged)
  } catch (e) {
    throw new Error(`invalid settings: ${e instanceof Error ? e.message : String(e)}`)
  }
  validate(next)
  return next
}

const oneOf = (field: string, v: string, allowed: readonly string[]) => {
  if (!allowed.includes(v)) throw new Error(`${field}: '${v}' is not one of ${JSON.stringify(allowed)}`)
}

const validate = (s: Settings): void => {
  if (!(s.theme in s.themes))
    throw new Error(`theme: '${s.theme}' is not in themes ${JSON.stringify(Object.keys(s.themes))}`)
  for (const [name, p] of Object.entries(s.themes)) {
    for (const c of [p.bg, p.surface, p.border, p.text, p.muted, p.accent]) {
      if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u.test(c))
        throw new Error(`themes.${name}: '${c}' is not a #rgb or #rrggbb color`)
    }
  }
  if (s.repo !== "" && !path.isAbsolute(s.repo)) throw new Error(`repo: '${s.repo}' must be an absolute path`)
  if (s.supervisor.everySeconds < MIN_CRON_SECONDS) throw new Error(`supervisor.everySeconds must be >= ${MIN_CRON_SECONDS}`)
  if (s.supervisor.stallSeconds < 60) throw new Error("supervisor.stallSeconds must be >= 60")
  oneOf("layout.panel", s.layout.panel, PANEL_POSITIONS)
  if (!(s.layout.panelWidth >= 25 && s.layout.panelWidth <= 70)) throw new Error("layout.panelWidth must be 25..=70")
  for (const item of s.navbar) oneOf("navbar", item, NAVBAR_ITEMS)
  for (const action of Object.values(s.hotkeys)) oneOf("hotkeys", action, HOTKEY_ACTIONS)
  oneOf("agent.reasoningEffort", s.agent.reasoningEffort, EFFORTS)
  for (const kind of s.agent.disabledTools) oneOf("agent.disabledTools", kind, TOOL_KINDS)
  for (const [name, x] of Object.entries(s.extensions)) {
    oneOf(`extensions.${name}.slot`, x.slot, SLOTS)
    if (x.js.length + x.css.length > 64_000) throw new Error(`extensions.${name} is over 64 kB`)
  }
  for (const [name, c] of Object.entries(s.crons)) {
    if (c.everySeconds < MIN_CRON_SECONDS) throw new Error(`crons.${name}.everySeconds must be >= ${MIN_CRON_SECONDS}`)
    if (c.prompt.trim() === "") throw new Error(`crons.${name}.prompt is empty`)
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

/** RFC 7386 merge. null deletes a key, except `banner`, which becomes null. */
const merge = (target: unknown, patch: unknown): unknown => {
  if (!isObject(target) || !isObject(patch)) return structuredClone(patch)
  for (const [k, v] of Object.entries(patch)) {
    if (v === null && k !== "banner") delete target[k]
    else if (k in target) target[k] = merge(target[k], v)
    else target[k] = structuredClone(v)
  }
  return target
}

/** Theme CSS for both frontends: factory variables plus CopilotKit and OpenUI token overrides. */
export const css = (s: Settings): string => {
  const p = s.themes[s.theme]!
  const pulse = s.animations
    ? "@keyframes sf-pulse{0%,100%{opacity:1}50%{opacity:.35}}.sf-busy{animation:sf-pulse 1.1s ease-in-out infinite}"
    : ""
  const { bg, surface, border, text, muted, accent } = p
  return (
    `:root{--sf-bg:${bg};--sf-surface:${surface};--sf-border:${border};--sf-text:${text};--sf-muted:${muted};--sf-accent:${accent}}` +
    `html,body{background:var(--sf-bg)!important;color:var(--sf-text)!important}` +
    `:root [data-copilotkit],:root.dark [data-copilotkit]{--background:${bg}!important;--foreground:${text}!important;--card:${surface}!important;--card-foreground:${text}!important;` +
    `--popover:${surface}!important;--popover-foreground:${text}!important;--primary:${accent}!important;--primary-foreground:#fff!important;--secondary:${surface}!important;` +
    `--secondary-foreground:${text}!important;--muted:${surface}!important;--muted-foreground:${muted}!important;--accent:${border}!important;--accent-foreground:${text}!important;` +
    `--border:${border}!important;--input:${border}!important;--ring:${accent}!important}` +
    `:root,[data-openui-theme],.openui-agent-container{--openui-background:${bg}!important;--openui-foreground:${surface}!important;--openui-popover-background:${surface}!important;` +
    `--openui-text-neutral-primary:${text}!important;--openui-text-neutral-secondary:${muted}!important;--openui-border-default:${border}!important;` +
    `--openui-interactive-accent-default:${accent}!important;--openui-text-brand:${accent}!important}${pulse}`
  )
}
