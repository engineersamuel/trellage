// Shell commands agents may never run: the human merges and deletes; only an approved finish worker pushes its branch.

const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])

/** git arguments after global options: ["push", "origin"] for `git -C /x push origin`. */
const gitArgs = (words: string[]): string[] => {
  let i = 0
  while (i < words.length && words[i]!.startsWith("-")) i += GIT_OPTS_WITH_VALUE.has(words[i]!) ? 2 : 1
  return words.slice(i)
}

/** `git push [-u] origin <branch>`: the only push a finish worker may run, to its own branch. No force, delete, or other ref. */
const pushesOnly = (args: string[], branch: string): boolean => {
  const pos = args.filter((a) => a !== "-u" && a !== "--set-upstream")
  return pos.length === 2 && pos[0] === "origin" && [branch, `HEAD:${branch}`, `HEAD:refs/heads/${branch}`].includes(pos[1]!)
}

const forbiddenGit = ([sub, ...rest]: string[], pushBranch?: string): boolean =>
  sub === "merge" ||
  (sub === "push" && !(pushBranch && pushesOnly(rest, pushBranch))) ||
  (sub === "branch" && rest.some((x) => x === "--delete" || /^-[a-zA-Z]*[dD]/.test(x))) ||
  (sub === "worktree" && rest[0] === "remove") ||
  (sub === "reset" && rest.includes("--hard"))

/** gh commands that merge or delete. `gh api` stays open for agents that need it. */
const forbiddenGh = ([sub, action, ...rest]: string[]): boolean =>
  (sub === "pr" && action === "merge") ||
  (sub === "pr" && action === "close" && rest.some((x) => x === "-d" || x === "--delete-branch")) ||
  (sub === "repo" && action === "delete")

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

const forbiddenAfter = (command: string, rest: string[], pushBranch?: string): boolean =>
  (command === "git" && forbiddenGit(gitArgs(rest), pushBranch)) ||
  (command === "gh" && forbiddenGh(rest)) ||
  (command === "rm" && recursiveForce(rest))

const forbiddenWords = (words: string[], pushBranch?: string): boolean =>
  words.some((w, i) => forbiddenAfter(basename(w), words.slice(i + 1), pushBranch))

/**
 * True when the shell line merges, pushes, deletes a branch or worktree, hard-resets, force-removes recursively,
 * or merges or deletes through gh. With `pushBranch`, a plain `git push [-u] origin <pushBranch>` is allowed.
 */
export const forbiddenCommand = (cmd: string, pushBranch?: string): boolean =>
  parse(cmd).some(
    (words) => forbiddenWords(words, pushBranch) || words.some((w) => isLine(w) && forbiddenCommand(w, pushBranch)),
  )
