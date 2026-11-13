// The factory home file (~/projects/FACTORY.md): how the human's repos relate and the rules that cross them.
// Text before the first `## ` heading applies to every repo; a `## <name>` section applies to the repo folder
// with that name. Paths stay in the Folders registry; build and test commands stay in each repo's AGENTS.md.
// Read at use time, so an edit applies to the next session, Discover call, or worker.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type Home = {
  path: string
  hash: string
  text: string
  shared: string
  repos: Map<string, string>
}

export const homeFile = (env = process.env): string =>
  env.SF_HOME_FILE ?? path.join(homedir(), "projects", "FACTORY.md")

export const parseHome = (file: string, text: string): Home => {
  const [shared = "", ...parts] = text.split(/^## /m)
  const repos = new Map<string, string>()
  for (const part of parts) {
    const nl = part.indexOf("\n")
    const name = (nl < 0 ? part : part.slice(0, nl)).trim().toLowerCase()
    repos.set(name, nl < 0 ? "" : part.slice(nl + 1).trim())
  }
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 12)
  return { path: file, hash, text: text.trim(), shared: shared.trim(), repos }
}

export const readHome = (env = process.env): Home | null => {
  const file = homeFile(env)
  return existsSync(file) ? parseHome(file, readFileSync(file, "utf8")) : null
}

/** The whole file, for the desk and General chats that pick the repo. */
export const homeAll = (h: Home | null): string =>
  h ? `<factory-home path="${h.path}" hash="${h.hash}">\n${h.text}\n</factory-home>` : ""

/** Shared rules plus one repo's section, for agents that work in that repo. Empty when there is nothing. */
export const homeFor = (h: Home | null, repo: string): string => {
  if (!h) return ""
  const own = h.repos.get(repo.toLowerCase()) ?? ""
  const body = [h.shared, own && `## ${repo}\n${own}`].filter(Boolean).join("\n\n")
  return body ? `<factory-home path="${h.path}" hash="${h.hash}" repo="${repo}">\n${body}\n</factory-home>` : ""
}

/** Sections no folder matches, and folders with no section. A section only reaches a repo whose folder name matches. */
export const homeMismatch = (h: Home | null, folders: string[]): { sections: string[]; folders: string[] } => {
  if (!h) return { sections: [], folders: [] }
  const names = new Set(folders.map((f) => f.toLowerCase()))
  return {
    sections: [...h.repos.keys()].filter((s) => !names.has(s)),
    folders: folders.filter((f) => !h.repos.has(f.toLowerCase())),
  }
}

/** One warning line, or null when the file and the folders agree. */
export const homeWarning = (h: Home | null, folders: string[]): string | null => {
  const m = homeMismatch(h, folders)
  const parts = [
    m.sections.length && `sections with no factory folder (they reach only the desk): ${m.sections.join(", ")}`,
    m.folders.length && `folders with no section: ${m.folders.join(", ")}`,
  ].filter(Boolean)
  return parts.length ? `${h!.path}: ${parts.join("; ")}` : null
}
