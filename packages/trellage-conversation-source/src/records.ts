export type JsonRecord = Record<string, unknown>

export const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export const hasErrorCode = (error: unknown, code: string) =>
  error !== null && typeof error === "object" && "code" in error && error.code === code

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
