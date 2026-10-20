import type { DomainValue } from "./exhaustive-cli-domains.ts"
import { GuideEffort, GuideLongPromptVariant } from "../packages/trellage-launcher/src/guide-api.ts"

type Selection = ReadonlyMap<string, DomainValue>
type Expected = { readonly error: string } | { readonly result: Record<string, unknown> }

export const expectedGuide = (selected: Selection): Expected => {
  const present = (name: string): boolean => selected.get(name)!.argv.length !== 0
  const value = (name: string): string | undefined => selected.get(name)!.argv[1]
  const normalized = (name: string): string | undefined => value(name)?.trim().replace(/\s+/gu, " ")
  const intent = value("--intent")
  const profile = normalized("--profile")
  const model = normalized("--model")
  const base = normalized("--base")
  const effort = value("--effort")
  const variant = value("--ui-variant")
  const textAccepted = (text: string | undefined, maximum: number, multiline = false): boolean =>
    text === undefined ||
    (text.trim().length > 0 &&
      [...text].length <= maximum &&
      !(multiline && /[\uD800-\uDFFF]/u.test(text)) &&
      !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(
        text,
      ))
  if (
    !textAccepted(intent, 60_000, true) ||
    !textAccepted(profile, 256) ||
    !textAccepted(model, 128) ||
    !textAccepted(base, 256) ||
    (model !== undefined && !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(model)) ||
    (effort !== undefined && !Object.values(GuideEffort).includes(effort as GuideEffort)) ||
    (variant !== undefined && !Object.values(GuideLongPromptVariant).includes(variant as GuideLongPromptVariant))
  )
    return { error: "GuideValidationError" }

  const json = present("--json")
  const stdin = present("--intent-stdin")
  const next = present("--next-steps")
  const engagement = present("--engagement")
  const review = present("--review")
  const optimize = present("--optimize")
  const ritual = present("--prompts")
  const print = present("--print")
  const copy = present("--copy")
  const positionals = selected.get("positionals")!.argv
  const positional = positionals[0]
  const hasInput = intent !== undefined || positionals.length > 0 || stdin
  const modeConflicts = [
    positionals.length > 1,
    intent !== undefined && positional !== undefined,
    stdin && (intent !== undefined || positional !== undefined || json),
    engagement && (json || next || review || ritual || profile !== undefined || variant !== undefined),
    review && (json || next || engagement || ritual || profile !== undefined || variant !== undefined),
    base !== undefined && !review,
    optimize && (review || json || next || engagement || ritual || profile !== undefined || hasInput),
    !ritual && (print || copy),
    ritual &&
      (json ||
        next ||
        engagement ||
        review ||
        optimize ||
        profile !== undefined ||
        variant !== undefined ||
        base !== undefined ||
        intent !== undefined ||
        stdin),
    ritual && print && copy,
    ritual && (print || copy) && positional === undefined,
    ritual && positional !== undefined && (positional.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(positional)),
    next && (json || hasInput || profile !== undefined || variant !== undefined),
    profile !== undefined && !json,
    variant !== undefined && json,
  ]
  if (modeConflicts.some(Boolean)) return { error: "GuideArgsError" }
  const resolvedIntent = ritual ? intent : (intent ?? positional)
  if (!textAccepted(resolvedIntent, 60_000, true)) return { error: "GuideValidationError" }
  const result: Record<string, unknown> = {
    help: present("--help"),
    json,
    intent: resolvedIntent,
    intentStdin: stdin,
    profile,
    model,
    effort,
  }
  for (const [key, enabled] of Object.entries({
    nextSteps: next,
    engagement,
    review,
    optimize,
    ritual,
    ritualPrint: print,
    ritualCopy: copy,
  })) {
    if (enabled) result[key] = true
  }
  if (variant !== undefined) result.uiVariant = variant
  if (base !== undefined) result.reviewBase = base
  if (ritual && positional !== undefined) result.ritualId = positional
  return { result }
}
