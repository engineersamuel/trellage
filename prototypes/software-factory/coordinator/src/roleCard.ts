import type { Tool } from "@github/copilot-sdk"
import type { FactoryConfig } from "./config.ts"
import { factoryConfig } from "./config.ts"
import { loadPrompt } from "./prompt.ts"
import type { McpServer } from "./mcp.ts"

export const cardBudget = (step: string | null, c: FactoryConfig = factoryConfig()): number =>
  (step ? c.accountability.worker_usd[step] : undefined) ?? c.accountability.worker_usd.default

export const purposeLine = (task: string): string => {
  const line = task
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean)
    ?.replace(/^[\s#>*_`-]+/, "")
    .replace(/[*_`]+/g, "")
    .trim()
  if (!line) return "(task unavailable)"
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}\u2026` : line
}

export const grantedTools = (
  spec: { tools?: Tool<Record<string, unknown>>[] },
  mcp: Record<string, McpServer>,
): string[] =>
  [
    ...new Set([
      ...(spec.tools ?? []).map((tool) => tool.name),
      "generate_image",
      ...Object.keys(mcp).map((x) => `mcp:${x}`),
    ]),
  ].sort()

const exclusionsFor = (step: string | null): string => {
  if (!step) return loadPrompt("role-cards/default")
  try {
    return loadPrompt(`role-cards/${step}`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("unknown prompt role-cards/"))
      return loadPrompt("role-cards/default")
    throw e
  }
}

export const roleCard = (
  step: string | null,
  task: string,
  tools: readonly string[],
  c: FactoryConfig = factoryConfig(),
): string =>
  loadPrompt("role-card", {
    step: step ?? "(none)",
    purpose: purposeLine(task),
    exclusions: exclusionsFor(step),
    budget: cardBudget(step, c),
    tools: tools.join(", "),
  })
