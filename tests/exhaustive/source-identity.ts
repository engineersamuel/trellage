import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readlinkSync } from "node:fs"
import path from "node:path"

const sourceNames = (root: string, flags: string[]): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z", ...flags], { cwd: root })
  if (result.exitCode !== 0) throw Error(`Cannot inventory source: ${result.stderr}`)
  return result.stdout.toString().split("\0").filter(Boolean)
}

const linkContents = (root: string, name: string, names: string[], tracked: Set<string>): string => {
  const target = readlinkSync(path.join(root, name))
  const relative = path.join(path.dirname(name), target)
  if (
    !tracked.has(name) ||
    path.isAbsolute(target) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    !names.some((entry) => entry === relative || entry.startsWith(`${relative}${path.sep}`))
  )
    throw Error(`Source contains unsupported symbolic link: ${name}`)
  return target
}

const sourceEntry = (root: string, name: string, names: string[], tracked: Set<string>): string => {
  const parts = name.split("/")
  for (let length = 1; length <= parts.length; length++) {
    const entry = path.join(root, ...parts.slice(0, length))
    const stat = lstatSync(entry, { throwIfNoEntry: false })
    if (!stat) return "missing"
    if (stat.isSymbolicLink()) {
      if (length !== parts.length) throw Error(`Source contains symbolic link: ${name}`)
      return `link:${stat.mode & 0o7777}:${linkContents(root, name, names, tracked)}`
    }
    if (length === parts.length) {
      if (!stat.isFile()) throw Error(`Unsupported source entry: ${name}`)
      return `file:${stat.mode & 0o7777}:${createHash("sha256").update(readFileSync(entry)).digest("hex")}`
    }
  }
  throw Error(`Empty source path: ${name}`)
}

// Hash tracked links to inventoried source without following them; refuse all other links.
export function captureSourceIdentity(root: string) {
  const digest = () => {
    const names = [
      ...new Set(
        sourceNames(root, ["--cached", "--others", "--exclude-standard"]).filter(
          (name) => name !== "" && name !== "test-performance.json",
        ),
      ),
    ].sort()
    const tracked = new Set(sourceNames(root, ["--cached"]))
    const hash = createHash("sha256")
    const entries = new Map<string, string>()
    for (const name of names) {
      if (path.isAbsolute(name) || name.split("/").includes("..")) throw Error(`Unsafe source path: ${name}`)
      const identity = sourceEntry(root, name, names, tracked)
      hash.update(JSON.stringify([name, identity]) + "\n")
      entries.set(name, identity)
    }
    return { sha256: hash.digest("hex"), entries }
  }
  const original = digest()
  const { sha256 } = original
  return {
    sha256,
    scope:
      "Git tracked and nonignored untracked inputs, including modes and deletions; tracked repository-local links hashed without traversal, other symbolic links refused; test-performance.json evidence output, installed dependencies and ignored outputs excluded",
    assertUnchanged() {
      const current = digest()
      if (current.sha256 !== sha256) {
        const changed = [...new Set([...original.entries.keys(), ...current.entries.keys()])]
          .filter((name) => original.entries.get(name) !== current.entries.get(name))
          .sort()
        throw Error(`Source changed during Cartesian execution; results are invalid: ${changed.join(", ")}`)
      }
    },
  }
}
