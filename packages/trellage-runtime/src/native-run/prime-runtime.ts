import { execFile } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { NativeRunError } from "./paths.ts"

export const PRIME_PROVIDER = "copilot-proxy-rs"
export const PRIME_DEFAULT_MODEL = "claude-opus-5"
export const PRIME_PROFILE_MARKER = "trellage-prime-profile-v1"
export const PRIME_RUNTIME_IDENTITY_SCHEMA = 1
export const PRIME_KERNEL_SPEC_VERSION = 1

const PRIME_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/u
const PRIME_RUNTIME_PACKAGE = "prime-agent"
const PRIME_DAEMON_SCHEMA = 1
const PRIME_DAEMON_TIMEOUT_MS = 10_000

export interface PrimeRuntimePathOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly home?: string | undefined
  readonly runtimeRoot?: string | undefined
  readonly profileRoot?: string | undefined
  readonly nodeBinary?: string | undefined
}
export interface PrimeRuntimePaths {
  readonly home: string
  readonly runtimeRoot: string
  readonly receiptFile: string
  readonly legacyVersionFile: string
  readonly npmPrefix: string
  readonly runtimeIdentityFile: string
  readonly profileRoot: string
  readonly profileHome: string
  readonly profileMarker: string
  readonly kernelVenv: string
  readonly kernelPython: string
  readonly kernelIdentityStamp: string
  readonly daemonDir: string
  readonly daemonSocket: string
  readonly daemonEnvStamp: string
}

export interface PrimeRuntimeIdentity {
  readonly schemaVersion: 1
  readonly primeVersion: string
  readonly runtimeHashAlgorithm: "sha256"
  readonly runtimeHash: string
  readonly kernelSpecVersion: 1
}

export interface PrimeRuntimeState {
  readonly paths: PrimeRuntimePaths
  readonly nodeBinary: string
  readonly version: string
  readonly cli: string
  readonly identity: PrimeRuntimeIdentity
}

export interface PrimeProcessResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export type PrimeProcessRunner = (
  command: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) => Promise<PrimeProcessResult>

export interface PrimeRuntimeDependencies {
  /** Set false only for a dry test fixture that does not contain a runnable CLI. */
  readonly verifyCliVersion?: boolean
  readonly run?: PrimeProcessRunner
  readonly daemonIsListening?: (socket: string) => Promise<boolean>
  /** Stop only the profile-local Prime daemon. This never invokes a Trellage launcher. */
  readonly stopDaemon?: (socket: string, daemonLaunchModule: string) => Promise<boolean>
}

export interface PrimeLaunchOptions {
  readonly model?: string | undefined
  readonly forwardedArgs?: ReadonlyArray<string>
  readonly appendSystemPrompt?: string | undefined
  readonly singleTurn?: boolean
  readonly autonomous?: boolean
  readonly codingAgentDirectory?: string | undefined
}

export interface PrimeLaunchCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string | null>>
}

const execFileAsync = promisify(execFile)

const fail = (code: "launch" | "unsafe-path" | "usage", message: string): never => {
  throw new NativeRunError(code, message)
}

const requireAbsolute = (value: string, name: string): string => {
  if (!path.isAbsolute(value)) fail("unsafe-path", `${name} must be an absolute path: ${value}`)
  return path.normalize(value)
}

const isWithin = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const homeFrom = (options: PrimeRuntimePathOptions): string => {
  const environment = options.environment ?? process.env
  const value = options.home ?? environment.HOME ?? os.homedir()
  const home = requireAbsolute(value, "HOME")
  if (home === path.parse(home).root) fail("unsafe-path", `unsafe HOME: ${home}`)
  return home
}

export const primeRuntimePaths = (options: PrimeRuntimePathOptions = {}): PrimeRuntimePaths => {
  const environment = options.environment ?? process.env
  const home = homeFrom(options)
  const runtimeRoot = requireAbsolute(
    options.runtimeRoot ??
      environment.TRELLAGE_PRIME_RUNTIME_ROOT ??
      path.join(home, ".local", "share", "trellage", "prx"),
    "Prime runtime root",
  )
  const profileRoot = requireAbsolute(
    options.profileRoot ?? path.join(home, ".local", "share", "trellage", "profiles", "prime", "default"),
    "Prime profile root",
  )
  if (!isWithin(home, runtimeRoot)) fail("unsafe-path", `Prime runtime root escapes HOME: ${runtimeRoot}`)
  if (!isWithin(home, profileRoot)) fail("unsafe-path", `Prime profile root escapes HOME: ${profileRoot}`)

  const profileHome = path.join(profileRoot, "home")
  const kernelVenv = path.join(profileHome, "kernel-venv")
  const daemonDir = path.join(profileRoot, "daemon")
  return {
    home,
    runtimeRoot,
    receiptFile: path.join(runtimeRoot, "installed-version"),
    legacyVersionFile: path.join(runtimeRoot, "version"),
    npmPrefix: path.join(runtimeRoot, "npm-prefix"),
    runtimeIdentityFile: path.join(runtimeRoot, "runtime-identity.json"),
    profileRoot,
    profileHome,
    profileMarker: path.join(profileRoot, ".managed-by-trellage-prime-profiles"),
    kernelVenv,
    kernelPython: path.join(kernelVenv, "bin", "python"),
    kernelIdentityStamp: path.join(profileHome, "kernel-runtime-identity.json"),
    daemonDir,
    daemonSocket: path.join(daemonDir, "daemon.sock"),
    daemonEnvStamp: path.join(daemonDir, "kernel-env.stamp"),
  }
}
const requireNoSymlinkPath = async (target: string, name: string, directory: boolean): Promise<void> => {
  const segments = target.split(path.sep)
  let current = path.parse(target).root
  for (const segment of segments.slice(1)) {
    if (!segment) continue
    current = path.join(current, segment)
    const status = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!status) break
    if (status.isSymbolicLink()) fail("unsafe-path", `unsafe ${name}: ${current}`)
    if (current !== target && !status.isDirectory())
      fail("unsafe-path", `${name} parent is not a directory: ${current}`)
  }
  const status = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (status && (status.isSymbolicLink() || (directory ? !status.isDirectory() : !status.isFile())))
    fail("unsafe-path", `${name} is not a safe ${directory ? "directory" : "file"}: ${target}`)
}

const readOwnedFile = async (file: string, name: string): Promise<string> => {
  await requireNoSymlinkPath(file, name, false)
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    fail("launch", `${name} is missing or unreadable: ${file} (${detail})`)
  }
  return fail("launch", `${name} is missing or unreadable: ${file}`)
}

const parseVersion = (value: string, source: string): string => {
  const version = value.trim()
  if (!PRIME_VERSION_PATTERN.test(version))
    fail("launch", `invalid Prime Agent version in ${source}: ${version || "<empty>"}`)
  return version
}

const readInstalledVersion = async (paths: PrimeRuntimePaths): Promise<string> => {
  const receipt = await lstat(paths.receiptFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (receipt)
    return parseVersion(await readOwnedFile(paths.receiptFile, "Prime installed version receipt"), paths.receiptFile)

  const legacy = await lstat(paths.legacyVersionFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (legacy)
    return parseVersion(
      await readOwnedFile(paths.legacyVersionFile, "legacy Prime version receipt"),
      paths.legacyVersionFile,
    )
  fail("launch", "Prime Agent installed version receipt is missing; run trx setup prime default")
  return fail("launch", "Prime Agent installed version receipt is missing; run trx setup prime default")
}

const parseIdentity = (value: string, source: string): PrimeRuntimeIdentity => {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    fail(
      "launch",
      `invalid Prime runtime identity ${source}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("launch", `invalid Prime runtime identity: ${source}`)
  const candidate = parsed as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  const expected = ["kernelSpecVersion", "primeVersion", "runtimeHash", "runtimeHashAlgorithm", "schemaVersion"]
  if (JSON.stringify(keys) !== JSON.stringify(expected)) fail("launch", `invalid Prime runtime identity: ${source}`)
  if (
    candidate.schemaVersion !== PRIME_RUNTIME_IDENTITY_SCHEMA ||
    typeof candidate.primeVersion !== "string" ||
    !PRIME_VERSION_PATTERN.test(candidate.primeVersion) ||
    candidate.runtimeHashAlgorithm !== "sha256" ||
    typeof candidate.runtimeHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.runtimeHash) ||
    candidate.kernelSpecVersion !== PRIME_KERNEL_SPEC_VERSION
  )
    fail("launch", `invalid Prime runtime identity: ${source}`)
  return {
    schemaVersion: 1,
    primeVersion: candidate.primeVersion as string,
    runtimeHashAlgorithm: "sha256",
    runtimeHash: candidate.runtimeHash as string,
    kernelSpecVersion: 1,
  }
}

const readIdentity = async (file: string, name: string): Promise<PrimeRuntimeIdentity> =>
  parseIdentity(await readOwnedFile(file, name), file)

const canonicalDirectory = async (directory: string, name: string): Promise<string> => {
  const status = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!status || status.isSymbolicLink() || !status.isDirectory()) fail("unsafe-path", `unsafe ${name}: ${directory}`)
  try {
    return await realpath(directory)
  } catch (error) {
    return fail("unsafe-path", `cannot resolve ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const packageRoot = (paths: PrimeRuntimePaths): string =>
  path.join(paths.npmPrefix, "lib", "node_modules", PRIME_RUNTIME_PACKAGE)

const requirePrimeCli = async (paths: PrimeRuntimePaths, version: string): Promise<string> => {
  await requireNoSymlinkPath(paths.npmPrefix, "Prime npm prefix", true)
  const root = packageRoot(paths)
  await requireNoSymlinkPath(root, "Prime package root", true)
  const packageJson = path.join(root, "package.json")
  const packageText = await readOwnedFile(packageJson, "Prime package metadata")
  let metadata: unknown
  try {
    metadata = JSON.parse(packageText)
  } catch (error) {
    fail("launch", `invalid Prime package metadata: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).name !== PRIME_RUNTIME_PACKAGE ||
    (metadata as Record<string, unknown>).version !== version
  )
    fail("launch", `Prime package version differs from receipt: ${packageJson}`)
  await requireNoSymlinkPath(path.join(root, "node_modules"), "Prime dependencies", true)
  const cli = path.join(root, "dist", "bundle", "cli.js")
  await requireNoSymlinkPath(cli, "Prime CLI", false)
  return cli
}

const defaultRunner: PrimeProcessRunner = async (command, args, environment) => {
  try {
    const result = await execFileAsync(command, [...args], { env: environment, encoding: "utf8" })
    return { status: 0, stdout: String(result.stdout), stderr: String(result.stderr) }
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string }
    return {
      status: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? "",
    }
  }
}

const verifyCliVersion = async (
  state: Omit<PrimeRuntimeState, "cli"> & { readonly cli: string },
  environment: NodeJS.ProcessEnv,
  dependencies: PrimeRuntimeDependencies,
): Promise<void> => {
  if (dependencies.verifyCliVersion === false) return
  const result = await (dependencies.run ?? defaultRunner)(state.nodeBinary, [state.cli, "--version"], environment)
  if (result.status !== 0)
    fail("launch", `could not run Prime Agent ${state.version}: ${result.stderr.trim() || `exit ${result.status}`}`)
  const actual = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.match(/[0-9]+\.[0-9]+\.[0-9]+/u)?.[0]
  if (actual !== state.version)
    fail("launch", `Prime Agent version differs: expected ${state.version}, got ${actual ?? "<empty>"}`)
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (!value || typeof value !== "object") return JSON.stringify(value)
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`
}

const sameJson = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right)

const readKernelIdentity = async (paths: PrimeRuntimePaths): Promise<PrimeRuntimeIdentity> =>
  readIdentity(paths.kernelIdentityStamp, "Prime kernel identity stamp")

const validateKernel = async (paths: PrimeRuntimePaths, identity: PrimeRuntimeIdentity): Promise<void> => {
  await requireNoSymlinkPath(paths.kernelVenv, "Prime kernel venv", true)
  const python = await lstat(paths.kernelPython).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!python || python.isDirectory())
    fail("launch", `Prime kernel python is missing or unsafe; run trx repair prime default: ${paths.kernelPython}`)
  try {
    await access(paths.kernelPython, fsConstants.X_OK)
  } catch {
    fail("launch", `Prime kernel python is not executable; run trx repair prime default: ${paths.kernelPython}`)
  }
  const actual = await readKernelIdentity(paths)
  if (!sameJson(actual, identity)) fail("launch", "Prime kernel identity differs; run trx repair prime default")
}

const daemonStamp = (state: PrimeRuntimeState): Record<string, unknown> => ({
  schemaVersion: PRIME_DAEMON_SCHEMA,
  runtimeIdentity: state.identity,
  kernelPython: state.paths.kernelPython,
  kernelVenv: state.paths.kernelVenv,
})

const readDaemonStamp = async (file: string): Promise<Record<string, unknown> | undefined> => {
  const status = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!status) return undefined
  if (!status.isFile() || status.isSymbolicLink()) fail("unsafe-path", `unsafe Prime daemon identity stamp: ${file}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, "utf8"))
  } catch {
    return undefined
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined
}

const writeDaemonStamp = async (file: string, value: Record<string, unknown>): Promise<void> => {
  await requireNoSymlinkPath(file, "Prime daemon identity stamp", false)
  const temporary = path.join(path.dirname(file), `.kernel-env-${process.pid}-${randomUUID()}.json`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  try {
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

const socketIsListening = async (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.createConnection(socketPath)
    const finish = (value: boolean) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), 500)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })

const daemonLaunchModule = async (state: PrimeRuntimeState): Promise<string> => {
  const candidates = [
    path.join(state.paths.npmPrefix, "lib", "node_modules", PRIME_RUNTIME_PACKAGE, "dist", "cli", "daemon-launch.js"),
    path.join(
      state.paths.home,
      ".local",
      "share",
      "trellage",
      "prx",
      "npm-prefix",
      "lib",
      "node_modules",
      PRIME_RUNTIME_PACKAGE,
      "dist",
      "cli",
      "daemon-launch.js",
    ),
  ]
  for (const candidate of candidates) {
    const status = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (status?.isFile() && !status.isSymbolicLink()) return candidate
  }
  fail("launch", `Prime daemon launch module is missing; run trx repair prime default: ${candidates[0]}`)
  return fail("launch", `Prime daemon launch module is missing; run trx repair prime default: ${candidates[0]}`)
}

const defaultStopDaemon = async (socket: string, launchModule: string): Promise<boolean> => {
  const imported = (await import(pathToFileURL(launchModule).href)) as {
    shutdownDaemonAndWait?: (path: string, timeout: number) => Promise<boolean>
  }
  const stop = imported.shutdownDaemonAndWait
  if (typeof stop !== "function") return fail("launch", `Prime daemon shutdown API is missing: ${launchModule}`)
  return stop(socket, PRIME_DAEMON_TIMEOUT_MS)
}

export const validatePrimeRuntime = async (
  options: PrimeRuntimePathOptions = {},
  dependencies: PrimeRuntimeDependencies = {},
): Promise<PrimeRuntimeState> => {
  const environment = options.environment ?? process.env
  const initialPaths = primeRuntimePaths(options)
  const paths = primeRuntimePaths({
    ...options,
    home: await canonicalDirectory(initialPaths.home, "HOME"),
    runtimeRoot: await canonicalDirectory(initialPaths.runtimeRoot, "Prime runtime root"),
    profileRoot: await canonicalDirectory(initialPaths.profileRoot, "Prime profile root"),
  })
  await requireNoSymlinkPath(paths.home, "HOME", true)
  await requireNoSymlinkPath(paths.runtimeRoot, "Prime runtime root", true)
  await requireNoSymlinkPath(paths.profileRoot, "Prime profile root", true)
  await requireNoSymlinkPath(paths.profileHome, "Prime profile home", true)
  const marker = (await readOwnedFile(paths.profileMarker, "Prime profile ownership marker")).trim()
  if (marker !== PRIME_PROFILE_MARKER) fail("launch", `Prime profile ownership marker differs: ${paths.profileMarker}`)

  const version = await readInstalledVersion(paths)
  const identity = await readIdentity(paths.runtimeIdentityFile, "Prime runtime identity")
  if (identity.primeVersion !== version)
    fail("launch", "Prime runtime identity version differs from installed receipt; run trx repair prime default")
  const nodeBinary = options.nodeBinary ?? environment.TRELLAGE_NODE_BIN ?? "node"
  const cli = await requirePrimeCli(paths, version)
  const state: PrimeRuntimeState = { paths, nodeBinary, version, cli, identity }
  await verifyCliVersion(state, environment, dependencies)
  await validateKernel(paths, identity)
  return state
}

export const ensurePrimeDaemonIdentity = async (
  state: PrimeRuntimeState,
  dependencies: Pick<PrimeRuntimeDependencies, "daemonIsListening" | "stopDaemon"> = {},
): Promise<void> => {
  await requireNoSymlinkPath(state.paths.daemonDir, "Prime daemon directory", true)
  await mkdir(state.paths.daemonDir, { recursive: true, mode: 0o700 })
  const expected = daemonStamp(state)
  const actual = await readDaemonStamp(state.paths.daemonEnvStamp)
  const matches = actual !== undefined && sameJson(actual, expected)
  let listening = await (dependencies.daemonIsListening ?? socketIsListening)(state.paths.daemonSocket)
  if (listening && !matches) {
    const launchModule = await daemonLaunchModule(state)
    const stopped = await (dependencies.stopDaemon ?? defaultStopDaemon)(state.paths.daemonSocket, launchModule)
    listening = await (dependencies.daemonIsListening ?? socketIsListening)(state.paths.daemonSocket)
    if (!stopped || listening)
      fail("launch", "Prime profile daemon did not stop; refusing to replace its identity stamp")
  }

  const socketStatus = await lstat(state.paths.daemonSocket).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (socketStatus?.isSymbolicLink() || (socketStatus && !socketStatus.isSocket()))
    fail("unsafe-path", `unsafe Prime daemon socket: ${state.paths.daemonSocket}`)
  if (socketStatus && !listening) await rm(state.paths.daemonSocket, { force: true })
  if (!matches || listening === false) await writeDaemonStamp(state.paths.daemonEnvStamp, expected)
}

export const ensurePrimeRuntime = async (
  options: PrimeRuntimePathOptions = {},
  dependencies: PrimeRuntimeDependencies = {},
): Promise<PrimeRuntimeState> => {
  const state = await validatePrimeRuntime(options, dependencies)
  await ensurePrimeDaemonIdentity(state, dependencies)
  return state
}

export const PRIME_MANAGED_FLAGS: ReadonlyArray<string> = [
  "--provider",
  "--model",
  "--offline",
  "--autonomous",
  "--daemon-socket",
  "--append-system-prompt",
  "--single-turn",
]

const flagName = (argument: string): string => argument.split("=", 1)[0]!

export const assertPrimeForwardedArgs = (args: ReadonlyArray<string>): void => {
  for (const argument of args) {
    if (PRIME_MANAGED_FLAGS.includes(flagName(argument)))
      fail("usage", `${flagName(argument)} is managed by the Prime adapter and cannot be forwarded`)
  }
}

export const primeLaunchCommand = (state: PrimeRuntimeState, options: PrimeLaunchOptions = {}): PrimeLaunchCommand => {
  const model = options.model ?? PRIME_DEFAULT_MODEL
  if (model.length === 0) fail("usage", "Prime model cannot be empty")
  const forwardedArgs = options.forwardedArgs ?? []
  assertPrimeForwardedArgs(forwardedArgs)
  if (options.singleTurn === true && options.autonomous === true)
    fail("usage", "Prime launch cannot be both single-turn and autonomous")
  const autonomous = options.autonomous ?? options.singleTurn !== true
  const args = [state.cli, "--provider", PRIME_PROVIDER, "--model", model, "--offline"]
  if (autonomous) args.push("--autonomous")
  args.push("--daemon-socket", state.paths.daemonSocket)
  if (options.appendSystemPrompt !== undefined) args.push("--append-system-prompt", options.appendSystemPrompt)
  args.push(...forwardedArgs)
  return {
    command: state.nodeBinary,
    args,
    env: {
      PRIME_AGENT_CODING_AGENT_DIR: options.codingAgentDirectory ?? state.paths.profileHome,
      PRIME_AGENT_KERNEL_PYTHON: state.paths.kernelPython,
      PRIME_AGENT_KERNEL_VENV: state.paths.kernelVenv,
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_AUTH_TOKEN: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
      OPENAI_API_KEY: null,
      COPILOT_GITHUB_TOKEN: null,
      GH_TOKEN: null,
      GITHUB_TOKEN: null,
    },
  }
}
