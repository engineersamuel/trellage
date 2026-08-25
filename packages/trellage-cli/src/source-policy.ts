import type { InventoryPolicy } from "./inventory.js"

export interface SourceSelection {
  readonly kind: "plugin"
  readonly adapter:
    | "claude-marketplace"
    | "codex-native"
    | "copilot-marketplace"
    | "hyperresearch"
    | "prime-extension"
    | "wshobson-agents"
  readonly marketplace?: string
  readonly select: ReadonlyArray<string>
}

export const sourceIncludes = (source: SourceSelection): ReadonlyArray<string> => {
  if (source.adapter === "copilot-marketplace" || source.adapter === "claude-marketplace") return []
  if (source.adapter === "hyperresearch") return []
  if (source.adapter === "codex-native") {
    return source.select.map((selection) => `plugins/${selection}/.codex`)
  }
  if (source.adapter === "prime-extension") {
    return source.select.map((selection) => `plugins/${selection}/extensions`)
  }
  return [...source.select.map((selection) => `plugins/${selection}`), "plugins/plugin-eval", "tools"]
}

export const sourceInventoryPolicy = (source: SourceSelection): InventoryPolicy =>
  source.kind === "plugin" && (source.adapter === "copilot-marketplace" || source.adapter === "claude-marketplace")
    ? { allowSymlinks: true }
    : {}
