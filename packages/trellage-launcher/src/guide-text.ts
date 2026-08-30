/**
 * Shared strict-parsing primitives for the `trx guide` model-backed core.
 *
 * These mirror the validation style already used by `catalog.ts` and
 * `../../trellage-guide-core/dist/index.js` (exact keys, control-character
 * rejection, bounded lengths) so catalog parsing and model-output validation
 * fail closed the same way the rest of the launcher does.
 */

// Multiline text (e.g. prompts, prompt templates) allows tab (\u0009), LF
// (\u000a), and CR (\u000d) but rejects every other C0/C1 control character.
// Single-line text rejects the full C0/C1 control range, including tab/CR/LF.
// This mirrors `trellage-guide-core`'s `controls`/`singleLineControls`.
const multilineControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const singleLineControls = /[\u0000-\u001f\u007f-\u009f]/u

/** Portable skill/command identifier pattern, matching `trellage-guide-core`'s `skillIdentifier`. */
export const portableIdentifierPattern = /^[a-z0-9][a-z0-9._:/-]*$/u

export class GuideValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = "GuideValidationError"
    this.path = path
  }
}

export const fail = (path: string, message: string): never => {
  throw new GuideValidationError(path, message)
}

export const record = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(path, "must be an object")
  }
  return value as Record<string, unknown>
}

export const exactKeys = (
  value: Record<string, unknown>,
  path: string,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string> = [],
): void => {
  const allowed = new Set([...required, ...optional])
  const missing = required.filter((key) => !(key in value))
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (missing.length > 0) fail(path, `missing required keys: ${missing.join(", ")}`)
  if (unexpected.length > 0) fail(path, `contains unsupported keys: ${unexpected.join(", ")}`)
}

export const text = (
  value: unknown,
  path: string,
  maximum: number,
  options: { readonly multiline?: boolean } = {},
): string => {
  if (typeof value !== "string") return fail(path, "must be a string")
  const normalized = options.multiline ? value.trim() : value.trim().replace(/\s+/gu, " ")
  if (normalized.length === 0) return fail(path, "must not be empty")
  if ([...normalized].length > maximum) return fail(path, `must contain at most ${maximum} characters`)
  if ((options.multiline ? multilineControls : singleLineControls).test(normalized)) {
    return fail(path, "must not contain control characters")
  }
  return normalized
}

export const optionalText = (value: unknown, path: string, maximum: number): string | undefined =>
  value === undefined ? undefined : text(value, path, maximum)

export const boolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") return fail(path, "must be a boolean")
  return value
}

export const literal = <T extends string>(value: unknown, path: string, allowed: ReadonlyArray<T>): T => {
  if (typeof value !== "string" || !(allowed as ReadonlyArray<string>).includes(value)) {
    return fail(path, `must be one of: ${allowed.join(", ")}`)
  }
  return value as T
}

export const boundedNumber = (value: unknown, path: string, minimum: number, maximum: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, "must be a finite number")
  if (value < minimum || value > maximum) return fail(path, `must be between ${minimum} and ${maximum}`)
  return value
}

export const stringArray = (
  value: unknown,
  path: string,
  options: { readonly minimum?: number; readonly maximumItems?: number; readonly itemMaximum?: number } = {},
): ReadonlyArray<string> => {
  if (!Array.isArray(value)) return fail(path, "must be an array")
  const minimum = options.minimum ?? 0
  const maximumItems = options.maximumItems ?? 256
  if (value.length < minimum) return fail(path, `must contain at least ${minimum} entries`)
  if (value.length > maximumItems) return fail(path, `must contain at most ${maximumItems} entries`)
  return value.map((item, index) => text(item, `${path}[${index}]`, options.itemMaximum ?? 2000))
}

export const uniqueArray = <T>(values: ReadonlyArray<T>, path: string, label: string): ReadonlyArray<T> => {
  if (new Set(values).size !== values.length) fail(path, `must contain unique ${label}`)
  return values
}

export const array = (
  value: unknown,
  path: string,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) return fail(path, "must be an array")
  const minimum = options.minimum ?? 0
  const maximum = options.maximum ?? 256
  if (value.length < minimum) return fail(path, `must contain at least ${minimum} entries`)
  if (value.length > maximum) return fail(path, `must contain at most ${maximum} entries`)
  return value
}
