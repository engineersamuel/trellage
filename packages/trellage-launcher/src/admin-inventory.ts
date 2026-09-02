/**
 * Parses the existing `inventory PROFILE --json` command (already used by
 * `guide-preflight.ts` for a healthy/unhealthy readiness check) into the
 * richer install-detail view the admin UI's Inventory overlay needs:
 * installed plugins, skill package/visible counts, and MCP server names.
 * Every native launcher emits the same `{schemaVersion: 1, launcher,
 * harness, profile, readiness, plugins, skills, mcps}` shape (verified
 * across `prototypes/trellage-*-profiles/bin/*`'s own `inventory_profile`
 * implementations), so this is a single tolerant parser rather than a
 * per-launcher family like `admin-version-check.ts` needs.
 *
 * Skills in this architecture are a single git-commit-pinned bundle per
 * profile, not individually versioned packages (see
 * `scripts/floating-skills.mjs`), so `skills` only ever reports counts
 * (`packageCount`/`visibleCount`), never a per-skill version. This view
 * intentionally reports exactly that — it does not fabricate a per-skill
 * version comparison the architecture cannot support.
 */
import type { AdminProfileEntry } from "./admin-model.js"
import type { CommandSpec } from "./guide-launch.js"

export interface AdminInventoryPlugin {
  readonly name: string
  readonly version: string | undefined
}

export interface AdminInventorySkills {
  readonly packageCount: number | undefined
  readonly visibleCount: number | undefined
}

export interface AdminInventoryResult {
  readonly readiness: "healthy" | "unhealthy" | "not-setup" | "busy"
  readonly plugins: ReadonlyArray<AdminInventoryPlugin>
  readonly skills: AdminInventorySkills
  readonly mcps: ReadonlyArray<string>
}

export type AdminInventoryOutcome = { readonly malformed: true; readonly diagnostic: string } | ({ readonly malformed?: false } & AdminInventoryResult)

/** Builds `inventory PROFILE --json` for a profile. Callers must check `entry.inventorySupported` first. */
export const buildInventoryCommand = (entry: AdminProfileEntry): CommandSpec => ({
  executable: entry.commandPath,
  args: ["inventory", entry.name, "--json"],
})

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isReadiness = (value: unknown): value is AdminInventoryResult["readiness"] =>
  value === "healthy" || value === "unhealthy" || value === "not-setup" || value === "busy"

const parsePlugins = (value: unknown): ReadonlyArray<AdminInventoryPlugin> | undefined => {
  if (!Array.isArray(value)) return undefined
  const plugins: Array<AdminInventoryPlugin> = []
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.name !== "string") return undefined
    plugins.push({ name: item.name, version: typeof item.version === "string" ? item.version : undefined })
  }
  return plugins
}

const parseSkills = (value: unknown): AdminInventorySkills | undefined => {
  if (!isPlainObject(value)) return undefined
  const packageCount = typeof value.packageCount === "number" ? value.packageCount : undefined
  const visibleCount = typeof value.visibleCount === "number" ? value.visibleCount : undefined
  return { packageCount, visibleCount }
}

const parseMcps = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.every((item): item is string => typeof item === "string") ? value : undefined
}

/**
 * Tolerantly parses `inventory --json` stdout. Any structural mismatch
 * (invalid JSON, wrong shape, unexpected identity) is reported as
 * `{malformed: true}` rather than guessed at — the same fail-closed
 * posture used by `admin-version-check.ts` and `guide-preflight.ts`.
 */
export const parseInventoryOutput = (stdout: string): AdminInventoryOutcome => {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return { malformed: true, diagnostic: "inventory --json produced no output" }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { malformed: true, diagnostic: "inventory --json did not return valid JSON" }
  }
  if (!isPlainObject(value)) return { malformed: true, diagnostic: "inventory --json must return a JSON object" }
  if (value.schemaVersion !== 1) return { malformed: true, diagnostic: "inventory --json returned an unsupported schema version" }
  if (!isReadiness(value.readiness)) return { malformed: true, diagnostic: "inventory --json returned an unsupported readiness value" }
  const plugins = parsePlugins(value.plugins)
  const skills = parseSkills(value.skills)
  const mcps = parseMcps(value.mcps)
  if (plugins === undefined || skills === undefined || mcps === undefined) {
    return { malformed: true, diagnostic: "inventory --json returned an unrecognized plugins/skills/mcps shape" }
  }
  return { readiness: value.readiness, plugins, skills, mcps }
}
