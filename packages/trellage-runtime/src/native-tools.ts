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

if (import.meta.main) {
  const [action, candidate, ...rest] = process.argv.slice(2)
  try {
    if (candidate === undefined || !path.isAbsolute(candidate) || rest.length !== 0) {
      throw new Error("usage: native-tools.ts tree-hash|realpath|socket-listening ABSOLUTE_PATH")
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
      default:
        throw new Error(`unknown native runtime operation: ${action ?? ""}`)
    }
  } catch (error) {
    process.stderr.write(`trellage native runtime: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
