#!/usr/bin/env node
// @ts-nocheck -- Legacy terminal UI adapter; queue state modules are type-checked.
import path from "node:path"
import { pathToFileURL } from "node:url"

import { main as runCustomPopup } from "./custom-popup.ts"
import { parseInvocationContext } from "./lib/context.ts"

export const main = async (env = process.env) => {
  if (typeof env.HERDR_PLUGIN_CONTEXT_JSON !== "string") {
    throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not set")
  }
  return runCustomPopup({
    env,
    context: parseInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON),
    initialScreen: "queue",
    queueOnly: true,
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
