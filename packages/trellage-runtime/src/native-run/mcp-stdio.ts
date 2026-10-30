import { readFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import type { McpServer } from "../mcp-config.ts"

/** Never interpolate through a shell or write resolved credentials to generated files. */
export const expandMcpEnvironment = (value: string, environment: NodeJS.ProcessEnv, useLaunchAliases = false): string =>
  value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = (useLaunchAliases ? environment[`TRX_MCP_ENV_${name}`] : undefined) ?? environment[name]
    if (!resolved) throw new Error(`missing MCP environment variable ${name}`)
    return resolved
  })

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

export const runMcpStdio = async (specification: string): Promise<number> => {
  const server = JSON.parse(await readFile(specification, "utf8")) as McpServer
  if (server.type !== "stdio") throw new Error("invalid stdio MCP specification")
  const expand = (value: string) => expandMcpEnvironment(value, process.env, true)
  // A separate POSIX process group lets shutdown reach npx grandchildren too. Do not
  // detach the wrapper itself: it remains the harness's direct, supervised child.
  const grouped = process.platform !== "win32"
  const child = spawn(expand(server.command), server.args.map(expand), {
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)])),
    },
    detached: grouped,
    stdio: ["pipe", "inherit", "inherit"],
  })
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    if (!child.pid) return false
    try {
      if (grouped) process.kill(-child.pid, signal)
      else return child.kill(signal)
      return true
    } catch {
      return false
    }
  }
  let stopping: Promise<void> | undefined
  const stop = (signal: NodeJS.Signals = "SIGTERM", grace = 0): Promise<void> => {
    stopping ??= (async () => {
      if (grace) await delay(grace)
      if (!signalGroup(signal)) return
      // Finish before MCP SDKs escalate against the wrapper after two seconds.
      await delay(750)
      signalGroup("SIGKILL")
    })()
    return stopping
  }
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const handlers = signals.map((signal) => {
    const handler = () => {
      void stop(signal)
    }
    process.on(signal, handler)
    return handler
  })
  // Forward protocol bytes unchanged, but retain EOF visibility for servers which
  // do not terminate when stdin closes. A brief grace permits orderly MCP exit.
  const onEnd = () => {
    void stop("SIGTERM", 100)
  }
  const onStdinError = () => {
    void stop()
  }
  process.stdin.once("end", onEnd)
  process.stdin.once("error", onStdinError)
  child.stdin!.on("error", onStdinError)
  process.stdin.pipe(child.stdin!)
  if (process.stdin.readableEnded) onEnd()
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new Error("could not start configured MCP command")))
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)))
    })
  } finally {
    process.stdin.unpipe(child.stdin!)
    process.stdin.pause()
    process.stdin.off("end", onEnd)
    process.stdin.off("error", onStdinError)
    // Even a normally exiting group leader may leave a server descendant behind.
    await stop()
    signals.forEach((signal, index) => process.off(signal, handlers[index]!))
  }
}

if (import.meta.main) {
  try {
    if (!process.argv[2]) throw new Error("missing MCP specification")
    process.exitCode = await runMcpStdio(process.argv[2])
  } catch {
    // Config, spawn errors and command paths can contain credentials. Keep stderr generic.
    console.error("trx MCP: failed to start server; check its command and required environment variables")
    process.exitCode = 1
  }
}
