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

const compactMcpServers = (tools: readonly string[]): string[] => {
  const compact = [...tools]
  const mcpServers = new Set(compact.filter((name) => name.startsWith("mcp:")).map((name) => name.slice(4)))
  for (const server of mcpServers) {
    const index = compact.indexOf(`mcp:${server}`)
    if (index >= 0) compact[index] = `${server}/*`
  }
  return compact
}

const commonPrefixGroups = (tools: readonly string[]): Map<string, string[]> => {
  const groups = new Map<string, string[]>()
  for (const name of tools) {
    if (name.includes("*")) continue
    const separator = Math.max(name.lastIndexOf("_"), name.lastIndexOf("-"))
    if (separator > 2)
      groups.set(name.slice(0, separator + 1), [
        ...(groups.get(name.slice(0, separator + 1)) ?? []),
        name.slice(separator + 1),
      ])
  }
  return groups
}

const suffixRange = (suffixes: readonly string[]): string => {
  const numeric = suffixes.map((suffix) => (/^\d+$/.test(suffix) ? Number(suffix) : null))
  if (!numeric.every((value) => value !== null)) return `[${suffixes.join(",")}]`
  const values = numeric.filter((value): value is number => value !== null)
  return `[${Math.min(...values)}-${Math.max(...values)}]`
}

const compactCommonPrefixes = (tools: readonly string[]): string[] => {
  const compact = [...tools]
  const groups = commonPrefixGroups(compact)
  for (const [prefix, suffixes] of groups)
    if (suffixes.length >= 3) {
      const before = compact.filter((name) => name.startsWith(prefix) && !name.includes("*"))
      for (const name of before) compact.splice(compact.indexOf(name), 1)
      compact.push(`${prefix}${suffixRange(suffixes)}`)
    }
  return [...new Set(compact)].sort()
}

const compactToolNames = (tools: readonly string[]): string[] => compactCommonPrefixes(compactMcpServers(tools))

export const budgetFromRoleCard = (roleCard: string | null): number | null => {
  if (!roleCard) return null
  const match = roleCard.match(/Budget:\s*\$([0-9]+(?:\.[0-9]+)?)(?:\s|USD)/)
  return match ? Number(match[1]) : null
}

const fitTools = (
  step: string | null,
  purpose: string,
  exclusions: string,
  tools: readonly string[],
  c: FactoryConfig,
): string => {
  const toolNames = compactToolNames(tools)
  const card = renderCard(step, purpose, exclusions, toolNames, c)
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
  if (encode(card).length > 200) throw new Error("role card cannot fit within 200 o200k_base tokens")
  return card
}

export const roleCard = (
  step: string | null,
  task: string,
  tools: readonly string[],
  c: FactoryConfig = factoryConfig(),
): string => boundedCard(step, purposeLine(task), exclusionsFor(step), tools, c)
