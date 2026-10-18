import type { Key } from "ink"

export const isSubmitInput = (input: string, key: Key): boolean =>
  key.return || input === "\r" || input === "\n"
