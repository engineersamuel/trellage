import path from "node:path"
import { fileURLToPath } from "node:url"
import { bunExecutable } from "./index.ts"
import { packageSources } from "./source-package.ts"

try {
  bunExecutable()
  const [destination, ...extra] = process.argv.slice(2)
  if (destination === undefined || extra.length !== 0) {
    throw new Error("usage: bun run package:source /absolute/path/trellage.tgz")
  }
  if (!path.isAbsolute(destination)) throw new Error("source archive destination must be absolute")
  packageSources(fileURLToPath(new URL("../../../", import.meta.url)), destination)
  process.stdout.write(`${destination}\n`)
} catch (error) {
  process.stderr.write(`trellage source package: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
