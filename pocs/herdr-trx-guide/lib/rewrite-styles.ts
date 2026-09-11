import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface RewriteStyle {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly instruction: string
  readonly skillPath?: string
}

export interface RewriteConfiguration {
  readonly styles?: ReadonlyArray<Partial<RewriteStyle> & { readonly id: string }>
  readonly model?: string
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max"
  readonly timeoutMs?: number
}

const referenceStyle = (id: string, title: string, description: string): RewriteStyle => ({
  id,
  title,
  description,
  instruction: "Rewrite the captured message using the attached style reference. Selecting this style explicitly requests its signature voice and format for this rewrite, overriding any generic artifact or deliverable exemptions in the reference. Apply its writing guidance to the supplied content only. Preserve technical facts, uncertainty, code, commands, links, constraints, and warnings. Do not invent causes, fixes, statuses, or missing context. Return only the rewritten message, without editing commentary or an audit report.",
  skillPath: fileURLToPath(new URL(`../rewrite-styles/${id}.md`, import.meta.url)),
})

export const defaultRewriteStyles: ReadonlyArray<RewriteStyle> = [
  {
    ...referenceStyle("rundown", "TL&DR Rundown", "TL;DR, status checkboxes, blockers, and next choices."),
    skillPath: path.join(homedir(), ".claude/output-styles/rundown.md"),
  },
  {
    id: "ponytail",
    title: "Ponytail voice",
    description: "Terse senior prose with the original facts and structure.",
    instruction:
      "Adapt the terse senior-developer persona from dietrichgebert/ponytail (https://github.com/dietrichgebert/ponytail) to prose: remove filler, keep the useful detail, retain validation, safety, error handling, accessibility, code, identifiers, and Markdown structure. Do not add claims or omit constraints.",
  },
  referenceStyle("ste-english", "STE English", "ASD-STE100 guidance: plain words, direct sentences."),
  {
    id: "caveman",
    title: "Caveman speech",
    description: "Very short, plain words while preserving technical accuracy.",
    instruction:
      'Use caveman speech: short blunt fragments, simple words, and deliberately sparse articles and pronouns. Example: "Build broken. Fix import. Tests pass now." Preserve every important fact, qualifier, code block, identifier, command, link, and Markdown structure. Never turn technical content into a joke or remove safety details.',
  },
  referenceStyle("military", "Military", "Problem → cause → fix. Terse facts, no preamble."),
  referenceStyle("bluf", "BLUF", "Conclusion first, then the reasons and tradeoffs."),
  referenceStyle("reality-check", "Reality Check", "What works, real risks, and a candid verdict."),
  referenceStyle("no-slop", "no-slop", "Plain, specific prose without AI filler or clichés."),
  referenceStyle("humanizer", "Humanizer", "Remove AI writing tells; keep voice and meaning."),
  referenceStyle("avoid-ai-writing", "avoid-ai-writing", "Audit AI patterns, then return the clean rewrite."),
  referenceStyle("no-ai-slop", "no-ai-slop", "Peter Yang’s editor: cut slop, keep your voice."),
  referenceStyle("unslop", "unslop", "Cut stock phrasing, filler, and canned transitions."),
  referenceStyle("spartan", "Spartan", "The whole answer first. Maximum compression."),
  referenceStyle("attention-kind", "Attention-kind", "Answer first, → bullets, and bold words to skim."),
  referenceStyle("wait-what", "wait-what", "Re-explain plainly with the missing context."),
  referenceStyle("eli15", "ELI15", "One clear analogy, its limits, and a takeaway."),
  referenceStyle("ladder", "ladder", "The same answer at ages 5, 15, and professional."),
  referenceStyle("analogy-engine", "analogy-engine", "One sustained analogy, mapped with its limits."),
  referenceStyle("first-principles", "First Principles", "Build the explanation from facts and assumptions."),
  referenceStyle("yoda", "Yoda", "Plain technical English; a Yoda-style final line."),
]

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const control = /[\u0000-\u001f\u007f-\u009f]/u

const clean = (value: unknown, label: string, maximum: number): string => {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || control.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

const validateStyle = (value: Partial<RewriteStyle> & { readonly id: string }): RewriteStyle => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("rewrite style is invalid")
  const id = clean(value.id, "rewrite style id", 64)
  if (!identifier.test(id)) throw new Error("rewrite style id is invalid")
  return {
    id,
    title: clean(value.title ?? id, "rewrite style title", 128),
    description: clean(value.description ?? "", "rewrite style description", 512),
    instruction: clean(value.instruction ?? "Preserve the original meaning and Markdown.", "rewrite style instruction", 4_096),
    ...(value.skillPath === undefined ? {} : { skillPath: clean(value.skillPath, "rewrite style skill path", 4_096) }),
  }
}

export const resolveRewriteStyles = (configuration: RewriteConfiguration = {}): ReadonlyArray<RewriteStyle> => {
  if (configuration.styles === undefined) return defaultRewriteStyles
  if (!Array.isArray(configuration.styles) || configuration.styles.length === 0 || configuration.styles.length > 32) {
    throw new Error("rewrite styles must contain between one and 32 styles")
  }
  const result = configuration.styles.map(validateStyle)
  if (new Set(result.map(({ id }) => id)).size !== result.length) throw new Error("rewrite style ids must be unique")
  return result
}

export const parseRewriteConfiguration = (value: unknown): RewriteConfiguration => {
  if (value === undefined) return {}
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("rewrite configuration is invalid")
  const configuration = value as Record<string, unknown>
  const model = configuration.model === undefined ? undefined : clean(configuration.model, "rewrite model", 128)
  const effort = configuration.effort === undefined ? undefined : clean(configuration.effort, "rewrite effort", 8)
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("rewrite effort is invalid")
  let timeoutMs: number | undefined
  if (configuration.timeoutMs !== undefined) {
    if (typeof configuration.timeoutMs !== "number") throw new Error("rewrite timeout is invalid")
    timeoutMs = configuration.timeoutMs
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000)) throw new Error("rewrite timeout is invalid")
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort: effort as RewriteConfiguration["effort"] }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(configuration.styles === undefined ? {} : { styles: configuration.styles as RewriteConfiguration["styles"] }),
  }
}
