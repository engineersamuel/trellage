import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { bunExecutable } from "../../../../packages/trellage-runtime/src/index.ts"
import {
  copySources,
  dependencyDirectory,
  normalizeDependencyPermissions,
  writeReadiness,
} from "../../../../packages/trellage-runtime/src/workspace.ts"

/** Installer transaction tests need the real workspace validator, not the agent/UI dependency graph.
 * Full dependency/bootstrap and agent execution coverage remains in runtime and auth/config contracts.
 * Nothing in the production installer is mocked or given a validation bypass.
 */
export const createCodexInstallationFixture = (source: string, destination: string): void => {
  source = realpathSync(source)
  if (
    !path.isAbsolute(destination) ||
    !destination.split(path.sep).some((part) => /^trellage-cdx-contract\.[a-z0-9]+$/i.test(part))
  )
    throw new Error("installation source must be inside its contract fixture")
  mkdirSync(destination, { mode: 0o755 })
  copySources(source, destination)
  for (const entry of readdirSync(path.join(destination, "packages"))) {
    if (entry !== "trellage-runtime")
      rmSync(path.join(destination, "packages", entry), { recursive: true, force: true })
  }
  const neededPrototypes = new Set(["trellage-codex-profiles", "trellage-codex-common", "trellage-claude-common"])
  for (const entry of readdirSync(path.join(destination, "prototypes"))) {
    if (!neededPrototypes.has(entry))
      rmSync(path.join(destination, "prototypes", entry), { recursive: true, force: true })
  }
  const runtimeSources = new Set([
    "index.ts",
    "bun-version.ts",
    "workspace.ts",
    "workspace-cli.ts",
    "lock-transport.ts",
    "preparation-lock.ts",
  ])
  for (const entry of readdirSync(path.join(destination, "packages/trellage-runtime/src"))) {
    if (!runtimeSources.has(entry))
      rmSync(path.join(destination, "packages/trellage-runtime/src", entry), { recursive: true, force: true })
  }
  const runtimeManifest = path.join(destination, "packages/trellage-runtime/package.json")
  const runtime = JSON.parse(readFileSync(runtimeManifest, "utf8"))
  delete runtime.dependencies
  delete runtime.devDependencies
  delete runtime.scripts
  runtime.exports = { ".": "./src/index.ts", "./workspace": "./src/workspace.ts" }
  writeFileSync(runtimeManifest, JSON.stringify(runtime, null, 2) + "\n")
  const dependencies: Record<string, string> = { "@trellage/runtime": "workspace:*" }
  for (const name of ["varlock", "smol-toml"]) {
    const target = path.join(destination, "packages", `fixture-${name}`)
    cpSync(dependencyDirectory(source, name), target, {
      recursive: true,
      filter: (file) => path.basename(file) !== "node_modules",
    })
    const manifest = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"))
    delete manifest.dependencies
    delete manifest.devDependencies
    delete manifest.optionalDependencies
    delete manifest.peerDependencies
    delete manifest.scripts
    writeFileSync(path.join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
    dependencies[name] = "workspace:*"
  }
  writeFileSync(
    path.join(destination, "package.json"),
    JSON.stringify(
      {
        name: "codex-installation-transaction-fixture",
        version: "1.0.0",
        private: true,
        type: "module",
        workspaces: ["packages/*"],
        dependencies,
      },
      null,
      2,
    ) + "\n",
  )
  rmSync(path.join(destination, "bun.lock"), { force: true })
  const locked = spawnSync(
    bunExecutable(),
    ["--no-env-file", "install", "--lockfile-only", "--offline", `--config=${path.join(destination, "bunfig.toml")}`],
    { cwd: destination, encoding: "utf8", timeout: 5000 },
  )
  if (locked.error || locked.status !== 0)
    throw new Error(`Cannot lock local transaction fixture: ${locked.stderr}`, { cause: locked.error })
  for (const [name, directory] of [
    ["@trellage/runtime", "trellage-runtime"],
    ["varlock", "fixture-varlock"],
    ["smol-toml", "fixture-smol-toml"],
  ]) {
    const link = path.join(destination, "node_modules", name!)
    mkdirSync(path.dirname(link), { recursive: true })
    if (!existsSync(link))
      symlinkSync(path.relative(path.dirname(link), path.join(destination, "packages", directory!)), link)
  }
  // The shell assertions deliberately modify snapshots and use the real receipt writer.
  const helper = "packages/trellage-runtime/test/refresh-fixture.ts"
  mkdirSync(path.dirname(path.join(destination, helper)), { recursive: true })
  cpSync(path.join(source, helper), path.join(destination, helper))
  for (const file of [runtimeManifest, path.join(destination, "package.json")]) chmodSync(file, 0o644)
  normalizeDependencyPermissions(destination)
  writeReadiness(destination)
}
if (import.meta.main) {
  const [source, destination] = process.argv.slice(2)
  if (!source || !destination) throw new Error("usage: installation-source.ts SOURCE DESTINATION")
  createCodexInstallationFixture(realpathSync(source), destination)
}
