import type { Tool } from "@github/copilot-sdk"
import { decode, encode } from "gpt-tokenizer/encoding/o200k_base"
import type { FactoryConfig } from "./config.ts"
import { factoryConfig } from "./config.ts"
import { loadPrompt } from "./prompt.ts"
import type { McpServer } from "./mcp.ts"

export const cardBudget = (step: string | null, c: FactoryConfig = factoryConfig()): number =>
  (step ? c.accountability.worker_usd[step] : undefined) ?? c.accountability.worker_usd.default

const tokensThrough = (text: string, count: number): string => {
  if (count <= 0) return ""
  const tokens = encode(text)
  if (tokens.length <= count) return text
  return decode(tokens.slice(0, count)).trimEnd()
}

export const purposeLine = (task: string): string => {
  const line = task
    .split(/\r?\n/)
    .map((x) => x.trim())
    .find(Boolean)
    ?.replace(/^[\s#>*_`-]+/, "")
    .replace(/[*_`]+/g, "")
    .trim()
  if (!line) return "(task unavailable)"
  return encode(line).length > 32 ? `${tokensThrough(line, 31)}…` : line
}

/** Active tools of a Pi worker session: Pi's built-ins plus pi-subagents' (always loaded, src/pi.ts). A step with
 * MCP servers binds extensions, which narrows this list. A test starts a real Pi session and checks it. */
export const PI_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "bg_wait",
  "contact_supervisor",
  "subagent",
  "subagents_enable",
]

export const grantedTools = (
  spec: { tools?: Tool<Record<string, unknown>>[] },
  mcp: Record<string, McpServer>,
  harness: "copilot" | "claude" | "pi" = "copilot",
): string[] =>
  [
    ...new Set([
      ...(spec.tools ?? []).map((tool) => tool.name),
      ...(harness === "pi" ? PI_TOOLS : []),
      ...(harness === "pi" ? [] : ["generate_image"]),
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

const renderCard = (
  step: string | null,
  purpose: string,
  exclusions: string,
  tools: readonly string[],
  c: FactoryConfig,
): string =>
  loadPrompt("role-card", {
    step: step ?? "(none)",
    purpose,
    exclusions,
    budget: cardBudget(step, c),
    tools: tools.join(","),
  })

const fitPurpose = (
  step: string | null,
  purpose: string,
  exclusions: string,
  tools: readonly string[],
  c: FactoryConfig,
): string => {
  let summary = purpose
  let card = renderCard(step, summary, exclusions, tools, c)
  const minimum = Math.min(3, encode(summary).length)
  while (encode(card).length > 200 && encode(summary).length > minimum) {
    summary = tokensThrough(summary, encode(summary).length - 1)
    card = renderCard(step, summary, exclusions, tools, c)
  }
  return card
}

export const budgetFromRoleCard = (roleCard: string | null): number | null => {
  if (!roleCard) return null
  const match = roleCard.match(/Budget:\s*\$([0-9]+(?:\.[0-9]+)?)(?:\s|USD)/)
  return match ? Number(match[1]) : null
}

const boundedCard = (
  step: string | null,
  purpose: string,
  exclusions: string,
  tools: readonly string[],
  c: FactoryConfig,
): string | null => {
  const complete = renderCard(step, purpose, exclusions, tools, c)
  if (encode(complete).length <= 200) return complete

  const fitted = fitPurpose(step, purpose, exclusions, tools, c)
  if (encode(fitted).length <= 200) return fitted
  return null
}

export const roleCard = (
  step: string | null,
  task: string,
  tools: readonly string[],
  c: FactoryConfig = factoryConfig(),
): string | null => boundedCard(step, purposeLine(task), exclusionsFor(step), tools, c)
