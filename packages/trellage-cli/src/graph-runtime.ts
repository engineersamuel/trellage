import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"

import { inventoryDirectory, type InventoryError } from "./inventory.js"

export const isGeneratedPythonRuntimePath = (relativePath: string): boolean =>
  relativePath.split("/").includes("__pycache__") || /\.(?:pyc|pyo)$/.test(relativePath)

export const graphOfLoopsRuntimeAssetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/graph-of-loops",
)

export const graphOfLoopsRuntimeIntegrity = (graphRuntimePath: string): Effect.Effect<string, InventoryError> =>
  inventoryDirectory(graphRuntimePath).pipe(
    Effect.map(
      (inventory) =>
        `sha256:${createHash("sha256")
          .update(JSON.stringify(inventory.filter((entry) => !isGeneratedPythonRuntimePath(entry.path))))
          .digest("hex")}`,
    ),
  )
