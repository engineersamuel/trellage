// Pi extension that pi-subagents loads into every child of a deep-research worker (registerRequiredChildExtensions):
// it counts the child's Perplexity calls in the worker's shared budget file and refuses calls over the limit, as the
// parent's tool guard does. The file is the one count across the parent, foreground children and detached runners.
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { budgetFile, takeFromFile } from "./pi-budget.ts"

export default (pi: ExtensionAPI) => {
  const file = budgetFile()
  if (!file) return
  pi.on("tool_call", (e) => {
    const reason = takeFromFile(file, e.toolName, { closeSync, openSync, readFileSync, writeFileSync })
    return reason ? { block: true, reason } : undefined
  })
}
