import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import path from "node:path"
import { writeReadiness } from "../src/workspace.ts"

const [root, action = "refresh", ...rest] = process.argv.slice(2)
const isFixture = (candidate: string) =>
  candidate
    .split(path.sep)
    .some(
      (component) =>
        component.startsWith(".contract-fixture.") ||
        /^trellage-(?:cdx|pstack|fmx)-contract\.[a-z0-9]+$/i.test(component),
    )
if (root === undefined || !path.isAbsolute(root) || !isFixture(root) || rest.length !== 0) {
  throw new Error("Only an explicitly changed shell contract fixture can be refreshed")
}

function snapshot(directory: string, relative = "."): void {
  const candidate = path.join(directory, relative)
  const status = lstatSync(candidate)
  const mode = (status.mode & 0o7777).toString(8)
  if (status.isSymbolicLink()) {
    console.log(JSON.stringify(["l", mode, relative, readlinkSync(candidate)]))
  } else if (status.isDirectory()) {
    console.log(JSON.stringify(["d", mode, relative]))
    for (const name of readdirSync(candidate).sort()) snapshot(directory, path.join(relative, name))
  } else if (status.isFile()) {
    console.log(
      JSON.stringify(["f", mode, relative, createHash("sha256").update(readFileSync(candidate)).digest("hex")]),
    )
  } else {
    throw new Error(`Unsupported fixture entry: ${candidate}`)
  }
}

if (action === "refresh") writeReadiness(root)
else if (action === "snapshot") snapshot(root)
else throw new Error(`Unknown fixture operation: ${action}`)
