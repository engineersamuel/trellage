import { constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { copySources, safeDirectory, safePath, sourcePackageManifest } from "./workspace.ts"

export function packageSources(root: string, destination: string): void {
  safeDirectory(root)
  safeDirectory(path.dirname(destination))
  const temporary = mkdtempSync(path.join(path.dirname(destination), ".trellage-package."))
  try {
    const stage = path.join(temporary, "package")
    mkdirSync(stage, { mode: 0o755 })
    copySources(root, stage)
    const canonical = readFileSync(sourcePackageManifest(root), "utf8")
    const source: Record<string, unknown> = JSON.parse(canonical)
    writeFileSync(path.join(stage, "package.source.json"), canonical, { flag: "wx", mode: 0o644 })
    const manifest = {
      name: source.name,
      version: source.version,
      description: source.description,
      license: source.license,
      type: source.type,
      bin: source.bin,
      engines: source.engines,
      repository: source.repository,
      trellageSourceManifest: "package.source.json",
      scripts: { postinstall: "bash scripts/install-source-runtime.sh --package" },
    }
    writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const name of ["README.md", "LICENSE"]) {
      safePath(path.join(root, name), "file")
      copyFileSync(path.join(root, name), path.join(stage, name))
    }
    const archive = path.join(temporary, "source.tgz")
    const result = spawnSync("tar", ["-czf", archive, "-C", temporary, "package"], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`source archive failed (${result.status ?? result.signal})`)
    copyFileSync(archive, destination, constants.COPYFILE_EXCL)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
