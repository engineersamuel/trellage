import { createHash } from "node:crypto"
import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { Socket } from "node:net"
import path from "node:path"

export function runtimeTreeHash(root: string): string {
  const hash = createHash("sha256")
  const walk = (directory: string, relative = ""): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      Buffer.from(a.name).compare(Buffer.from(b.name)),
    )
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const child = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`symlink in bundled runtime: ${childRelative}`)
      if (entry.isDirectory()) {
        hash.update(`D\0${Buffer.byteLength(childRelative)}\0${childRelative}\0`)
        walk(child, childRelative)
      } else if (entry.isFile()) {
        const content = readFileSync(child)
        hash.update(`F\0${Buffer.byteLength(childRelative)}\0${childRelative}\0${content.length}\0`)
        hash.update(content).update("\0")
      } else {
        throw new Error(`unsupported entry in bundled runtime: ${childRelative}`)
      }
    }
  }
  walk(root)
  return hash.digest("hex")
}

export function socketIsListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    const finish = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(250)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("timeout", () => finish(false))
    socket.connect(socketPath)
  })
}

const DAEMON_PROTOCOL = { name: "prime-agent.daemon", version: 7 } as const
const DAEMON_REQUEST_TIMEOUT_MS = 5_000

/** Sends one protocol-7 command over a fresh connection; resolves true when the daemon reports success. */
const daemonCommand = (socketPath: string, command: Record<string, unknown>): Promise<boolean> =>
  new Promise((resolve) => {
    const id = `trellage-${command.type}`
    const socket = new Socket()
    let buffer = ""
    let sent = false
    const finish = (value: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), DAEMON_REQUEST_TIMEOUT_MS)
    socket.setEncoding("utf8")
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
    socket.on("data", (chunk: string) => {
      buffer += chunk
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let message: { type?: string; id?: string; success?: boolean }
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === "daemon_hello" && !sent) {
          sent = true
          socket.write(
            `${JSON.stringify({ type: "command", id, protocol: DAEMON_PROTOCOL, clientId: "trellage", command: { ...command, id } })}\n`,
          )
        } else if (message.type === "response" && message.id === id) finish(message.success === true)
      }
    })
    socket.connect(socketPath)
  })

const waitForSocketDown = async (socketPath: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await socketIsListening(socketPath))) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !(await socketIsListening(socketPath))
}

/** Stops the Prime daemon on one socket: a graceful request first, then a forced one. */
export async function shutdownDaemon(socketPath: string, timeoutMs: number): Promise<boolean> {
  if (!(await socketIsListening(socketPath))) return true
  const grace = Math.min(5_000, timeoutMs)
  await daemonCommand(socketPath, { type: "shutdown", force: false })
  if (await waitForSocketDown(socketPath, grace)) return true
  await daemonCommand(socketPath, { type: "shutdown", force: true })
  return waitForSocketDown(socketPath, Math.max(0, timeoutMs - grace))
}

if (import.meta.main) {
  const [action, candidate, ...rest] = process.argv.slice(2)
  try {
    if (candidate === undefined || !path.isAbsolute(candidate) || rest.length !== 0) {
      throw new Error("usage: native-tools.ts tree-hash|realpath|socket-listening|daemon-shutdown ABSOLUTE_PATH")
    }
    switch (action) {
      case "tree-hash":
        process.stdout.write(`${runtimeTreeHash(candidate)}\n`)
        break
      case "realpath":
        process.stdout.write(realpathSync(candidate))
        break
      case "socket-listening":
        process.exitCode = (await socketIsListening(candidate)) ? 0 : 1
        break
      case "daemon-shutdown":
        process.exitCode = (await shutdownDaemon(candidate, 15_000)) ? 0 : 2
        break
      default:
        throw new Error(`unknown native runtime operation: ${action ?? ""}`)
    }
  } catch (error) {
    process.stderr.write(`trellage native runtime: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
