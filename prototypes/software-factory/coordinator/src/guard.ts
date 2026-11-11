// Shell commands agents may never run: the human merges and deletes; only an approved finish worker pushes its branch.

const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"])

/** git arguments after global options: ["push", "origin"] for `git -C /x push origin`. */
const gitArgs = (words: string[]): string[] => {
  let i = 0
  while (i < words.length && words[i]!.startsWith("-")) i += GIT_OPTS_WITH_VALUE.has(words[i]!) ? 2 : 1
  return words.slice(i)
}

/** What a finish worker may push: its own branch, and `--force-with-lease` on it when the human allows that. */
export type PushRule = { branch: string; forceWithLease: boolean }

/** `--force-with-lease`, bare or for the branch itself (`=<branch>` or `=<branch>:<sha>`). Never plain `--force`. */
const leaseFor = (a: string, branch: string) =>
  a === "--force-with-lease" || a === `--force-with-lease=${branch}` || a.startsWith(`--force-with-lease=${branch}:`)

/** `git push [-u] [--force-with-lease] origin <branch>`: the only push a finish worker may run, to its own branch. */
const pushesOnly = (args: string[], { branch, forceWithLease }: PushRule): boolean => {
  const pos = args.filter((a) => a !== "-u" && a !== "--set-upstream" && !(forceWithLease && leaseFor(a, branch)))
  return (
    pos.length === 2 && pos[0] === "origin" && [branch, `HEAD:${branch}`, `HEAD:refs/heads/${branch}`].includes(pos[1]!)
  )
}

const forbiddenGit = ([sub, ...rest]: string[], push?: PushRule): boolean =>
  sub === "merge" ||
  (sub === "push" && !(push && pushesOnly(rest, push))) ||
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
  else if (l.quote === '"' && ch === "\\" && ESCAPABLE_IN_DOUBLE.has(next)) return (add(l, next), 2)
  else add(l, ch)
  return 1
}

/** One step outside quotes; returns the characters consumed. */
const outside = (l: Lexer, ch: string, next: string): number => {
  if (ch === "\\") return (add(l, next), 2)
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
  for (let i = 0; i < line.length;) i += (l.quote ? inQuote : outside)(l, line[i]!, line.charAt(i + 1))
  endWord(l)
  return l.cmds
}

/** A word that is itself a shell line, such as the script of `bash -c "git status; git push"`. */
const isLine = (w: string) => /[\s;&|()`$]/.test(w)

/** Credential files agents may read in place (e.g. COPILOT_PROXY_RS_CONFIG_DIR) but never copy or move. */
const CREDENTIAL =
  /(^|\/)(github_token|\.git-credentials|hosts\.yml|auth\.json|\.netrc|credentials(\.json)?|id_(rsa|ed25519|ecdsa))$/

const copiesCredential = (command: string, rest: string[]): boolean =>
  ["cp", "mv", "rsync", "scp", "install", "ditto", "ln"].includes(command) &&
  rest.some((w) => !w.startsWith("-") && CREDENTIAL.test(w))

const forbiddenAfter = (command: string, rest: string[], push?: PushRule): boolean =>
  copiesCredential(command, rest) ||
  (command === "git" && forbiddenGit(gitArgs(rest), push)) ||
  (command === "gh" && forbiddenGh(rest)) ||
  (command === "rm" && recursiveForce(rest))

const forbiddenWords = (words: string[], push?: PushRule): boolean =>
  words.some((w, i) => forbiddenAfter(basename(w), words.slice(i + 1), push))

/**
 * True when the shell line merges, pushes, deletes a branch or worktree, hard-resets, force-removes recursively,
 * or merges or deletes through gh. With `push`, `git push [-u] origin <branch>` is allowed, with
 * `--force-with-lease` when `push.forceWithLease`.
 */
export const forbiddenCommand = (cmd: string, push?: PushRule): boolean =>
  parse(cmd).some((words) => forbiddenWords(words, push) || words.some((w) => isLine(w) && forbiddenCommand(w, push)))
