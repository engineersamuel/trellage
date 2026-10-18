import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createCodexInstallationFixture } from "../../../prototypes/trellage-codex-profiles/tests/lib/installation-source.ts"
import { sourceWorkspaceRoot } from "../src/index.ts"
import { requireReady as checkReady } from "../src/workspace.ts"

test("transaction fixture keeps real installer sources and runtime validation without the UI dependency payload", () => {
  const temporary = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-cdx-contract.")))
  try {
    const destination = path.join(temporary, "source")
    createCodexInstallationFixture(sourceWorkspaceRoot(), destination)
    checkReady(destination)
    expect(readFileSync(path.join(destination, "prototypes/trellage-codex-profiles/install.sh"), "utf8")).toBe(
      readFileSync(path.join(sourceWorkspaceRoot(), "prototypes/trellage-codex-profiles/install.sh"), "utf8"),
    )
    const manifest = JSON.parse(readFileSync(path.join(destination, "package.json"), "utf8"))
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@trellage/runtime", "smol-toml", "varlock"])
    expect(readFileSync(path.join(destination, "node_modules/varlock/bin/cli.js"), "utf8")).toBe(
      readFileSync(path.join(sourceWorkspaceRoot(), "node_modules/varlock/bin/cli.js"), "utf8"),
    )
    expect(readFileSync(path.join(destination, "node_modules/smol-toml/package.json"), "utf8")).toContain('"smol-toml"')
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
