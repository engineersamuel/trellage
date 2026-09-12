import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const configuration = fileURLToPath(new URL("../bunfig.toml", import.meta.url))
const baseline = "1.3.3"

export function sourceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
}

export function sourceWorkspaceRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url))
}

export function bunExecutable(): string {
  if (process.versions.bun !== undefined) {
    if (process.versions.bun !== baseline) {
      throw new Error(`Trellage requires Bun ${baseline}; found ${process.versions.bun}`)
    }
    return realpathSync(process.execPath)
  }
  const candidate = process.env.TRELLAGE_BUN_EXECUTABLE
  if (candidate === undefined || !path.isAbsolute(candidate)) {
    throw new Error(`Trellage requires Bun ${baseline}; set TRELLAGE_BUN_EXECUTABLE to its absolute path`)
  }
  accessSync(candidate, constants.X_OK)
  const executable = realpathSync(candidate)
  const result = spawnSync(
    executable,
    [
      "--no-install",
      "--no-env-file",
      `--config=${configuration}`,
      fileURLToPath(new URL("./bun-version.ts", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 5000, env: sourceEnvironment(process.env) },
  )
  if (result.error !== undefined || result.status !== 0 || result.stdout !== baseline) {
    throw new Error(`TRELLAGE_BUN_EXECUTABLE is not Bun ${baseline}: ${candidate}`)
  }
  return executable
}

export function bunArguments(entrypoint: string | URL, args: readonly string[] = []): string[] {
  const script = entrypoint instanceof URL ? fileURLToPath(entrypoint) : entrypoint
  if (!path.isAbsolute(script)) {
    throw new Error(`Bun entrypoint must be absolute: ${script}`)
  }
  const configStatus = lstatSync(configuration)
  if (!configStatus.isFile() || configStatus.isSymbolicLink()) {
    throw new Error(`Unsafe Trellage Bun configuration: ${configuration}`)
  }
  return ["--no-install", "--no-env-file", `--config=${configuration}`, script, "--", ...args]
}

export function runShellBridge(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
  bunExecutable()
  const child = spawn(command, [...args], { stdio: "inherit", env: sourceEnvironment(env) })
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const handlers = signals.map((signal) => {
    const handler = () => {
      child.kill(signal)
    }
    process.on(signal, handler)
    return { signal, handler }
  })
  const removeHandlers = () => {
    for (const { signal, handler } of handlers) process.off(signal, handler)
  }
  child.once("error", (error) => {
    removeHandlers()
    process.stderr.write(`${path.basename(command)}: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once("exit", (code, signal) => {
    removeHandlers()
    if (signal !== null) {
      process.kill(process.pid, signal)
    } else {
      process.exitCode = code ?? 1
    }
  })
}
