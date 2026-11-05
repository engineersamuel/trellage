// Shell commands the global coordinator may never run: the human merges, pushes, and deletes.

const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])

/** git arguments after global options: ["push", "origin"] for `git -C /x push origin`. */
const gitArgs = (words: string[]): string[] => {
  let i = 0
  while (i < words.length && words[i]!.startsWith("-")) i += GIT_OPTS_WITH_VALUE.has(words[i]!) ? 2 : 1
  return words.slice(i)
}

const forbiddenGit = ([sub, ...rest]: string[]): boolean =>
  sub === "merge" ||
  sub === "push" ||
  (sub === "branch" && rest.some((x) => x === "--delete" || /^-[a-zA-Z]*[dD]/.test(x))) ||
  (sub === "worktree" && rest[0] === "remove") ||
  (sub === "reset" && rest.includes("--hard"))

const flags = (words: string[]) => words.filter((x) => x.startsWith("-"))
const recursiveForce = (words: string[]): boolean => {
  const fs = flags(words)
  const short = fs.filter((x) => !x.startsWith("--")).join("")
  return (/[rR]/.test(short) || fs.includes("--recursive")) && (short.includes("f") || fs.includes("--force"))
}

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1)

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")", "`", "$"])
const ESCAPABLE_IN_DOUBLE = new Set(['"', "\\", "$", "`", "\n"])

type Lexer = { cmds: string[][]; word: string | null; quote: string | null }

const add = (l: Lexer, s: string) => void (l.word = (l.word ?? "") + s)
const endWord = (l: Lexer) => {
  if (l.word !== null) l.cmds.at(-1)!.push(l.word)
  l.word = null
}

/** One step inside quotes; returns the characters consumed. Single quotes take everything literally. */
const inQuote = (l: Lexer, ch: string, next: string): number => {
  if (ch === l.quote) l.quote = null
  else if (l.quote === '"' && ch === "\\" && ESCAPABLE_IN_DOUBLE.has(next)) return add(l, next), 2
  else add(l, ch)
  return 1
}

/** One step outside quotes; returns the characters consumed. */
const outside = (l: Lexer, ch: string, next: string): number => {
  if (ch === "\\") return add(l, next), 2
  if (ch === "'" || ch === '"') {
    l.quote = ch
    add(l, "")
  } else if (SEPARATORS.has(ch)) {
    endWord(l)
    l.cmds.push([])
  } else if (/\s/.test(ch)) endWord(l)
  else add(l, ch)
  return 1
}

/** Shell words of each simple command (some may be empty): quotes group a word and are dropped, a backslash escapes. */
const parse = (line: string): string[][] => {
  const l: Lexer = { cmds: [[]], word: null, quote: null }
  for (let i = 0; i < line.length; ) i += (l.quote ? inQuote : outside)(l, line[i]!, line.charAt(i + 1))
  endWord(l)
  return l.cmds
}

/** A word that is itself a shell line, such as the script of `bash -c "git status; git push"`. */
const isLine = (w: string) => /[\s;&|()`$]/.test(w)

const forbiddenAfter = (command: string, rest: string[]): boolean =>
  (command === "git" && forbiddenGit(gitArgs(rest))) || (command === "rm" && recursiveForce(rest))

const forbiddenWords = (words: string[]): boolean => words.some((w, i) => forbiddenAfter(basename(w), words.slice(i + 1)))

/** True when the shell line merges, pushes, deletes a branch or worktree, hard-resets, or force-removes recursively. */
export const forbiddenCommand = (cmd: string): boolean =>
  parse(cmd).some((words) => forbiddenWords(words) || words.some((w) => isLine(w) && forbiddenCommand(w)))
