import { execFileSync } from "node:child_process"
import path from "node:path"

export type PathKind = "test" | "docs" | "code"
type ChangeKind = PathKind | "neutral"
type Change = { kind: ChangeKind; detail?: string }
type Commit = { sha: string; changes: Change[] }
type FileChange = { path: string; status: string }
type RustSource = { lines: string[]; normal: boolean[]; tests: Set<number> }

const MISSING = "no tests-only commit before the first code commit"

export const testFirstFailure = (history: Iterable<Commit>): string | null => {
  for (const commit of history) {
    const code = commit.changes.find((change) => change.kind === "code")
    if (code) return `${MISSING}${commit.sha ? `; ${commit.sha}` : ""}${code.detail ? ` ${code.detail}` : ""}`
    if (commit.changes.some((c) => c.kind === "test") && !commit.changes.some((c) => c.kind === "docs")) return null
  }
  return MISSING
}

const git = (workdir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", workdir, ...args], { encoding: "utf8", maxBuffer: 8 << 20 })

type LexState = { close: string | null; raw: boolean; depth: number; start: number }

const markerLike = (line: string): boolean =>
  /^#\[cfg\(test\)]\s*$|^mod [A-Za-z_][A-Za-z0-9_]* \{\s*$|^}\s*$/.test(line)

const stepComment = (line: string, i: number, s: LexState): [number, LexState] => {
  if (line.startsWith("/*", i)) return [i + 2, { ...s, depth: s.depth + 1 }]
  if (line.startsWith("*/", i)) return [i + 2, { ...s, depth: s.depth - 1 }]
  return [i + 1, s]
}

const stepString = (line: string, i: number, s: LexState): [number, LexState] => {
  if (!s.raw && line[i] === "\\") return [i + 2, s]
  if (line.startsWith(s.close!, i)) return [i + s.close!.length, { ...s, close: null }]
  return [i + 1, s]
}

const stringStart = (line: string, i: number, s: LexState): [number, LexState] | null => {
  const match = /^(?:(b?r)(#*)"|[bc]?")/.exec(line.slice(i))
  if (!match) return null
  if (/[A-Za-z0-9_]/.test(line[i - 1] || "")) throw new Error("unsupported string prefix")
  const [full, raw, hashes = ""] = match
  return [i + full.length, { ...s, close: `"${hashes}`, raw: Boolean(raw) }]
}

const charSkip = (line: string, i: number): number => {
  const [token] =
    /^'\\?(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)'|^'[A-Za-z_][A-Za-z0-9_]*(?!')/.exec(line.slice(i)) || []
  if (token) return i + token.length
  throw new Error("unterminated or unsupported character literal")
}

const stepNormal = (line: string, i: number, s: LexState): [number, LexState] => {
  if (line.startsWith("//", i)) return [line.length, s]
  if (line.startsWith("/*", i)) return [i + 2, { ...s, depth: 1 }]
  const str = stringStart(line, i, s)
  if (str) return str
  if (line[i] === "'") return [charSkip(line, i), s]
  return [i + 1, s]
}

const scanLine = (line: string, lineNo: number, s: LexState): LexState => {
  let i = 0
  while (line[i]) {
    if (s.depth) [i, s] = stepComment(line, i, s)
    else if (s.close) [i, s] = stepString(line, i, s)
    else [i, s] = stepNormal(line, i, { ...s, start: lineNo })
  }
  return s
}

/** Only markers hidden inside strings or comments can fake a test module; unchanged multiline literals do not. */
const scanStarts = (file: string, lines: string[]): boolean[] => {
  let s = {} as LexState
  const normal = lines.map((line, idx) => {
    const startsNormal = !s.close && !s.depth
    if (!startsNormal && markerLike(line))
      throw new Error(`${file}:${s.start}: unsupported multiline comment or string around test module marker`)
    s = scanLine(line, idx + 1, s)
    return startsNormal
  })
  if (s.close || s.depth) throw new Error(`${file}:${s.start}: unterminated string or comment`)
  return normal
}

const moduleEnd = (file: string, lines: string[], normal: boolean[], start: number): number => {
  const modIdx = start + 1
  if (!normal[modIdx] || !/^mod [A-Za-z_][A-Za-z0-9_]* \{\s*$/.test(lines[modIdx]!))
    throw new Error(`${file}:${modIdx}: expected a column-0 inline test module after #[cfg(test)]`)
  for (let i = modIdx + 1; lines[i] !== undefined; i++) {
    const line = lines[i]!
    if (normal[i] && /^}\s*$/.test(line)) return i
    if (normal[i] && /^\S/.test(line)) throw new Error(`${file}:${i + 1}: non-indented test module interior`)
  }
  throw new Error(`${file}:${modIdx}: test module has no column-0 closing brace`)
}

/** Deliberately recognize only the conventional column-0 module layout, not arbitrary Rust syntax. */
const rustSource = (file: string, text: string): RustSource => {
  const lines = text.split("\n")
  const normal = scanStarts(file, lines)
  const tests = new Set<number>()
  for (let i = 0; lines[i] !== undefined; i++) {
    if (normal[i] && /^#\[cfg\(test\)]\s*$/.test(lines[i]!)) {
      const end = moduleEnd(file, lines, normal, i)
      for (; i <= end; i++) tests.add(i)
      i--
    }
  }
  return { lines, normal, tests }
}

const testOnlySource = (source: RustSource): boolean =>
  source.tests.size !== 0 &&
  source.lines.every((line, i) => source.normal[i] && (source.tests.has(i) || /^\s*(?:\/\/.*)?$/.test(line)))

const changedLines = (patch: string, side: "old" | "new"): number[] =>
  [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].flatMap((hunk) => {
    const [, oldStart, oldCount, newStart, newCount] = hunk
    const [startText, countText] = side === "old" ? [oldStart, oldCount] : [newStart, newCount]
    const start = Number(startText) - 1
    return Array.from({ length: Number(countText || 1) }, (_, i) => start + i)
  })

const wiredModule = (file: string, line: string, addedTests: Set<string>): boolean => {
  const [, name] = /^mod ([A-Za-z_][A-Za-z0-9_]*);$/.exec(line) || []
  if (!name) return false
  const directory = /^(lib|main|mod)\.rs$/.test(path.posix.basename(file))
    ? path.posix.dirname(file)
    : file.slice(0, -3)
  return addedTests.has(path.posix.join(directory, `${name}.rs`))
}

const rustLines = (file: string, source: RustSource, indices: number[], addedTests: Set<string>): Change => {
  let kind: ChangeKind = "neutral"
  for (const i of indices) {
    if (!source.normal[i]) throw new Error(`${file}:${i + 1}: changed line inside multiline comment or string`)
    const line = source.lines[i]!
    if (!line.trim()) continue
    if (!source.tests.has(i) && !wiredModule(file, line, addedTests))
      return { kind: "code", detail: `${file}:${i + 1}: production change outside a test module` }
    kind = "test"
  }
  return { kind }
}

const patchFor = (workdir: string, sha: string, file: string): string =>
  git(
    workdir,
    "show",
    "--format=",
    "--diff-merges=first-parent",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=0",
    sha,
    "--",
    `:(literal)${file}`,
  )

const combinedChanges = (added: Change, removed: Change): Change => {
  if (added.kind === "code") return added
  if (removed.kind === "code") return removed
  return { kind: added.kind === "test" || removed.kind === "test" ? "test" : "neutral" }
}

const classifyRust = (workdir: string, sha: string, file: FileChange, addedTests: Set<string>): Change => {
  try {
    if (addedTests.has(file.path)) return { kind: "test" }
    const patch = patchFor(workdir, sha, file.path)
    if (patch.includes("Binary files")) throw new Error("binary Rust diff")
    const before = file.status === "A" ? "" : git(workdir, "show", `${sha}^:${file.path}`)
    const after = file.status === "D" ? "" : git(workdir, "show", `${sha}:${file.path}`)
    const removed = rustLines(file.path, rustSource(file.path, before), changedLines(patch, "old"), new Set())
    const added = rustLines(file.path, rustSource(file.path, after), changedLines(patch, "new"), addedTests)
    return combinedChanges(added, removed)
  } catch (error) {
    return { kind: "code", detail: `${file.path}: could not be classified: ${String(error)}` }
  }
}

const filesAt = (workdir: string, sha: string): FileChange[] => {
  const fields = git(
    workdir,
    "diff-tree",
    "--root",
    "--first-parent",
    "-m",
    "--no-commit-id",
    "--name-status",
    "-z",
    "-r",
    "--no-renames",
    sha,
  )
    .split("\0")
    .slice(0, -1)
  const files: FileChange[] = []
  for (let i = 0; i < fields.length; i += 2) files.push({ status: fields[i]!, path: fields[i + 1]! })
  return files
}

const newTestModules = (workdir: string, sha: string, files: FileChange[]): Set<string> => {
  const addedTests = new Set<string>()
  for (const file of files.filter((f) => f.status === "A" && f.path.endsWith(".rs"))) {
    try {
      if (testOnlySource(rustSource(file.path, git(workdir, "show", `${sha}:${file.path}`)))) addedTests.add(file.path)
    } catch {
      // Not eligible for wiring; classifyRust reports the source failure with its location.
    }
  }
  return addedTests
}

function* commits(workdir: string, base: string, pathKind: (file: string) => PathKind): Iterable<Commit> {
  const shas = git(workdir, "rev-list", "--reverse", `${base}..HEAD`).trim().split("\n").filter(Boolean)
  for (const sha of shas) {
    const files = filesAt(workdir, sha)
    const addedTests = newTestModules(workdir, sha, files)
    const changes = files.map((file): Change => {
      const kind = pathKind(file.path)
      if (kind !== "code") return { kind }
      if (file.path.endsWith(".rs")) return classifyRust(workdir, sha, file, addedTests)
      const patch = patchFor(workdir, sha, file.path)
      const line = (changedLines(patch, "new")[0] ?? changedLines(patch, "old")[0] ?? 0) + 1
      return { kind, detail: `${file.path}:${line}: production path` }
    })
    yield { sha: git(workdir, "rev-parse", "--short", sha).trim(), changes }
  }
}

export const committedTestFirstFailure = (
  workdir: string,
  base: string,
  pathKind: (file: string) => PathKind,
): string | null => {
  try {
    return testFirstFailure(commits(workdir, base, pathKind))
  } catch (error) {
    return `${MISSING}; commit history could not be classified: ${String(error)}`
  }
}
