// Plain /bin/sh mock executables for the exhaustive offline fixtures. A shell mock starts in a few milliseconds; a
// Bun mock costs ~80 ms per call, which made fixtures with many calls time out under the pre-push hook's load.

/** One shell word: the value in single quotes. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/**
 * Functions every mock starts with:
 * - `fail`: print `message` to stderr and exit 97 (the fixtures' "unexpected request" code).
 * - `args_json ARGS...`: the arguments as a compact JSON array (fixture tokens: only `"` and `\` are escaped).
 * - `args_are WORD...`: true when "$@" is exactly these words (set `joined` first with `join_args "$@"`).
 */
export const prelude = (message: string): string => String.raw`#!/bin/sh
fail() { printf '%s\n' ${shellWord(message)} >&2; exit 97; }
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
args_json() { out='['; sep=''; for a in "$@"; do out="$out$sep\"$(esc "$a")\""; sep=','; done; printf '%s]' "$out"; }
join_args() { joined=$(printf '%s\037' "$@"); joined=${"$"}{joined%?}; }
`

/** A `case` arm list that sets ok=1 when the joined arguments equal one of `allowed`. */
export const argsCases = (allowed: readonly (readonly string[])[]): string =>
  allowed.map((args) => `  ${shellWord(args.join("\x1f"))}) ok=1 ;;`).join("\n")

/** `fail` unless every variable has exactly its value. */
export const requireEnv = (required: Readonly<Record<string, string>>): string =>
  Object.entries(required)
    .map(([key, value]) => `[ "${"$"}{${key}:-}" = ${shellWord(value)} ] || fail`)
    .join("\n")

/** Write `content` to `file` exactly (no added newline), from a shell word. */
export const writeExact = (file: string, content: string): string =>
  `printf '%s' ${shellWord(content)} > ${shellWord(file)}`
