import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)

const sanitizeHttpsUrl = (candidate: string): URL | undefined => {
  try {
    const url = new URL(candidate.trim())
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      return undefined
    }
    return url
  } catch {
    return undefined
  }
}

export const microsoftProtectedNpmRegistry = "https://packagefeedproxy.microsoft.io/npm/"
export const microsoftProtectedPypiIndex = "https://packagefeedproxy.microsoft.io/pypi/simple/"

export const sanitizeNpmRegistry = (candidate: string): string | undefined => {
  const registry = sanitizeHttpsUrl(candidate)
  if (registry === undefined) return undefined
  if (registry.hostname === "packagefeedproxy.microsoft.io") {
    const pathName = registry.pathname.replace(/\/+$/, "") || "/"
    if (pathName === "/npm" || pathName === "/npm/registry") return microsoftProtectedNpmRegistry
  }
  return registry.toString()
}

export const sanitizePypiIndex = (candidate: string): string | undefined => sanitizeHttpsUrl(candidate)?.toString()

export const pypiIndexFromNpmRegistry = (npmRegistry: string | undefined): string | undefined => {
  if (npmRegistry === undefined) return undefined
  try {
    const registry = new URL(npmRegistry)
    if (registry.hostname !== "packagefeedproxy.microsoft.io") return undefined
    const pathName = registry.pathname.replace(/\/+$/, "") || "/"
    if (pathName !== "/npm" && pathName !== "/npm/registry") return undefined
    return microsoftProtectedPypiIndex
  } catch {
    return undefined
  }
}

const pipConfigIndexUrl = (configList: string): string | undefined => {
  for (const line of configList.split(/\r?\n/)) {
    const match = /^global\.index-url=['"]?([^'"\s]+)['"]?\s*$/.exec(line.trim())
    if (match?.[1] !== undefined) return sanitizePypiIndex(match[1])
  }
  return undefined
}

export type CommandOutputRunner = (command: string, args: ReadonlyArray<string>) => Promise<{ readonly stdout: string }>

export const discoverPypiIndex = async (options?: {
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly npmRegistry?: string
  readonly run?: CommandOutputRunner
}): Promise<string | undefined> => {
  const environment = options?.environment ?? process.env
  for (const key of ["UV_DEFAULT_INDEX", "PIP_INDEX_URL", "UV_INDEX_URL"] as const) {
    const fromEnv = sanitizePypiIndex(environment[key] ?? "")
    if (fromEnv !== undefined) return fromEnv
  }

  const run =
    options?.run ??
    (async (command, args) => {
      const result = await execFilePromise(command, [...args], { encoding: "utf8" })
      return { stdout: result.stdout }
    })

  for (const command of ["pip3", "pip", "python3"] as const) {
    const args = command === "python3" ? ["-m", "pip", "config", "list"] : ["config", "list"]
    try {
      const { stdout } = await run(command, args)
      const fromPip = pipConfigIndexUrl(stdout)
      if (fromPip !== undefined) return fromPip
    } catch {
      // Try the next candidate.
    }
  }

  return pypiIndexFromNpmRegistry(options?.npmRegistry)
}
