import type { InventoryPolicy } from "./inventory.js"

export interface SourceSelection {
  readonly kind: "skill" | "plugin"
  readonly adapter?: "codex-native" | "copilot-marketplace" | "hyperresearch" | "omp-native" | "wshobson-agents"
  readonly marketplace?: string
  readonly select: ReadonlyArray<string>
}

export const sourceIncludes = (source: SourceSelection): ReadonlyArray<string> => {
  if (source.kind === "skill") {
    return source.adapter === "omp-native" ? source.select.map((selection) => `.omp/skills/${selection}`) : ["skills"]
  }
  if (source.adapter === "copilot-marketplace") return []
  if (source.adapter === "hyperresearch") return []
  if (source.adapter === "codex-native") {
    return source.select.map((selection) => `plugins/${selection}/.codex`)
  }
  return [...source.select.map((selection) => `plugins/${selection}`), "plugins/plugin-eval", "tools"]
}

export const sourceInventoryPolicy = (source: SourceSelection): InventoryPolicy =>
  source.kind === "plugin" && source.adapter === "copilot-marketplace" ? { allowSymlinks: true } : {}
