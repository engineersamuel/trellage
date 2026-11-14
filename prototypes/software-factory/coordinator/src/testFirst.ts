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
    const kinds = commit.changes.map((change) => change.kind)
    if (kinds.includes("test") && kinds.every((kind) => kind === "test" || kind === "neutral")) return null
  }
  return MISSING
}

const git = (workdir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", workdir, ...args], { encoding: "utf8", maxBuffer: 8 << 20 })

type LexState = { close: string | null; depth: number; start: number }

const markerLike = (line: string): boolean =>
  /^#\[cfg\(test\)]\s*$|^mod [A-Za-z_][A-Za-z0-9_]* \{\s*$|^}\s*$/.test(line)

const stepComment = (line: string, i: number, s: LexState): [number, LexState] => {
  if (line.startsWith("/*", i)) return [i + 2, { ...s, depth: s.depth + 1 }]
  if (line.startsWith("*/", i)) return [i + 2, { ...s, depth: s.depth - 1 }]
  return [i + 1, s]
}

const stepString = (line: string, i: number, s: LexState): [number, LexState] => {
  if (s.close === '"' && line[i] === "\\") return [i + 2, s]
  if (line.startsWith(s.close!, i)) return [i + s.close!.length, { ...s, close: null }]
  return [i + 1, s]
}

const rawStart = (line: string, i: number): [number, string] | null => {
  const match = /^(?:b?r)(#*)"/.exec(line.slice(i))
  if (!match) return null
  if (i > 0 && /[A-Za-z0-9_]/.test(line[i - 1]!)) throw new Error("unsupported string prefix")
  return [i + match[0].length, `"${match[1]!}`]
}

const charSkip = (line: string, i: number): number => {
  const char = /^'\\?(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)'/.exec(line.slice(i))
  if (char) return i + char[0].length
  const lifetime = /^'[A-Za-z_][A-Za-z0-9_]*(?!')/.exec(line.slice(i))
  if (lifetime) return i + lifetime[0].length
  throw new Error("unterminated or unsupported character literal")
}

const stepNormal = (line: string, i: number, lineNo: number): [number, LexState] => {
  if (line.startsWith("//", i)) return [line.length, { close: null, depth: 0, start: lineNo }]
  if (line.startsWith("/*", i)) return [i + 2, { close: null, depth: 1, start: lineNo }]
  const raw = rawStart(line, i)
  if (raw) return [raw[0], { close: raw[1], depth: 0, start: lineNo }]
  if (line[i] === '"') {
    if (i > 0 && /[A-Za-z0-9_]/.test(line[i - 1]!)) throw new Error("unsupported string prefix")
    return [i + 1, { close: '"', depth: 0, start: lineNo }]
  }
  if (line[i] === "'") return [charSkip(line, i), { close: null, depth: 0, start: lineNo }]
  return [i + 1, { close: null, depth: 0, start: lineNo }]
}

const scanLine = (line: string, lineNo: number, s: LexState): LexState => {
  for (let i = 0; i < line.length;) {
    if (s.depth > 0) [i, s] = stepComment(line, i, s)
    else if (s.close !== null) [i, s] = stepString(line, i, s)
    else [i, s] = stepNormal(line, i, lineNo)
  }
  return s
}

/** Only markers hidden inside strings or comments can fake a test module; a multi-line string elsewhere does not. */
const scanStarts = (file: string, lines: string[]): boolean[] => {
  let s: LexState = { close: null, depth: 0, start: 1 }
  const normal = lines.map((line, idx) => {
    const startsNormal = s.close === null && s.depth === 0
    if (!startsNormal && markerLike(line))
      throw new Error(`${file}:${s.start}: unsupported multiline comment or string around test module marker`)
    s = scanLine(line, idx + 1, s)
    return startsNormal
  })
  if (s.close !== null || s.depth > 0) throw new Error(`${file}:${s.start}: unterminated string or comment`)
  return normal
}

const moduleEnd = (file: string, lines: string[], normal: boolean[], start: number): number => {
  if (!normal[start + 1] || !/^mod [A-Za-z_][A-Za-z0-9_]* \{\s*$/.test(lines[start + 1] ?? ""))
    throw new Error(`${file}:${start + 1}: expected a column-0 inline test module after #[cfg(test)]`)
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i]!
    if (normal[i] && /^}\s*$/.test(line)) return i
    if (normal[i] && /^\S/.test(line)) throw new Error(`${file}:${i + 1}: non-indented test module interior`)
  }
  throw new Error(`${file}:${start + 1}: test module has no column-0 closing brace`)
}

/** Deliberately recognize only the conventional column-0 module layout, not arbitrary Rust syntax. */
const rustSource = (file: string, text: string): RustSource => {
  const lines = text.split("\n")
  const normal = scanStarts(file, lines)
  const tests = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (normal[i] && /^#\[cfg\(test\)]\s*$/.test(lines[i]!)) {
      const end = moduleEnd(file, lines, normal, i)
      for (; i <= end; i++) tests.add(i)
      i--
    }
  }
  return { lines, normal, tests }
}

const testOnlySource = (source: RustSource): boolean =>
  source.tests.size > 0 &&
  source.lines.every((line, i) => source.tests.has(i) || (source.normal[i] && /^\s*(?:\/\/.*)?$/.test(line)))

const changedLines = (patch: string, side: "old" | "new"): number[] =>
  [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].flatMap((hunk) => {
    const offset = side === "old" ? 1 : 3
    const start = Number(hunk[offset]) - 1
    const count = Number(hunk[offset + 1] ?? 1)
    return Array.from({ length: count }, (_, i) => start + i)
  })

const wiredModule = (file: string, line: string, addedTests: Set<string>): boolean => {
  const name = /^mod ([A-Za-z_][A-Za-z0-9_]*);$/.exec(line)?.[1]
  if (!name) return false
  const directory = /^(lib|main|mod)\.rs$/.test(path.posix.basename(file))
    ? path.posix.dirname(file)
    : file.slice(0, -3)
  return addedTests.has(path.posix.join(directory, `${name}.rs`))
}

const rustLines = (file: string, source: RustSource, indices: number[], addedTests: Set<string>): Change => {
  let kind: ChangeKind = "neutral"
  for (const i of indices) {
    const line = source.lines[i]!
    if (source.normal[i] && !line.trim()) continue
    if (!source.tests.has(i) && !(source.normal[i] && wiredModule(file, line, addedTests)))
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
