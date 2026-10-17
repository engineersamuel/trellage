import { lstat, readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { userEnvironmentDirectory } from "./jev-decisions.ts"
import { GuideValidationError, text } from "./guide-text.ts"

/** Lowercase kebab-case ritual id. The user file name is `<id>.md`. */
export const ritualIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

export const ritualLimits = {
  files: 64,
  fileBytes: 65_536,
  id: 64,
  title: 80,
  when: 160,
  prompt: 8_000,
} as const

export interface Ritual {
  readonly id: string
  readonly title: string
  readonly when: string
  readonly prompt: string
  readonly source: "shipped" | "user"
}

export interface RitualProblem {
  readonly id: string
  readonly message: string
}

export interface RitualCatalog {
  readonly rituals: ReadonlyArray<Ritual>
  readonly problems: ReadonlyArray<RitualProblem>
}

const progressPagePrompt = [
  "Write one HTML file at .dashboard/index.html for this task. Update that same file after each step.",
  "Do not create a second page.",
  "",
  "Show four blocks:",
  "- Tasks and their status",
  "- What is stuck",
  "- Questions that need me, each with the default action if I do not answer",
  "- The latest output",
  "",
  "Use the real clock for every time. The page opens with a double-click and reloads itself every 10 seconds.",
  "Keep working after you write the page. When you need a decision, add it to the questions and continue with the default.",
].join("\n")

export const shippedRituals: ReadonlyArray<Ritual> = [
  {
    id: "progress-page",
    title: "Progress page",
    when: "A long task or several subagents",
    prompt: progressPagePrompt,
    source: "shipped",
  },
]

export const ritualDirectory = (env: NodeJS.ProcessEnv): string | undefined => {
  const root = userEnvironmentDirectory(env)
  return root === undefined ? undefined : path.join(root, "rituals")
}

const problem = (id: string, message: string): RitualProblem => ({ id, message })

const validationMessage = (cause: unknown): string =>
  cause instanceof GuideValidationError ? cause.message : cause instanceof Error ? cause.message : String(cause)

/** Parse one ritual file. The id comes from the file name, not from the text. */
export const parseRitualFile = (id: string, source: string): Pick<Ritual, "title" | "when" | "prompt"> => {
  if (!ritualIdPattern.test(id) || id.length > ritualLimits.id) {
    throw new GuideValidationError("id", "must be lowercase kebab-case")
  }
  const normalized = source.replace(/^\uFEFF/u, "")
  const lines = normalized.split(/\r?\n/u)
  const titleLine = lines[0]
  const whenLine = lines[1]
  if (titleLine === undefined || !titleLine.startsWith("title: ")) {
    throw new GuideValidationError(id, "line 1 must be 'title: ...'")
  }
  if (whenLine === undefined || !whenLine.startsWith("when: ")) {
    throw new GuideValidationError(id, "line 2 must be 'when: ...'")
  }
  if (lines[2] !== "") throw new GuideValidationError(id, "line 3 must be blank")
  return {
    title: text(titleLine.slice("title: ".length), `${id} title`, ritualLimits.title),
    when: text(whenLine.slice("when: ".length), `${id} when`, ritualLimits.when),
    prompt: text(lines.slice(3).join("\n"), `${id} prompt`, ritualLimits.prompt, { multiline: true, preserve: true }),
  }
}

const fileNamePattern = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/u

const directoryNames = async (directory: string): Promise<string[] | RitualProblem> => {
  try {
    return await readdir(directory)
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? cause.code : undefined
    if (code === "ENOENT") return []
    return problem("rituals", "The ritual directory cannot be read.")
  }
}

const assertRitualFile = async (file: string): Promise<void> => {
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error("must be a regular file")
  }
  if (status.size > ritualLimits.fileBytes) throw new Error("exceeds the file size limit")
}

const readNamedRitual = async (
  directory: string,
  name: string,
): Promise<{ readonly ritual?: Ritual; readonly problem?: RitualProblem }> => {
  const match = fileNamePattern.exec(name)
  if (match === null) return { problem: problem(name, "File name must be lowercase kebab-case and end in .md.") }
  const id = match[1] ?? name
  const file = path.join(directory, name)
  if (path.basename(file) !== name) return { problem: problem(id, "File path escapes the ritual directory.") }
  try {
    await assertRitualFile(file)
    return { ritual: { id, ...parseRitualFile(id, await readFile(file, "utf8")), source: "user" } }
  } catch (cause) {
    return { problem: problem(id, validationMessage(cause)) }
  }
}

const readUserRituals = async (
  directory: string,
): Promise<{ readonly rituals: ReadonlyArray<Ritual>; readonly problems: ReadonlyArray<RitualProblem> }> => {
  const names = await directoryNames(directory)
  if (!Array.isArray(names)) return { rituals: [], problems: [names] }
  const markdown = names.filter((name) => name.endsWith(".md")).sort()
  if (markdown.length > ritualLimits.files) {
    return { rituals: [], problems: [problem("rituals", `Use at most ${ritualLimits.files} ritual files.`)] }
  }
  const rituals: Ritual[] = []
  const problems: RitualProblem[] = []
  for (const name of markdown) {
    const read = await readNamedRitual(directory, name)
    if (read.ritual !== undefined) rituals.push(read.ritual)
    if (read.problem !== undefined) problems.push(read.problem)
  }
  return { rituals, problems }
}

/** Shipped rituals stay available when a user file is missing or invalid. A valid user file replaces the same id. */
export const loadRitualCatalog = async (
  options: { readonly directory?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<RitualCatalog> => {
  const directory = options.directory ?? ritualDirectory(options.env ?? process.env)
  const user = directory === undefined ? { rituals: [], problems: [] } : await readUserRituals(directory)
  const byId = new Map(shippedRituals.map((ritual) => [ritual.id, ritual]))
  const extras: Ritual[] = []
  for (const ritual of user.rituals) {
    if (byId.has(ritual.id)) byId.set(ritual.id, ritual)
    else extras.push(ritual)
  }
  return {
    rituals: [...byId.values(), ...extras],
    problems: user.problems,
  }
}

export const requireRitual = (catalog: RitualCatalog, id: string): Ritual => {
  const found = catalog.rituals.find((ritual) => ritual.id === id)
  if (found !== undefined) return found
  const failed = catalog.problems.find((entry) => entry.id === id)
  throw new Error(failed === undefined ? `No ritual named ${id}.` : `No ritual named ${id}. ${failed.message}`)
}

export const filterRituals = (rituals: ReadonlyArray<Ritual>, query: string): ReadonlyArray<Ritual> => {
  const needle = query.trim().toLocaleLowerCase("en")
  if (needle.length === 0) return rituals
  return rituals.filter((ritual) => `${ritual.title}\n${ritual.when}`.toLocaleLowerCase("en").includes(needle))
}
