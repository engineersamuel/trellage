import { exactKeys, fail, identifier, record, text } from "./validation.ts"

export interface SelectionMetadata {
  readonly description: string | null
  readonly strengths: ReadonlyArray<string> | null
  readonly weaknesses: ReadonlyArray<string> | null
  readonly bestFor: ReadonlyArray<string> | null
  readonly avoidFor: ReadonlyArray<string> | null
  readonly capabilities: ReadonlyArray<string> | null
}
export type MetadataStatus = "complete" | "incomplete"

const selectionKeys = ["description", "strengths", "weaknesses", "best_for", "avoid_for", "capabilities"]
const selectionText = (value: unknown, label: string): string => {
  if (typeof value === "string" && /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    fail(label, "must not contain control characters")
  return text(value, label, 2000)
}

/** Decode authored TOML; omission means unknown, never an empty assessment. */
export const parseSelectionMetadata = (value: unknown, label: string): SelectionMetadata => {
  const fields = record(value, label)
  exactKeys(fields, label, [], selectionKeys)
  const list = (key: string, identifiers = false): ReadonlyArray<string> | null => {
    if (fields[key] === undefined) return null
    const input = fields[key]
    if (!Array.isArray(input) || input.length > (identifiers ? 64 : 32))
      return fail(`${label}.${key}`, "must be a bounded array")
    const result = input.map((entry, index) =>
      identifiers ? identifier(entry, `${label}.${key}[${index}]`) : selectionText(entry, `${label}.${key}[${index}]`),
    )
    if (new Set(result).size !== result.length) fail(`${label}.${key}`, "must contain unique entries")
    return result
  }
  return {
    description: fields.description === undefined ? null : selectionText(fields.description, `${label}.description`),
    strengths: list("strengths"),
    weaknesses: list("weaknesses"),
    bestFor: list("best_for"),
    avoidFor: list("avoid_for"),
    capabilities: list("capabilities", true),
  }
}

export const parseSelectionProjection = (value: unknown, label: string): SelectionMetadata => {
  const fields = record(value, label)
  exactKeys(fields, label, ["description", "strengths", "weaknesses", "bestFor", "avoidFor", "capabilities"])
  return parseSelectionMetadata(
    Object.fromEntries(
      Object.entries(fields)
        .filter(([, item]) => item !== null)
        .map(([key, item]) => [key === "bestFor" ? "best_for" : key === "avoidFor" ? "avoid_for" : key, item]),
    ),
    label,
  )
}

export const selectionMetadataStatus = (selection: SelectionMetadata): MetadataStatus =>
  selection.description !== null && (selection.bestFor?.length ?? 0) > 0 ? "complete" : "incomplete"
