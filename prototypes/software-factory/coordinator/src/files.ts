// Image files that workers write, served to the UIs. Only images, only under the factory's own folders.
import { realpathSync, statSync } from "node:fs"
import path from "node:path"

export const ARTIFACTS_DIR = process.env.SF_ARTIFACTS ?? "/tmp/sf-artifacts"
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }
const MAX_BYTES = 20 * 1024 * 1024

/** The file's real path and content type when it is an image under one of `roots` (symlinks resolved); else why not. */
export const servableImage = (file: string, roots: string[]): { path: string; type: string } | { error: string } => {
  const type = TYPES[path.extname(file).toLowerCase()]
  if (!type) return { error: "not an image file" }
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    return { error: "no such file" }
  }
  const inside = roots.some((r) => {
    try {
      const root = realpathSync(r)
      return real === root || real.startsWith(root + path.sep)
    } catch {
      return false
    }
  })
  if (!inside) return { error: "outside the factory folders" }
  const st = statSync(real)
  if (!st.isFile() || st.size > MAX_BYTES) return { error: "not a file or too large" }
  return { path: real, type }
}
