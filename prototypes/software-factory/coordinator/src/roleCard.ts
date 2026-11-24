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
    tools: tools.join(", "),
  })

const fitPurpose = (
  step: string | null,
  purpose: string,
  exclusions: string,
  tools: readonly string[],
  c: FactoryConfig,
): { summary: string; card: string } => {
  let summary = tokensThrough(purpose, Math.min(24, encode(purpose).length))
  let card = renderCard(step, summary, exclusions, tools, c)
  while (encode(card).length > 200 && encode(summary).length > 1) {
    summary = tokensThrough(summary, encode(summary).length - 1)
    card = renderCard(step, summary, exclusions, tools, c)
  }
  return { summary, card }
}

const fitTools = (
  step: string | null,
  purpose: string,
  exclusions: string,
  tools: readonly string[],
  c: FactoryConfig,
): string => {
  let toolNames = tools
  let card = renderCard(step, purpose, exclusions, toolNames, c)
  while (encode(card).length > 200 && toolNames.length > 1) {
    toolNames = toolNames.slice(0, toolNames.length - 1)
    const omitted = tools.length - toolNames.length
    card = renderCard(step, purpose, exclusions, [...toolNames, `(+${omitted} more)`], c)
  }
  return card
}

const boundedCard = (
  step: string | null,
  purpose: string,
  exclusions: string,
  tools: readonly string[],
  c: FactoryConfig,
): string => {
  const complete = renderCard(step, purpose, exclusions, tools, c)
  if (encode(complete).length <= 200) return complete

  const fitted = fitPurpose(step, purpose, exclusions, tools, c)
  const summary = fitted.summary
  let card = encode(fitted.card).length <= 200 ? fitted.card : fitTools(step, summary, exclusions, tools, c)
  if (encode(card).length > 200) card = renderCard(step, summary, exclusions, [], c)
  if (encode(card).length > 200) card = renderCard(step, summary, tokensThrough(exclusions, 8), [], c)
  if (encode(card).length > 200) throw new Error("role card cannot fit within 200 o200k_base tokens")
  return card
}

export const roleCard = (
  step: string | null,
  task: string,
  tools: readonly string[],
  c: FactoryConfig = factoryConfig(),
): string => boundedCard(step, purposeLine(task), exclusionsFor(step), tools, c)
