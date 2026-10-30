import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import type { McpServer } from "../mcp-config.ts"
import { nativeMcpSupport } from "./mcp-render.ts"
import { executableOnPath, resolveNativeBinary } from "./requirements.ts"

const inheritedDefaults = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "TZ",
]
type JsonObject = Record<string, unknown>
type StdioCommand = { readonly command: string; readonly args: readonly string[] }
interface Receipt {
  schema: 1
  servers: JsonObject
  addedEnvironment: string[]
  cell?: string
}
interface Journal {
  schema: 1
  beforeConfig: string | null
  afterConfig: string
  beforeReceipt: string | null
  afterReceipt: string
}
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
const error = (reason: string): Error => new Error(`Nodecode MCP: ${reason}`)
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const status = (file: string) =>
  lstat(file).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined
    throw error("cannot inspect managed state")
  })
const regularText = async (file: string): Promise<string | null> => {
  const info = await status(file)
  if (!info) return null
  if (!info.isFile() || info.nlink !== 1) throw error("refusing non-regular managed file")
  return readFile(file, "utf8")
}
const directory = async (file: string): Promise<void> => {
  await mkdir(file, { recursive: true, mode: 0o700 })
  if (!(await lstat(file)).isDirectory()) throw error("refusing symlink managed directory")
}
const atomic = async (file: string, text: string | null): Promise<void> => {
  if (text === null) {
    await rm(file, { force: true })
    return
  }
  const temporary = `${file}.trx-${randomUUID()}`
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
const parseConfig = (text: string | null): JsonObject => {
  try {
    const value: unknown = Bun.JSONC.parse(text ?? "{}")
    if (!object(value)) throw error("invalid configuration")
    return value
  } catch {
    throw error("invalid configuration")
  }
}

/** Lex JSONC only far enough to locate a top-level member's value; untouched bytes remain exact. */
const tokens = (text: string): { value: string; start: number; end: number }[] => {
  const result: { value: string; start: number; end: number }[] = []
  for (let at = 0; at < text.length;) {
    const character = text[at]!
    if (/\s/.test(character)) {
      at++
      continue
    }
    if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at)
      at = end < 0 ? text.length : end
      continue
    }
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2)
      if (end < 0) throw error("invalid configuration")
      at = end + 2
      continue
    }
    const start = at++
    if (character === '"') {
      while (at < text.length) {
        if (text[at] === "\\") {
          at += 2
          continue
        }
        if (text[at++] === '"') break
      }
    } else if (!"{}[]:,".includes(character)) {
      while (
        at < text.length &&
        !/[\s{}[\]:,]/.test(text[at]!) &&
        !text.startsWith("//", at) &&
        !text.startsWith("/*", at)
      )
        at++
    }
    result.push({ value: text.slice(start, at), start, end: at })
  }
  return result
}
interface Member {
  key: string
  keyStart: number
  valueStart: number
  valueEnd: number
  commaBefore?: number
  commaAfter?: number
}
const members = (text: string): Member[] => {
  const lexical = tokens(text)
  const result: Member[] = []
  let depth = 0
  for (let at = 0; at < lexical.length; at++) {
    const token = lexical[at]!
    if (token.value === "{" || token.value === "[") depth++
    else if (token.value === "}" || token.value === "]") depth--
    else if (depth === 1 && token.value.startsWith('"') && lexical[at + 1]?.value === ":") {
      const key = JSON.parse(token.value) as string
      if (result.some((member) => member.key === key)) throw error("duplicate configuration member")
      const start = lexical[at + 2]
      if (!start) throw error("invalid configuration")
      let end = at + 2
      if (start.value === "{" || start.value === "[") {
        let nesting = 0
        for (; end < lexical.length; end++) {
          const current = lexical[end]!.value
          if (current === "{" || current === "[") nesting++
          else if (current === "}" || current === "]") nesting--
          if (nesting === 0) break
        }
      }
      result.push({
        key,
        keyStart: token.start,
        valueStart: start.start,
        valueEnd: lexical[end]!.end,
        ...(lexical[at - 1]?.value === "," ? { commaBefore: lexical[at - 1]!.start } : {}),
        ...(lexical[end + 1]?.value === "," ? { commaAfter: lexical[end + 1]!.end } : {}),
      })
    }
  }
  return result
}
const setMember = (text: string, key: string, serialized: string | undefined): string => {
  const found = members(text).find((member) => member.key === key)
  if (found) {
    if (serialized !== undefined) return text.slice(0, found.valueStart) + serialized + text.slice(found.valueEnd)
    const start = found.commaAfter === undefined ? (found.commaBefore ?? found.keyStart) : found.keyStart
    const end = found.commaAfter ?? found.valueEnd
    return text.slice(0, start) + text.slice(end)
  }
  if (serialized === undefined) return text
  const lexical = tokens(text)
  const end = lexical.at(-1)
  if (end?.value !== "}") throw error("invalid configuration")
  const previous = lexical.at(-2)?.value
  const comma = previous === "{" || previous === "," ? "" : ","
  return `${text.slice(0, end.start)}${comma}\n${JSON.stringify(key)}: ${serialized}\n${text.slice(end.start)}`
}
/** Keep comments and spelling in every unaffected object, including user-owned MCP servers. */
const patchObject = (text: string, before: JsonObject, after: JsonObject): string => {
  members(text) // Refuse duplicate members even when semantic JSON parsing would hide them.
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) text = setMember(text, key, undefined)
  for (const [key, value] of Object.entries(after)) {
    if (same(before[key], value)) continue
    const found = members(text).find((member) => member.key === key)
    const serialized =
      found && object(before[key]) && object(value)
        ? patchObject(text.slice(found.valueStart, found.valueEnd), before[key], value)
        : JSON.stringify(value, null, 2)
    text = setMember(text, key, serialized)
  }
  return text
}
const patchMcp = (original: string | null, value: JsonObject): string => {
  const text = original ?? "{}\n"
  const config = parseConfig(text)
  return patchObject(text, config, { ...config, mcp: value })
}
const parseReceipt = (text: string | null): Receipt => {
  if (text === null) return { schema: 1, servers: {}, addedEnvironment: [] }
  try {
    const value = JSON.parse(text) as Receipt
    if (
      value.schema !== 1 ||
      !object(value.servers) ||
      !Array.isArray(value.addedEnvironment) ||
      !value.addedEnvironment.every((name) => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
      !(value.cell === undefined || typeof value.cell === "string")
    )
      throw error("invalid ownership receipt")
    return value
  } catch {
    throw error("invalid ownership receipt")
  }
}
const environmentReferences = (server: McpServer): string[] => {
  const values =
    server.type === "stdio"
      ? [server.command, ...server.args, ...Object.values(server.env)]
      : [server.url, ...Object.values(server.headers)]
  return [
    ...new Set(
      values.flatMap((value) => [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!)),
    ),
  ]
}

const findCellSource = async (environment: NodeJS.ProcessEnv): Promise<string> => {
  const binary = await executableOnPath(
    resolveNativeBinary(environment, "TRELLAGE_NODECODE_BIN", "nodecode"),
    environment,
  )
  const current = environment.HOME ? path.join(environment.HOME, ".local", "share", "nodecode", "current") : undefined
  if (current && (await status(path.join(current, "src", "cells", "mcp", "nodecode-mcp.asd")))?.isFile()) {
    // Follow Nodecode's own release pointer instead of pinning one native MCP source generation forever.
    const actual = await realpath(current)
    if (!binary || binary.startsWith(actual + path.sep))
      return path.join(await realpath(path.dirname(current)), "current", "src", "cells", "mcp")
  }
  if (binary) {
    const candidate = path.join(path.dirname(binary), "src", "cells", "mcp")
    if ((await status(path.join(candidate, "nodecode-mcp.asd")))?.isFile()) return realpath(candidate)
  }
  throw error("installed MCP cell unavailable")
}
const cellRegistration = async (
  home: string,
  environment: NodeJS.ProcessEnv,
  previous: Receipt,
): Promise<string | undefined> => {
  const cells = path.join(home, "cells")
  await directory(cells)
  for (const entry of await readdir(cells)) {
    if ((await status(path.join(cells, entry, "nodecode-mcp.asd")))?.isFile()) {
      // Reuse operator-installed cells without adopting them or registering the same system twice.
      return entry === "nodecode-mcp" ? previous.cell : undefined
    }
  }
  const link = path.join(cells, "nodecode-mcp")
  if (await status(link)) throw error("unowned MCP cell collision")
  return findCellSource(environment)
}

/** Caller serializes shared configuration preparation, never the gateway or session lifetime. */
export const prepareNodecodeMcp = async (
  ownerHome: string,
  servers: Readonly<Record<string, McpServer>>,
  stdio: Readonly<Record<string, StdioCommand>>,
  environment: NodeJS.ProcessEnv,
): Promise<{ cleanup: () => Promise<void> }> => {
  // Fail before touching shared state if a caller bypasses common selection.
  for (const server of Object.values(servers)) {
    const unsupported = server.enabled ? nativeMcpSupport("nodecode", server) : undefined
    if (unsupported) throw error(unsupported)
  }
  ownerHome = await realpath(ownerHome)
  const home = path.join(ownerHome, "state", "home")
  const root = path.join(ownerHome, "managed", "nodecode-mcp")
  for (const entry of [path.join(ownerHome, "state"), home, path.join(ownerHome, "managed"), root])
    await directory(entry)
  const configPath = path.join(home, "config.jsonc")
  const receiptPath = path.join(root, "ownership.json")
  const journalPath = path.join(root, "journal.json")
  const journalText = await regularText(journalPath)
  if (journalText !== null) {
    let journal: Journal
    try {
      journal = JSON.parse(journalText) as Journal
    } catch {
      throw error("invalid recovery journal")
    }
    if (
      journal.schema !== 1 ||
      !(journal.beforeConfig === null || typeof journal.beforeConfig === "string") ||
      !(journal.beforeReceipt === null || typeof journal.beforeReceipt === "string") ||
      typeof journal.afterConfig !== "string" ||
      typeof journal.afterReceipt !== "string"
    )
      throw error("invalid recovery journal")
    parseConfig(journal.beforeConfig)
    parseConfig(journal.afterConfig)
    parseReceipt(journal.beforeReceipt)
    parseReceipt(journal.afterReceipt)
    const configNow = await regularText(configPath)
    const receiptNow = await regularText(receiptPath)
    if (
      ![journal.beforeConfig, journal.afterConfig].includes(configNow) ||
      ![journal.beforeReceipt, journal.afterReceipt].includes(receiptNow)
    )
      throw error("recovery conflict; managed state changed")
    await atomic(configPath, journal.beforeConfig)
    await atomic(receiptPath, journal.beforeReceipt)
    await rm(journalPath)
  }
  const beforeConfig = await regularText(configPath)
  const beforeReceipt = await regularText(receiptPath)
  const previous = parseReceipt(beforeReceipt)
  const selected = Object.entries(servers).filter(([, server]) => server.enabled)
  if (!selected.length && beforeReceipt === null) return { cleanup: async () => {} }
  const config = parseConfig(beforeConfig)
  if (config.mcp !== undefined && !object(config.mcp)) throw error("invalid mcp configuration")
  const mcp = (config.mcp ?? {}) as JsonObject
  if (mcp.servers !== undefined && !object(mcp.servers)) throw error("invalid mcp server configuration")
  const existing = (mcp.servers ?? {}) as JsonObject
  for (const [name, managed] of Object.entries(previous.servers)) {
    if (Object.hasOwn(existing, name) && !same(existing[name], managed)) throw error("managed MCP server was edited")
  }
  for (const [name] of selected) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw error("invalid MCP server name")
    if (Object.hasOwn(existing, name) && !Object.hasOwn(previous.servers, name))
      throw error("unowned MCP server collision")
  }
  const currentAllowlist = mcp.inherit_env_allowlist ?? inheritedDefaults
  if (!Array.isArray(currentAllowlist) || !currentAllowlist.every((name) => typeof name === "string"))
    throw error("invalid MCP environment allowlist")
  const allowlist = currentAllowlist.filter((name) => !previous.addedEnvironment.includes(name)) as string[]
  const needed = [
    ...new Set(
      selected
        .filter(([, server]) => server.type === "stdio")
        .flatMap(([, server]) => environmentReferences(server).map((variable) => `TRX_MCP_ENV_${variable}`)),
    ),
  ]
  const addedEnvironment = needed.filter((name) => !allowlist.includes(name))
  const cell = selected.length ? await cellRegistration(home, environment, previous) : previous.cell
  const owned: JsonObject = {}
  // No client-scoped resources: native MCP belongs to the surviving shared gateway.
  const cleanup = async () => {}
  const cellPath = path.join(home, "cells", "nodecode-mcp")
  let createdCell = false
  try {
    for (const [name, definition] of selected) {
      // Check all references while launch failures can still be reported without starting native MCP discovery.
      for (const variable of environmentReferences(definition))
        if (!environment[variable]) throw error("required MCP environment variable is missing")
      if (definition.type === "stdio") {
        const command = stdio[name]
        if (!command) throw error("missing stdio MCP wrapper")
        owned[name] = { command: command.command, args: [...command.args] }
      } else if (definition.type === "http") {
        const target = new URL(definition.url)
        if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
          throw error("invalid HTTP target")
        owned[name] = { transport: "http", url: definition.url }
      } else throw error("SSE MCP transport unsupported")
    }
    const nextServers = Object.fromEntries(
      Object.entries(existing).filter(([name]) => !Object.hasOwn(previous.servers, name)),
    )
    Object.assign(nextServers, owned)
    const nextMcp = {
      ...mcp,
      servers: nextServers,
      inherit_env_allowlist: [...new Set([...allowlist, ...addedEnvironment])],
    }
    const receipt: Receipt = { schema: 1, servers: owned, addedEnvironment, ...(cell ? { cell } : {}) }
    const afterConfig = patchMcp(beforeConfig, nextMcp)
    const afterReceipt = `${JSON.stringify(receipt, null, 2)}\n`
    // Record rollback before the two files change. A killed preparer recovers only untouched before/after states.
    await atomic(
      journalPath,
      `${JSON.stringify({ schema: 1, beforeConfig, afterConfig, beforeReceipt, afterReceipt } satisfies Journal)}\n`,
    )
    try {
      await atomic(configPath, afterConfig)
      await atomic(receiptPath, afterReceipt)
      if (cell && selected.length && !(await status(cellPath))) {
        await symlink(cell, cellPath)
        createdCell = true
      }
      await rm(journalPath)
    } catch (cause) {
      await atomic(configPath, beforeConfig)
      await atomic(receiptPath, beforeReceipt)
      if (createdCell) await rm(cellPath, { force: true })
      await rm(journalPath, { force: true })
      throw cause
    }
    return { cleanup }
  } catch {
    await cleanup()
    throw error("could not prepare common MCP servers; check managed configuration and installed MCP support")
  }
}
