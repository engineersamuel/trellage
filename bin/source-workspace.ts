import { lstatSync } from "node:fs"
import path from "node:path"
import { sourceWorkspaceRoot } from "../packages/trellage-runtime/src/index.ts"
import { requireOwnedWorkspace, sourcePackageManifest } from "../packages/trellage-runtime/src/workspace.ts"

export function commandWorkspace(): string {
  const root = sourceWorkspaceRoot()
  const installed = path.join(root, ".trellage-runtime")
  if (lstatSync(installed, { throwIfNoEntry: false }) === undefined) {
    if (sourcePackageManifest(root) !== path.join(root, "package.json")) {
      throw new Error(
        "Trellage source distribution is not installed; run scripts/install-source-runtime.sh --package explicitly",
      )
    }
    return root
  }
  requireOwnedWorkspace(installed)
  return installed
}
