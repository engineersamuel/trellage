// Image files that workers write, served to the UIs. Only images, only under the factory's own folders.
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const ARTIFACTS_DIR = process.env.SF_ARTIFACTS ?? "/tmp/sf-artifacts"
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
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

const PEEK_BYTES = 256 * 1024
const PEEK_ENTRIES = 200

export type Peek =
  | { path: string; kind: "image"; size: number }
  | { path: string; kind: "text"; size: number; text?: string; truncated?: boolean }
  | { path: string; kind: "binary"; size: number }
  | { path: string; kind: "dir"; entries?: string[]; truncated?: boolean }

const isInside = (real: string, roots: string[]) =>
  roots.some((r) => {
    try {
      const root = realpathSync(r)
      return real === root || real.startsWith(root + path.sep)
    } catch {
      return false
    }
  })

/**
 * A quick look at a local path named in a card: what it is and, with `content`, the first 256 kB of a text file or the
 * first 200 names of a folder. Only under `roots` (symlinks resolved); `~/` is the home folder; a `:line[:col]` end is
 * dropped.
 */
export const peekFile = (file: string, roots: string[], content: boolean): Peek | { error: string } => {
  const named = file.replace(/:\d+(:\d+)?$/, "").replace(/^~(?=\/)/, homedir())
  if (!path.isAbsolute(named)) return { error: "not an absolute path" }
  let real: string
  try {
    real = realpathSync(named)
  } catch {
    return { error: "no such file" }
  }
  if (!isInside(real, roots)) return { error: "outside the factory folders" }
  const st = statSync(real)
  if (st.isDirectory()) {
    if (!content) return { path: real, kind: "dir" }
    const names = readdirSync(real, { withFileTypes: true })
      .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
      .sort()
    return { path: real, kind: "dir", entries: names.slice(0, PEEK_ENTRIES), truncated: names.length > PEEK_ENTRIES }
  }
  if (!st.isFile()) return { error: "not a file" }
  if (TYPES[path.extname(real).toLowerCase()]) return { path: real, kind: "image", size: st.size }
  const buf = Buffer.alloc(Math.min(st.size, PEEK_BYTES))
  const fd = openSync(real, "r")
  try {
    readSync(fd, buf, 0, buf.length, 0)
  } finally {
    closeSync(fd)
  }
  if (buf.includes(0)) return { path: real, kind: "binary", size: st.size }
  return content
    ? { path: real, kind: "text", size: st.size, text: buf.toString("utf8"), truncated: st.size > PEEK_BYTES }
    : { path: real, kind: "text", size: st.size }
}
