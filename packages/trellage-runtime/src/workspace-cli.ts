import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs"
import { lstat } from "node:fs/promises"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { bunExecutable } from "./index.ts"
import { withRegistryTransport } from "./lock-transport.ts"
import {
  copySources,
  dependencyDirectory,
  normalizeDependencyPermissions,
  requireOwnedWorkspace,
  requireReady,
  requireReadyAsync,
  safeDirectory,
  safePath,
  sourceFingerprint,
  sourceFingerprintAsync,
  sourceMarker,
  sourceOwnership,
  validateWorkspaceBinaries,
  writeReadiness,
} from "./workspace.ts"

async function present(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw error
  }
}

const cancellation = new AbortController()
const signalStatus = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const
let cancelledStatus: number | undefined
const signalHandlers = Object.entries(signalStatus).map(([signal, status]) => {
  const handler = () => {
    cancelledStatus = status
    cancellation.abort(new Error(`source installation cancelled by ${signal}`))
  }
  process.on(signal, handler)
  return { signal, handler }
})

async function installDependencies(root: string): Promise<void> {
  cancellation.signal.throwIfAborted()
  validateWorkspaceBinaries(root)
  const cache = mkdtempSync(path.join(root, ".trellage-package-cache."))
  try {
    await installFrozenDependencies(root, {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? path.join(cache, "bun"),
      npm_config_cache: process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? path.join(cache, "npm"),
    })
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
  cancellation.signal.throwIfAborted()
  normalizeDependencyPermissions(root)
  writeReadiness(root)
}

async function installFrozenDependencies(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  let registry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
  if (registry === undefined) {
    try {
      registry = (
        await promisify(execFile)("npm", ["config", "get", "registry", "--workspaces=false"], {
          cwd: root,
          env,
          signal: cancellation.signal,
          timeout: 10_000,
        })
      ).stdout.trim()
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }
  await withRegistryTransport(root, registry, async () => {
    const child = spawn(
      bunExecutable(),
      [
        "--no-env-file",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--no-progress",
        "--backend=copyfile",
        `--config=${path.join(root, "bunfig.toml")}`,
      ],
      { cwd: root, env, stdio: ["ignore", 2, 2], signal: cancellation.signal },
    )
    await new Promise<void>((resolve, reject) => {
      let failure: Error | undefined
      child.once("error", (error) => {
        failure = error
      })
      child.once("close", (code, signal) => {
        if (failure !== undefined) reject(failure)
        else if (code !== 0) reject(new Error(`frozen source dependency installation failed (${code ?? signal})`))
        else resolve()
      })
    })
  })
}

async function stage(root: string, destination: string): Promise<void> {
  mkdirSync(destination, { mode: 0o755 })
  copySources(root, destination)
  writeFileSync(path.join(destination, sourceMarker), `${sourceOwnership}\n`, { flag: "wx", mode: 0o644 })
  await installDependencies(destination)
  requireOwnedWorkspace(destination)
}

type LegacyRuntime = "floating" | "environment" | undefined

async function requireReplaceable(destination: string, legacy: LegacyRuntime): Promise<boolean> {
  if (await present(path.join(destination, sourceMarker))) {
    requireOwnedWorkspace(destination)
    return true
  }
  safeDirectory(destination)
  const entries = readdirSync(destination).sort()
  if (legacy === "floating" && entries.join(",") === "floating-skills.mjs,skills.json") {
    for (const entry of entries) safePath(path.join(destination, entry), "file")
    return false
  }
  if (legacy === "environment" && entries.join(",") === ".managed-by-trellage,native-environment.mjs,node_modules") {
    safePath(path.join(destination, ".managed-by-trellage"), "file")
    if (
      readFileSync(path.join(destination, ".managed-by-trellage"), "utf8") !==
      "trellage-native-environment-runtime-v1\n"
    ) {
      throw new Error(`refusing unowned native environment runtime: ${destination}`)
    }
    safePath(path.join(destination, "native-environment.mjs"), "file")
    safePath(path.join(destination, "node_modules"), "directory")
    if (readdirSync(path.join(destination, "node_modules")).sort().join(",") !== "smol-toml,varlock") {
      throw new Error(`refusing unrelated native environment dependency: ${destination}`)
    }
    const inspect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name)
        safePath(candidate, entry.isDirectory() ? "directory" : "file")
        if (entry.isDirectory()) inspect(candidate)
      }
    }
    inspect(path.join(destination, "node_modules"))
    return false
  }
  throw new Error(`refusing unowned source runtime: ${destination}`)
}

interface Publication {
  readonly destination: string
  readonly temporary: string
  oldMoved: boolean
  newMoved: boolean
}

async function publicationCheckpoint(point: string): Promise<void> {
  if (process.env.TRELLAGE_SOURCE_INSTALL_TEST_FAIL_AT === point) throw new Error(`injected failure ${point}`)
  if (process.env.TRELLAGE_SOURCE_INSTALL_TEST_FAIL_AT === `signal-${point}`) {
    process.kill(process.pid, "SIGTERM")
    await new Promise((resolve) => setImmediate(resolve))
  }
  cancellation.signal.throwIfAborted()
}

async function rollback(publication: Publication): Promise<void> {
  const { destination, temporary } = publication
  if (publication.newMoved) {
    requireOwnedWorkspace(destination)
    renameSync(destination, path.join(temporary, "failed"))
  }
  if (publication.oldMoved) {
    if (await present(destination)) throw new Error(`rollback destination is occupied: ${destination}`)
    renameSync(path.join(temporary, "old"), destination)
  }
}

async function publish(root: string, publication: Publication, legacy: LegacyRuntime): Promise<void> {
  const { destination, temporary } = publication
  const staged = path.join(temporary, "new")
  await stage(root, staged)
  cancellation.signal.throwIfAborted()
  await publicationCheckpoint("after-staging")
  if (await present(destination)) {
    await requireReplaceable(destination, legacy)
    cancellation.signal.throwIfAborted()
    renameSync(destination, path.join(temporary, "old"))
    publication.oldMoved = true
  }
  await publicationCheckpoint("during-publication")
  if (await present(destination)) throw new Error(`source destination changed during publication: ${destination}`)
  cancellation.signal.throwIfAborted()
  renameSync(staged, destination)
  publication.newMoved = true
  await publicationCheckpoint("after-publication")
}

async function install(root: string, destination: string, legacy?: LegacyRuntime): Promise<void> {
  const parent = safeDirectory(path.dirname(destination))
  const lock = `${destination}.lock`
  mkdirSync(lock, { mode: 0o700 })
  let publication: Publication | undefined
  let preserveRecovery = false
  try {
    if (await present(destination)) {
      const current = await requireReplaceable(destination, legacy)
      if (current && sourceFingerprint(root) === sourceFingerprint(destination)) return
    }
    publication = {
      destination,
      temporary: mkdtempSync(path.join(parent, ".trellage-source-install.")),
      oldMoved: false,
      newMoved: false,
    }
    await publish(root, publication, legacy)
  } catch (error) {
    if (publication !== undefined) {
      try {
        await rollback(publication)
      } catch (rollbackError) {
        preserveRecovery = true
        throw new AggregateError(
          [error, rollbackError],
          `source rollback failed; retain recovery directory: ${publication.temporary}`,
        )
      }
    }
    throw error
  } finally {
    if (publication !== undefined && !preserveRecovery) rmSync(publication.temporary, { recursive: true })
    rmdirSync(lock)
  }
}

const [action, suppliedRoot, suppliedDestination, ...extra] = process.argv.slice(2)
try {
  bunExecutable()
  if (suppliedRoot === undefined || !path.isAbsolute(suppliedRoot) || extra.length !== 0) {
    throw new Error(
      "usage: workspace-cli.ts check|fingerprint|prepare|validate-owned ROOT; stage|install ROOT DESTINATION",
    )
  }
  const root = safeDirectory(suppliedRoot)
  switch (action) {
    case "check":
      await requireReadyAsync(root)
      break
    case "fingerprint": {
      const digest = await sourceFingerprintAsync(root)
      cancellation.signal.throwIfAborted()
      process.stdout.write(`${digest}\n`)
      break
    }
    case "prepare":
      await installDependencies(root)
      break
    case "validate-owned":
      requireOwnedWorkspace(root)
      break
    case "validate-floating":
      await requireReplaceable(root, "floating")
      break
    case "validate-environment":
      await requireReplaceable(root, "environment")
      break
    case "ensure-common": {
      let directory = root
      for (const component of [".local", "share", "trellage", "common"]) {
        directory = path.join(directory, component)
        if (!(await present(directory))) mkdirSync(directory, { mode: 0o755 })
        safeDirectory(directory)
      }
      process.stdout.write(`${directory}\n`)
      break
    }
    case "dependency":
      if (suppliedDestination === undefined) throw new Error("dependency name is required")
      process.stdout.write(`${dependencyDirectory(root, suppliedDestination)}\n`)
      break
    case "stage":
    case "install-floating":
    case "install-environment":
    case "install": {
      if (suppliedDestination === undefined || !path.isAbsolute(suppliedDestination)) {
        throw new Error("source destination must be absolute")
      }
      const destination = path.resolve(suppliedDestination)
      if (destination === root || destination === path.parse(destination).root)
        throw new Error("unsafe source destination")
      safeDirectory(path.dirname(destination))
      if (action === "stage") await stage(root, destination)
      else
        await install(
          root,
          destination,
          action === "install-floating" ? "floating" : action === "install-environment" ? "environment" : undefined,
        )
      break
    }
    default:
      throw new Error(`unknown source runtime action: ${action ?? ""}`)
  }
} catch (error) {
  process.stderr.write(`trellage source runtime: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = cancelledStatus ?? 1
} finally {
  for (const { signal, handler } of signalHandlers) process.off(signal, handler)
}
