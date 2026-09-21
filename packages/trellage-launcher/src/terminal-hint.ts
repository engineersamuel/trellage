import { toAsciiComponentText } from "./termcn/terminal-symbols.ts"
import { isNoUnicode } from "./termcn/use-unicode.ts"

/**
 * Rewrites one shortcut hint for a terminal without Unicode. Hints are written
 * with arrow and separator glyphs that would otherwise render as replacement
 * boxes; `↵` has no entry in the shared table, so it is spelled out first.
 *
 * `unicode` defaults to the environment for the same reason as
 * `spinnerFrameAt`: several hints are assembled in plain functions where a
 * hook cannot run. Components that already hold the capability pass it in.
 */
export const hintText = (hint: string, unicode = !isNoUnicode()): string =>
  unicode ? hint : toAsciiComponentText(hint.replaceAll("↵", "Enter"))
