import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { CompositionPlan } from "./compose.ts"
import { buildNodecodeSnapshot } from "./nodecode-snapshot.ts"

const cells = ["trellage-knowledge", "nodecode-trellage-manual"] as const
const begin = "<!-- BEGIN TRELLAGE NODECODE SKILLS -->"
const end = "<!-- END TRELLAGE NODECODE SKILLS -->"
interface Receipt {
  schema: 1
  snapshot: string
  block: string
}
interface State {
  agents: string | null
  links: (string | null)[]
  receipt: string | null
}
interface Journal {
  schema: 1
  before: State
  after: State
}

const status = async (file: string) =>
  lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
const regularText = async (file: string): Promise<string | null> => {
  const info = await status(file)
  if (!info) return null
  if (!info.isFile() || info.nlink !== 1) throw new Error(`Refusing non-regular managed file: ${file}`)
  return readFile(file, "utf8")
}
const linkTarget = async (file: string): Promise<string | null> => {
  const info = await status(file)
  if (!info) return null
  if (!info.isSymbolicLink()) throw new Error(`Refusing unowned Nodecode cell: ${file}`)
  return readlink(file)
}
const realDirectory = async (directory: string) => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Refusing symlink directory: ${directory}`)
}
const atomicText = async (file: string, text: string | null) => {
  if (text === null) {
    await rm(file, { force: true })
    return
  }
  const temporary = `${file}.trx-${randomUUID()}`
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
const atomicLink = async (file: string, target: string | null) => {
  if (target === null) {
    await rm(file, { force: true })
    return
  }
  const temporary = `${file}.trx-${randomUUID()}`
  try {
    await symlink(target, temporary)
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
const parseReceipt = (text: string | null, root: string): Receipt | undefined => {
  if (text === null) return undefined
  const receipt = JSON.parse(text) as Receipt
  if (
    receipt.schema !== 1 ||
    typeof receipt.snapshot !== "string" ||
    typeof receipt.block !== "string" ||
    path.dirname(receipt.snapshot) !== path.join(root, "snapshots") ||
    !/^[a-f0-9]{64}$/.test(path.basename(receipt.snapshot))
  )
    throw new Error("Invalid Nodecode activation receipt")
  return receipt
}
const validState = (state: State, root: string): boolean => {
  if (
    !state ||
    !(state.agents === null || typeof state.agents === "string") ||
    !(state.receipt === null || typeof state.receipt === "string") ||
    !Array.isArray(state.links) ||
    state.links.length !== cells.length
  )
    return false
  const receipt = parseReceipt(state.receipt, root)
  return state.links.every((link, index) => link === (receipt ? path.join(receipt.snapshot, cells[index]!) : null))
}

/** Runs inside the composition's short preparation transaction. Never modifies user learning or session stores.
 * Retain every snapshot: durable conversations can reference old assets beyond any process lease.
 */
export const reconcileNodecodeSkills = async (
  ownerHome: string,
  plan: CompositionPlan,
  options: { afterWrite?: (surface: string) => Promise<void> } = {},
): Promise<void> => {
  ownerHome = await realpath(ownerHome)
  const root = path.join(ownerHome, "managed", "nodecode-skills")
  const home = path.join(ownerHome, "state", "home")
  for (const directory of [
    ownerHome,
    path.join(ownerHome, "managed"),
    root,
    path.join(root, "snapshots"),
    path.join(ownerHome, "state"),
    home,
    path.join(home, "cells"),
  ])
    await realDirectory(directory)
  const agentsFile = path.join(home, "AGENTS.md")
  const receiptFile = path.join(root, "activation.json")
  const journalFile = path.join(root, "activation-journal.json")
  const links = cells.map((cell) => path.join(home, "cells", cell))
  const capture = async (): Promise<State> => ({
    agents: await regularText(agentsFile),
    links: await Promise.all(links.map(linkTarget)),
    receipt: await regularText(receiptFile),
  })
  const apply = async (state: State, probe = false) => {
    await atomicText(agentsFile, state.agents)
    if (probe) await options.afterWrite?.("instructions")
    for (const [index, file] of links.entries()) {
      await atomicLink(file, state.links[index]!)
      if (probe) await options.afterWrite?.(cells[index]!)
    }
    await atomicText(receiptFile, state.receipt)
    if (probe) await options.afterWrite?.("receipt")
  }
  const recover = async (journal: Journal) => {
    if (journal.schema !== 1 || !validState(journal.before, root) || !validState(journal.after, root))
      throw new Error("Invalid Nodecode activation journal; refusing recovery")
    const actual = await capture()
    for (const key of ["agents", "receipt"] as const)
      if (actual[key] !== journal.before[key] && actual[key] !== journal.after[key])
        throw new Error(`Nodecode activation recovery conflict: ${key}; preserve edits and repair before retrying`)
    for (const [index, link] of actual.links.entries())
      if (link !== journal.before.links[index] && link !== journal.after.links[index])
        throw new Error(`Nodecode activation recovery conflict: ${cells[index]}`)
    await apply(journal.before)
    await rm(journalFile)
  }
  const pending = await regularText(journalFile)
  if (pending !== null) await recover(JSON.parse(pending) as Journal)
  const before = await capture()
  const previous = parseReceipt(before.receipt, root)
  if (!validState(before, root))
    throw new Error("Nodecode managed cell ownership conflict; refusing to replace user cells")
  let userRules = before.agents ?? ""
  if (previous?.block) {
    if (userRules.split(previous.block).length !== 2)
      throw new Error("Nodecode managed instruction block was edited; preserve edits and repair before retrying")
    userRules = userRules.replace(previous.block, "")
  }
  if (userRules.includes(begin) || userRules.includes(end)) throw new Error("Unowned Nodecode instruction markers")
  const snapshot = await buildNodecodeSnapshot(ownerHome, plan)
  const instructions = (await readFile(path.join(snapshot.directory, "instructions.md"), "utf8")).trim()
  const policy = plan.skills.length
    ? "Trellage selected skills are available as native knowledge. Manual-only skills are excluded from discovery; use /trx-skill SKILL PROMPT only when explicitly requested. This is not a host-access authorization boundary. After changing selections, use /index reload in an existing conversation (or start a new one); retained conversation and learned content are not erased."
    : ""
  const managed = [instructions, policy].filter(Boolean).join("\n\n")
  const block = managed ? `\n\n${begin}\n${managed}\n${end}\n` : ""
  const agents = userRules + block
  // Native operator-rules rejects the entire file above 65,536 characters; don't silently drop user rules.
  if (Array.from(agents).length > 65_536)
    throw new Error("Nodecode home AGENTS.md would exceed the 65,536-character native limit")
  const receipt: Receipt = { schema: 1, snapshot: snapshot.directory, block }
  const after: State = {
    agents: agents || (before.agents === null ? null : ""),
    links: cells.map((cell) => path.join(snapshot.directory, cell)),
    receipt: `${JSON.stringify(receipt, null, 2)}\n`,
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return
  const journal: Journal = { schema: 1, before, after }
  await atomicText(journalFile, `${JSON.stringify(journal, null, 2)}\n`)
  try {
    await apply(after, true)
    await rm(journalFile)
  } catch (error) {
    await recover(journal)
    throw error
  }
}
