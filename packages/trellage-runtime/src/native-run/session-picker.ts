import { closeSync, openSync, readSync, writeSync } from "node:fs"
import { createReadStream } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { ReadStream as TtyReadStream } from "node:tty"
import { NativeRunError } from "./paths.ts"

export interface CopilotSession {
  readonly id: string
  readonly cwd: string
  readonly timestamp: string
  readonly firstUserMessage: string
}

export type SessionSelection =
  | { readonly kind: "selected"; readonly index: number }
  | { readonly kind: "cancelled" }
  | { readonly kind: "invalid" }

const yamlScalar = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === "string") return parsed
    } catch {
      return trimmed
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'")
  return trimmed
}

interface WorkspaceMetadata {
  readonly cwd: string | undefined
  readonly createdAt: string | undefined
  readonly updatedAt: string | undefined
}

const workspaceMetadata = (text: string): WorkspaceMetadata => {
  let cwd: string | undefined
  let createdAt: string | undefined
  let updatedAt: string | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("cwd:")) cwd = yamlScalar(line.slice("cwd:".length))
    else if (line.startsWith("created_at:")) createdAt = yamlScalar(line.slice("created_at:".length))
    else if (line.startsWith("updated_at:")) updatedAt = yamlScalar(line.slice("updated_at:".length))
  }
  return { cwd, createdAt, updatedAt }
}

const firstUserMessage = async (file: string): Promise<string | undefined> => {
  const input = createReadStream(file, { encoding: "utf8" })
  const lines = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of lines) {
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (!event || typeof event !== "object" || !("type" in event) || event.type !== "user.message") continue
      if (!("data" in event) || !event.data || typeof event.data !== "object" || !("content" in event.data)) continue
      if (typeof event.data.content !== "string") continue
      const message = event.data.content.replace(/\s+/g, " ").trim()
      if (message) return message
    }
    return undefined
  } finally {
    lines.close()
    input.destroy()
  }
}

const readCopilotSession = async (directory: string, id: string): Promise<CopilotSession | undefined> => {
  try {
    const metadata = workspaceMetadata(await readFile(path.join(directory, "workspace.yaml"), "utf8"))
    const timestamp = metadata.updatedAt ?? metadata.createdAt
    if (!metadata.cwd || !timestamp || !Number.isFinite(Date.parse(timestamp))) return undefined
    const message = await firstUserMessage(path.join(directory, "events.jsonl"))
    if (!message) return undefined
    return { id, cwd: path.resolve(metadata.cwd), timestamp, firstUserMessage: message }
  } catch {
    return undefined
  }
}

export const listCopilotSessions = async (
  ownerHome: string,
  workspace: string,
): Promise<ReadonlyArray<CopilotSession>> => {
  const stateRoot = path.join(ownerHome, "state", "session-state")
  const entries = await readdir(stateRoot, { withFileTypes: true }).catch(() => [])
  const wantedCwd = path.resolve(workspace)
  const sessions: CopilotSession[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const session = await readCopilotSession(path.join(stateRoot, entry.name), entry.name)
    if (session?.cwd === wantedCwd) sessions.push(session)
  }
  return sessions.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
}

export const parseSessionSelection = (input: string, sessionCount: number): SessionSelection => {
  if (input === "" || input === "q" || input === "Q" || input === "\u001b" || input === "\u0003")
    return { kind: "cancelled" }
  if (!/^\d+$/.test(input)) return { kind: "invalid" }
  const index = Number(input) - 1
  return Number.isSafeInteger(index) && index >= 0 && index < sessionCount
    ? { kind: "selected", index }
    : { kind: "invalid" }
}

const sessionLine = (session: CopilotSession, index: number): string => {
  const message = session.firstUserMessage.length > 120
    ? `${session.firstUserMessage.slice(0, 119)}…`
    : session.firstUserMessage
  return `  ${index + 1}) ${session.timestamp}  ${message}\n      ${session.cwd}\n`
}

const promptOnTty = (sessions: ReadonlyArray<CopilotSession>): number | undefined => {
  let inputFd: number | undefined
  let outputFd: number | undefined
  let input: TtyReadStream | undefined
  try {
    inputFd = openSync("/dev/tty", "r")
    outputFd = openSync("/dev/tty", "w")
    input = new TtyReadStream(inputFd)
    if (!input.isTTY) throw new NativeRunError("launch", "--resume requires an interactive terminal")
    input.setRawMode(true)
    let sessionIndex = 0
    for (const session of sessions) {
      writeSync(outputFd, sessionLine(session, sessionIndex))
      sessionIndex += 1
    }
    const prompt = "Select a Copilot session (Enter/q/Esc/Ctrl-C cancels): "
    writeSync(outputFd, prompt)
    let entered = ""
    const byte = Buffer.allocUnsafe(1)
    while (true) {
      if (readSync(inputFd, byte, 0, 1, null) === 0) return undefined
      const key = byte.toString("utf8")
      if (key === "\u001b" || key === "\u0003" || key === "q" || key === "Q") {
        writeSync(outputFd, "\n")
        return undefined
      }
      if (key === "\r" || key === "\n") {
        const selection = parseSessionSelection(entered, sessions.length)
        if (selection.kind === "cancelled") {
          writeSync(outputFd, "\n")
          return undefined
        }
        if (selection.kind === "selected") {
          writeSync(outputFd, "\n")
          return selection.index
        }
        writeSync(outputFd, `\nChoose 1-${sessions.length}, or q to cancel: `)
        entered = ""
        continue
      }
      if (key === "\u007f" || key === "\b") {
        if (entered.length > 0) {
          entered = entered.slice(0, -1)
          writeSync(outputFd, "\b \b")
        }
        continue
      }
      if (/\d/.test(key)) {
        entered += key
        writeSync(outputFd, key)
      }
    }
  } catch (error) {
    if (error instanceof NativeRunError) throw error
    throw new NativeRunError(
      "launch",
      `could not open /dev/tty for --resume: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    input?.setRawMode(false)
    if (inputFd !== undefined) closeSync(inputFd)
    if (outputFd !== undefined) closeSync(outputFd)
  }
}

export const pickCopilotSession = async (ownerHome: string, workspace: string): Promise<string | undefined> => {
  const sessions = await listCopilotSessions(ownerHome, workspace)
  if (sessions.length === 0) {
    process.stderr.write(`No Copilot sessions found for ${path.resolve(workspace)}.\n`)
    return undefined
  }
  const selected = promptOnTty(sessions)
  return selected === undefined ? undefined : sessions[selected]?.id
}
