// Sub-coordinators coordinate; workers change things. A sub-coordinator's shell may only read: an allow-list of
// commands, no output redirection to files, and per-command limits (no sed -i, no find -exec, read-only git and gh).
// Edits, builds, tests and servers go through implement and verify workers, so every change passes the SDLC gates.
import { loadPrompt } from "./prompt.ts"

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"])

/** Words of each simple command, and whether the line writes a file with `>` (fd dups and /dev/null are fine). */
export const splitLine = (line: string): { cmds: string[][]; writes: boolean; substitution: boolean } => {
  const cmds: string[][] = [[]]
  let word: string | null = null
  let quote: string | null = null
  let writes = false
  let substitution = false
  const end = () => {
    if (word !== null) cmds.at(-1)!.push(word)
    word = null
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
      else {
        if (quote === '"' && (ch === "`" || (ch === "$" && line[i + 1] === "("))) substitution = true
        word = (word ?? "") + ch
      }
      continue
    }
    if (ch === "\\") {
      word = (word ?? "") + (line[i + 1] ?? "")
      i++
    } else if (ch === "'" || ch === '"') {
      quote = ch
      word = word ?? ""
    } else if (ch === "`" || (ch === "$" && line[i + 1] === "(")) {
      substitution = true
      word = (word ?? "") + ch
    } else if (ch === ">") {
      const rest = line.slice(i + 1).replace(/^>/, "")
      const target = rest.trimStart()
      if (!target.startsWith("&") && !target.startsWith("/dev/null")) writes = true
      end()
      if (line[i + 1] === ">") i++
    } else if (ch === "<" && line[i + 1] === "<") {
      // A heredoc feeds a command; the command itself is checked.
      end()
      i++
    } else if (SEPARATORS.has(ch)) {
      end()
      cmds.push([])
    } else if (/\s/.test(ch)) end()
    else word = (word ?? "") + ch
  }
  end()
  return { cmds: cmds.map((c) => c.filter((w) => !/^\d?$/.test(w) || w === "0")).filter((c) => c.length), writes, substitution }
}

const PLAIN = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd", "jq", "yq", "tree", "file", "stat", "pwd", "echo", "printf", "which", "type",
  "command", "test", "[", "true", "false", "sort", "uniq", "cut", "tr", "basename", "dirname", "realpath", "readlink", "date", "cd",
  "diff", "comm", "column", "less", "nl", "du", "df", "whoami", "uname", "id", "lsof", "ps", "pgrep", "sleep",
])
const GIT_READ = new Set(["status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse", "blame", "grep", "describe", "shortlog", "rev-list", "cat-file", "merge-base", "remote", "config", "branch", "tag", "worktree"])
const GH_READ: Record<string, Set<string>> = { pr: new Set(["view", "list", "checks", "diff", "status"]), run: new Set(["view", "list"]), repo: new Set(["view"]), issue: new Set(["view", "list"]) }

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1)

/** Why this simple command is not read-only; null when it is. */
const notReadOnly = ([cmd0, ...args]: string[]): string | null => {
  const cmd = basename(cmd0!)
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd0!)) return args.length ? notReadOnly(args) : null
  if (PLAIN.has(cmd)) return null
  if (cmd === "sed") return args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) ? "sed -i edits files" : null
  if (cmd === "find") return args.some((a) => ["-exec", "-execdir", "-delete", "-ok", "-fprint", "-fprintf"].includes(a)) ? "find with -exec/-delete" : null
  if (cmd === "git") {
    const sub = args.find((a, i) => !a.startsWith("-") && !["-C", "-c"].includes(args[i - 1] ?? ""))
    if (!sub || !GIT_READ.has(sub)) return `git ${sub ?? ""} changes the repo`
    if (sub === "branch" || sub === "tag" || sub === "worktree" || sub === "remote" || sub === "config")
      return args.slice(args.indexOf(sub) + 1).every((a) => a.startsWith("-") && !/^-(d|D|m|M|c|C|f)$|delete|move|copy|force|add|set|unset|replace/.test(a)) || (sub === "worktree" && args.includes("list"))
        ? null
        : `git ${sub} with arguments changes the repo`
    return null
  }
  if (cmd === "gh") {
    const [a, b] = args
    return a && b && GH_READ[a]?.has(b) ? null : `gh ${a ?? ""} ${b ?? ""} is not read-only`
  }
  if (cmd === "curl") return args.some((a) => /^-(o|O|T|d|F|X)|^--(output|upload-file|data|form|request)/.test(a)) ? "curl that writes or posts" : null
  if (cmd === "mise") return ["ls", "tasks", "which", "where", "current", "--version", "version", "doctor"].includes(args[0] ?? "") ? null : `mise ${args[0] ?? ""} runs or installs`
  if (cmd === "cargo") return ["metadata", "tree", "--version", "version", "pkgid", "locate-project", "read-manifest"].includes(args[0] ?? "") ? null : `cargo ${args[0] ?? ""} builds or runs`
  if (["node", "bun", "python3", "python", "npm", "go", "rustc"].includes(cmd)) return args.length === 1 && ["--version", "-v", "-V", "version"].includes(args[0]!) ? null : `${cmd} runs code`
  return `${cmd} is not on the read-only list`
}

/** Null when the whole shell line only reads; else why it is refused. */
export const readOnlyViolation = (line: string): string | null => {
  const { cmds, writes, substitution } = splitLine(line)
  if (writes) return "output redirection writes a file"
  if (substitution) return "command substitution is not allowed"
  for (const c of cmds) {
    const why = notReadOnly(c)
    if (why) return why
  }
  return null
}

export const subShellFeedback = () => loadPrompt("sub-shell-feedback")
