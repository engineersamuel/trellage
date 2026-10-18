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
        }
      }
      if (missing) hash.update("missing")
      hash.update("\0")
    }
    return hash.digest("hex")
  }
  const sha256 = digest()
  return {
    sha256,
    scope:
      "Git tracked and nonignored untracked inputs, including modes and deletions; symbolic links refused; test-performance.json evidence output, installed dependencies and ignored outputs excluded",
    assertUnchanged() {
      if (digest() !== sha256) throw Error("Source changed during Cartesian execution; results are invalid")
    },
  }
}
