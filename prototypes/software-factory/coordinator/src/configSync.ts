// `sf config sync`: add the shipped config's missing sections and keys to the user's config, commented out, so the
// user sees every option and its default. It only appends: existing lines, values and comments stay as they are.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { defaultsPath, userConfigPath } from "./config.ts"

const HEADER = /^\[([^\]]+)\]\s*$/
/** A key line, set or commented out: `key = 1` or `# key = 1`. */
const KEY = /^\s*(?:#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

type Section = { name: string; lead: string[]; body: string[] }

/**
 * Sections of a TOML file. Comment and blank lines are held until the next line: before a header they are its
 * description (`lead`); before a key they belong to the section. Lines before the first header are skipped.
 */
const sections = (text: string): Section[] => {
  const out: Section[] = []
  let held: string[] = []
  for (const line of text.split("\n")) {
    const h = line.match(HEADER)
    if (h) out.push({ name: h[1]!, lead: held.filter((l) => l.startsWith("#")), body: [] })
    // A commented-out key (`# retries = 1`) is a key of the section, like a set one.
    else if ((line.startsWith("#") && !KEY.test(line)) || !line.trim()) {
      held.push(line)
      continue
    } else out.at(-1)?.body.push(...held, line)
    held = []
  }
  out.at(-1)?.body.push(...held)
  return out.map((x) => ({ ...x, lead: trimBlank(x.lead), body: trimBlank(x.body) }))
}

const trimBlank = (lines: string[]) => {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a]!.trim()) a++
  while (b > a && !lines[b - 1]!.trim()) b--
  return lines.slice(a, b)
}

const keysIn = (lines: string[]) => new Set(lines.flatMap((l) => l.match(KEY)?.[1] ?? []))

/** A key line of the shipped file, commented out (its comment lines stay as they are). */
const commentOut = (line: string) => (KEY.test(line) && !line.trimStart().startsWith("#") ? `# ${line}` : line)

/** The shipped key lines (with the comments just above them) of `names`. */
const keyBlocks = (body: string[], names: Set<string>): string[] => {
  const out: string[] = []
  let notes: string[] = []
  for (const line of body) {
    const k = line.match(KEY)?.[1]
    if (line.trimStart().startsWith("#") && !k) notes.push(line)
    else if (k) {
      if (names.has(k)) out.push(...notes, commentOut(line))
      notes = []
    } else notes = []
  }
  return out
}

export type SyncResult = { text: string; sections: string[]; keys: string[] }

/**
 * The user's config with what the shipped one has and it lacks: whole sections (with their description) at the end,
 * and missing keys at the end of their section. Everything added is commented out, so values do not change.
 */
export const syncConfig = (shipped: string, user: string): SyncResult => {
  const ours = sections(user)
  const byName = new Map(ours.map((s) => [s.name, s]))
  const added: string[] = []
  const addedKeys: string[] = []
  let text = user
  for (const s of sections(shipped)) {
    const mine = byName.get(s.name)
    if (!mine) {
      text = `${text.replace(/\n*$/, "")}\n\n${[...s.lead, `[${s.name}]`, ...s.body.map(commentOut)].join("\n")}\n`
      added.push(s.name)
      continue
    }
    const missing = new Set([...keysIn(s.body)].filter((k) => !keysIn(mine.body).has(k)))
    if (!missing.size) continue
    const block = keyBlocks(s.body, missing)
    // Insert after the section's last line in the user's text: before the next header, or at the end.
    const lines = text.split("\n")
    const at = lines.findIndex((l) => l.match(HEADER)?.[1] === s.name)
    let end = lines.findIndex((l, i) => i > at && HEADER.test(l))
    if (end === -1) end = lines.length
    while (end > at + 1 && (!lines[end - 1]!.trim() || (lines[end - 1]!.startsWith("#") && !KEY.test(lines[end - 1]!))))
      end--
    lines.splice(end, 0, ...block)
    text = lines.join("\n")
    addedKeys.push(...[...missing].map((k) => `${s.name}.${k}`))
  }
  return { text, sections: added, keys: addedKeys }
}

/** Sync the user's config file in place (atomically). `dryRun` only reports. */
export const syncUserConfig = (
  dryRun = false,
  file = userConfigPath(),
  shipped = defaultsPath,
): SyncResult & { file: string } => {
  const user = existsSync(file) ? readFileSync(file, "utf8") : ""
  const r = syncConfig(readFileSync(shipped, "utf8"), user)
  if (!dryRun && r.text !== user) {
    writeFileSync(`${file}.tmp`, r.text)
    renameSync(`${file}.tmp`, file)
  }
  return { ...r, file }
}
