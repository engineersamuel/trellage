#!/usr/bin/env node
import { constants } from "node:fs"
import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { consumeInvocation } from "./lib/state.ts"
import { parseContextMenuRequest, type ContextMenuRequest } from "./lib/context-menu.ts"
import { findTrellageRoot } from "./lib/trellage-root.ts"
import { waitForDismissal } from "./popup.ts"

const invocationEnvironment = "TRELLAGE_GUIDE_CONTEXT_MENU_INVOCATION_PATH"
const launcherTerminationGraceMs = 30_000

const launcherPath = async (env: NodeJS.ProcessEnv, root: string): Promise<{ readonly executable: string; readonly node: boolean }> => {
  const configured = env.TRELLAGE_GUIDE_LAUNCHER
  const candidates = configured === undefined || configured.length === 0
    ? [path.join(root, "packages/trellage-launcher/dist/launcher.mjs")]
    : [configured]
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue
    try {
      await access(candidate, constants.X_OK)
      return { executable: candidate, node: candidate.endsWith(".mjs") }
    } catch {}
  }
  throw new Error("The Trellage rewrite launcher is unavailable. Install trx or set TRELLAGE_GUIDE_LAUNCHER.")
}

export const readContextMenuRequest = async (env: NodeJS.ProcessEnv = process.env): Promise<ContextMenuRequest> => {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR
  const requestPath = env[invocationEnvironment]
  if (stateDir === undefined || requestPath === undefined) throw new Error("The contextual action menu is missing its private request path")
  return parseContextMenuRequest(await consumeInvocation(stateDir, requestPath))
}

export interface ContextMenuLauncherDependencies {
  readonly env?: NodeJS.ProcessEnv
  readonly root?: string
  readonly spawnProcess?: typeof spawn
}

export interface ContextMenuPopupDependencies {
  readonly findRoot?: typeof findTrellageRoot
  readonly runLauncher?: typeof runContextMenuLauncher
}

export const runContextMenuLauncher = async (
  request: ContextMenuRequest,
  { env = process.env, root = process.cwd(), spawnProcess = spawn }: ContextMenuLauncherDependencies = {},
): Promise<number> => {
  const launcher = await launcherPath(env, root)
  const command = launcher.node ? process.execPath : launcher.executable
  const args = launcher.node
    ? [launcher.executable, "rewrite-context", "--interactive"]
    : ["rewrite-context", "--interactive"]
  return new Promise<number>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawnProcess(command, args, {
        cwd: root,
        env: { ...env },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "inherit", "inherit"],
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    let killTimer: NodeJS.Timeout | undefined
    let terminating = false
    const disposeSignals = (): void => {
      process.removeListener("SIGINT", terminate)
      process.removeListener("SIGTERM", terminate)
      process.removeListener("SIGHUP", terminate)
    }
    const finish = (error?: Error, code = 0): void => {
      if (settled) return
      settled = true
      if (killTimer !== undefined) clearTimeout(killTimer)
      disposeSignals()
      if (error !== undefined) reject(error)
      else resolve(code)
    }
    const terminate = (): void => {
      if (settled) return
      terminating = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL")
      }, launcherTerminationGraceMs)
    }
    process.once("SIGINT", terminate)
    process.once("SIGTERM", terminate)
    process.once("SIGHUP", terminate)
    child.once("error", (error) => finish(error))
    child.stdin?.once("error", (error) => {
      if (!terminating) finish(error)
    })
    child.stdin?.end(`${JSON.stringify(request)}\n`)
    child.once("close", (code, signal) => {
      if (code === 0) finish(undefined, 0)
      else finish(new Error(`The rewrite launcher stopped with ${signal ?? `status ${code ?? "unknown"}`}`))
    })
  })
}

export const main = async (
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ContextMenuPopupDependencies = {},
): Promise<number> => {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR
  const pluginRoot = env.HERDR_PLUGIN_ROOT
  if (stateDir === undefined || pluginRoot === undefined) throw new Error("The contextual action menu is missing plugin runtime context")
  const request = await readContextMenuRequest(env)
  const root = await (dependencies.findRoot ?? findTrellageRoot)(pluginRoot)
  const runLauncher = dependencies.runLauncher ?? runContextMenuLauncher
  return runLauncher(request, { env: { ...env, HERDR_PLUGIN_STATE_DIR: stateDir }, root })
}

export const runContextMenuPopup = async (
  env: NodeJS.ProcessEnv = process.env,
  dependencies: ContextMenuPopupDependencies = {},
  dismiss: typeof waitForDismissal = waitForDismissal,
): Promise<number> => {
  try {
    return await main(env, dependencies)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await dismiss(`Trellage contextual action menu failed: ${message}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const status = await main()
    if (status !== 0 && status !== 130) await waitForDismissal(`The contextual action menu exited with status ${status}.`)
    process.exitCode = status
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await waitForDismissal(`Trellage contextual action menu failed: ${message}`)
    process.exitCode = 1
  }
}
