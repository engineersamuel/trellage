import { constants } from "node:fs"
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { primeRuntimePaths } from "./prime-runtime.ts"

export const nativeBinaryNames: Readonly<Record<string, string>> = {
  agency: "agency",
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
  fx: "fx",
  headlong: "ada",
  jcode: "jcode",
  omp: "omp",
  pi: "pi",
  prime: "prime-agent",
  grok: "grok",
  uji: "uji",
}

export const resolveNativeBinary = (environment: NodeJS.ProcessEnv, variable: string, fallback: string): string =>
  environment[variable] && path.isAbsolute(environment[variable]!) ? environment[variable]! : fallback

export const executableOnPath = async (
  command: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> => {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (environment.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, command))
  for (const candidate of candidates) {
    try {
      const file = await realpath(candidate)
      if (!(await lstat(file)).isFile()) continue
      await access(file, constants.X_OK)
      return file
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    }
  }
  return undefined
}

const managedJcodeVersion = async (runtime: string): Promise<string | undefined> => {
  for (const name of ["installed-version", "version"]) {
    try {
      const file = path.join(runtime, name),
        info = await lstat(file)
      if (!info.isFile() || info.size > 128) return undefined
      const version = (await readFile(file, "utf8")).trim()
      return /^\d+\.\d+\.\d+$/u.test(version) ? version : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
  }
  return undefined
}

const managedJcodeBinaries = async (
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyArray<string>> => {
  const names = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const binaries: string[] = []
  for (const candidateName of names.filter((name) => name === "jcode" || name.startsWith("jcode-"))) {
    const candidate = path.join(directory, candidateName)
    if ((await lstat(candidate)).isFile() && (await executableOnPath(candidate, environment))) binaries.push(candidate)
  }
  return binaries
}

/** The JCode manager chooses exactly one binary under its pinned receipt, not an arbitrary PATH copy. */
export const managedJcodeBinary = async (environment: NodeJS.ProcessEnv): Promise<string | undefined> => {
  const runtime = path.join(environment.HOME ?? "", ".local/share/trellage/jcx")
  const version = await managedJcodeVersion(runtime)
  if (!version) return undefined
  const directory = path.join(runtime, "mise/installs/github-1jehuang-jcode", version)
  const binaries = await managedJcodeBinaries(directory, environment)
  return binaries.length === 1 ? binaries[0] : undefined
}

export const harnessBinaryAvailable = async (harness: string, environment: NodeJS.ProcessEnv): Promise<boolean> => {
  const name = nativeBinaryNames[harness]
  if (!name) return false
  const override = environment[`TRELLAGE_${harness.toUpperCase()}_BIN`]
  if (harness === "jcode" && !(override && path.isAbsolute(override)))
    return (await managedJcodeBinary(environment)) !== undefined
  if (harness === "prime") {
    const paths = primeRuntimePaths({ environment })
    const cli = path.join(paths.rustPrefix, "bin", "prime-agent")
    const info = await lstat(cli).catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    return info?.isFile() === true
  }
  return !!(await executableOnPath(
    resolveNativeBinary(environment, `TRELLAGE_${harness.toUpperCase()}_BIN`, name),
    environment,
  ))
}
