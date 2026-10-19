import { createHash } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import path from "node:path"

// Git's source inventory includes untracked additions, but excludes generated caches.
// Refuse symlinks rather than silently omit mutable sources outside this checkout.
export function captureSourceIdentity(root: string) {
  const digest = () => {
    const result = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root })
    if (result.exitCode !== 0) throw Error(`Cannot inventory source: ${result.stderr}`)
    const names = [
      ...new Set(
        result.stdout
          .toString()
          .split("\0")
          .filter((name) => name !== "" && name !== "test-performance.json"),
      ),
    ].sort()
    const hash = createHash("sha256")
    const entries = new Map<string, string>()
    for (const name of names) {
      if (path.isAbsolute(name) || name.split("/").includes("..")) throw Error(`Unsafe source path: ${name}`)
      hash.update(JSON.stringify(name) + "\n")
      const parts = name.split("/")
      let missing = false
      for (let length = 1; length <= parts.length; length++) {
        const entry = path.join(root, ...parts.slice(0, length))
        const stat = lstatSync(entry, { throwIfNoEntry: false })
        if (!stat) {
          missing = true
          break
        }
        if (stat.isSymbolicLink()) throw Error(`Source contains symbolic link: ${name}`)
        if (length === parts.length) {
          if (!stat.isFile()) throw Error(`Unsupported source entry: ${name}`)
          const content = readFileSync(entry)
          hash.update(`${stat.mode & 0o7777}:${content.length}:`)
          hash.update(content)
          entries.set(name, `${stat.mode & 0o7777}:${createHash("sha256").update(content).digest("hex")}`)
        }
      }
      if (missing) {
        hash.update("missing")
        entries.set(name, "missing")
      }
      hash.update("\0")
    }
    return { sha256: hash.digest("hex"), entries }
  }
  const original = digest()
  const { sha256 } = original
  return {
    sha256,
    scope:
      "Git tracked and nonignored untracked inputs, including modes and deletions; symbolic links refused; test-performance.json evidence output, installed dependencies and ignored outputs excluded",
    assertUnchanged() {
      const current = digest()
      if (current.sha256 !== sha256) {
        const changed = [...new Set([...original.entries.keys(), ...current.entries.keys()])]
          .filter((name) => original.entries.get(name) !== current.entries.get(name)).sort()
        throw Error(`Source changed during Cartesian execution; results are invalid: ${changed.join(", ")}`)
      }
    },
  }
}
