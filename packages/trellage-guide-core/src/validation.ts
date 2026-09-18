import { createHash } from "node:crypto"
import path from "node:path"

export class ProfileGuideValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = "ProfileGuideValidationError"
    this.path = path
  }
}

export const identityPart = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const singleLineControls = /[\u0000-\u001f\u007f-\u009f]/u

export const fail = (path: string, message: string): never => {
  throw new ProfileGuideValidationError(path, message)
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
  options: { readonly multiline?: boolean; readonly preserve?: boolean } = {},
): string => {
  if (typeof value !== "string") return fail(path, "must be a string")
  const normalized = options.preserve ? value : options.multiline ? value.trim() : value.trim().replace(/\s+/gu, " ")
  if (normalized.trim().length === 0) return fail(path, "must not be empty")
  if (normalized.length > maximum) return fail(path, `must contain at most ${maximum} characters`)
  if ((options.multiline ? controls : singleLineControls).test(normalized)) {
    return fail(path, "must not contain control characters")
  }
  if (options.preserve && /[\uD800-\uDFFF]/u.test(normalized)) {
    return fail(path, "must not contain unpaired Unicode surrogates")
  }
  return normalized
}

export const identifier = (value: unknown, path: string): string => {
  const result = text(value, path, 128)
  if (!identityPart.test(result)) return fail(path, "must be a lowercase kebab-case identifier")
  return result
}

export const choice = <T extends string>(value: unknown, field: string, choices: ReadonlyArray<T>): T => {
  for (const candidate of choices) {
    if (candidate === value) return candidate
  }
  return fail(field, `must equal one of: ${choices.join(", ")}`)
}

export const boolean = (value: unknown, field: string): boolean =>
  typeof value === "boolean" ? value : fail(field, "must be a boolean")

export const integer = (value: unknown, field: string, minimum: number, maximum: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fail(field, `must be an integer from ${minimum} to ${maximum}`)

export const exactText = (value: unknown, field: string, maximum: number, multiline = false): string =>
  text(value, field, maximum, { preserve: true, multiline })

export const hex = (value: unknown, field: string, lengths: ReadonlyArray<number>): string => {
  const result = exactText(value, field, 64)
  if (!/^[a-f0-9]+$/u.test(result) || !lengths.includes(result.length)) {
    fail(field, `must be a lowercase hexadecimal value of length ${lengths.join(" or ")}`)
  }
  return result
}

export const absolutePath = (value: unknown, field: string): string => {
  const result = exactText(value, field, 4096)
  if (!path.isAbsolute(result)) fail(field, "must be an absolute path")
  return result
}

export const uuid = (value: unknown, field: string): string => {
  const result = exactText(value, field, 36)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(result)) {
    fail(field, "must be a lowercase version-4 UUID")
  }
  return result
}

export const version = (fields: Record<string, unknown>, field: string): void => {
  if (fields.schemaVersion !== 1) fail(`${field}.schemaVersion`, "must equal 1")
}

const sortedJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, sortedJson(item)]))
  }
  return value
}

export const canonicalJson = (value: unknown): string => {
  // Match Python's sorted, compact ensure_ascii JSON in the native control helper.
  return JSON.stringify(sortedJson(value)).replace(/[\u007f-\uffff]/g, (unit) =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

export const canonicalDigest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")
