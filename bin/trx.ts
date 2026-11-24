#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null
import path from "node:path"
import { runShellBridge } from "../packages/trellage-runtime/src/index.ts"
import { commandWorkspace } from "./source-workspace.ts"

if (process.platform === "win32") {
  try {
    // Loaded only on Windows, so Unix startup never imports the Windows router.
    const { runWindowsRouter } = await import("../packages/trellage-runtime/src/windows-router.ts")
    process.exitCode = await runWindowsRouter(commandWorkspace(), process.argv.slice(2))
  } catch (cause) {
    console.error(`trx: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
  }
} else {
  const sourceRoot = path.join(commandWorkspace(), "prototypes/trellage-router")
  runShellBridge(path.join(sourceRoot, "bin/trx"), process.argv.slice(2), {
    ...process.env,
    TRELLAGE_TRX_SOURCE_ROOT: sourceRoot,
  })
}
