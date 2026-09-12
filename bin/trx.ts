#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null
import path from "node:path"
import { runShellBridge } from "../packages/trellage-runtime/src/index.ts"
import { commandWorkspace } from "./source-workspace.ts"

const sourceRoot = path.join(commandWorkspace(), "prototypes/trellage-router")
runShellBridge(path.join(sourceRoot, "bin/trx"), process.argv.slice(2), {
  ...process.env,
  TRELLAGE_TRX_SOURCE_ROOT: sourceRoot,
})
