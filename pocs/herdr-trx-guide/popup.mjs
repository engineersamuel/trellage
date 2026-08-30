#!/usr/bin/env node
import { spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { parsePopupInvocation } from "./lib/context.mjs"
import {
  consumeInvocation,
  removeGuideIntent,
  removeGuideIntentSync,
  resolvePluginStateDirectory,
  writeGuideIntent,
} from "./lib/state.mjs"
import { findTrellageRoot } from "./lib/trellage-root.mjs"

export { findTrellageRoot }

const launchGuide = (root, env) =>
  new Promise((resolve, reject) => {
    const child = spawn("mise", ["run", "--raw", "trx", "--", "guide"], {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    })
    let settled = false
    child.once("error", (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once("close", (status, signal) => {
      if (settled) return
      settled = true
      if (signal !== null) reject(new Error(`trx guide stopped after signal ${signal}`))
      else resolve(status ?? 1)
    })
  })

const terminationSignals = ["SIGHUP", "SIGINT", "SIGTERM"]

const registerIntentSignalCleanup = (stateDir, intentPath) => {
  const handlers = new Map()
  const dispose = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
  for (const signal of terminationSignals) {
    const handler = () => {
      dispose()
      try {
        removeGuideIntentSync(stateDir, intentPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`Failed to remove the staged guide intent after ${signal}: ${message}`)
      }
      process.kill(process.pid, signal)
    }
    handlers.set(signal, handler)
    process.once(signal, handler)
  }
  return dispose
}

export const runGuide = async (root, invocation) => {
  const stateDir = resolvePluginStateDirectory()
  const intentPath = await writeGuideIntent(stateDir, invocation.answer)
  const disposeSignalCleanup = registerIntentSignalCleanup(stateDir, intentPath)
  const env = {
    ...process.env,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    TRELLAGE_GUIDE_HERDR_INTENT_FILE: intentPath,
    TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify({
      schemaVersion: 1,
      surface: "popup",
      workspaceId: invocation.source.workspaceId,
      paneId: invocation.source.paneId,
      cwd: invocation.source.cwd,
      capture: invocation.capture,
    }),
  }
  if (typeof process.env.HERDR_BIN_PATH === "string" && path.isAbsolute(process.env.HERDR_BIN_PATH)) {
    env.PATH = `${path.dirname(process.env.HERDR_BIN_PATH)}${path.delimiter}${env.PATH ?? ""}`
  }
  delete env.HERDR_PANE_ID
  try {
    return await launchGuide(root, env)
  } finally {
    disposeSignalCleanup()
    await removeGuideIntent(stateDir, intentPath)
  }
}

export const waitForDismissal = async (message) => {
  console.error(`\n${message}`)
  if (!process.stdin.isTTY) return
  console.error("\nPress any key to close.")
  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  await new Promise((resolve) => process.stdin.once("data", resolve))
  process.stdin.setRawMode?.(wasRaw)
  process.stdin.pause()
}

export const main = async () => {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const invocationPath = process.env.TRELLAGE_GUIDE_INVOCATION_PATH
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT
  if (!stateDir || !invocationPath || !pluginRoot) throw new Error("The popup is missing plugin runtime context")
  const invocation = parsePopupInvocation(await consumeInvocation(stateDir, invocationPath))
  const root = await findTrellageRoot(pluginRoot)
  const status = await runGuide(root, invocation)
  if (status !== 0 && status !== 130) {
    await waitForDismissal(`trx guide exited with status ${status}`)
  }
  process.exitCode = status
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await waitForDismissal(`Trellage guide handoff failed: ${message}`)
    process.exitCode = 1
  }
}
