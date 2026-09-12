import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const roots: string[] = []
const repository = fileURLToPath(new URL("../../../", import.meta.url))

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(includeRuntime: boolean) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-container-entrypoint-")))
  roots.push(root)
  const write = (relative: string, contents: string, mode = 0o644) => {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents, { mode })
    return target
  }
  const workspace = path.join(root, "workspace")
  const source = path.join(root, "opt/trellage-source")
  const bin = path.join(root, "bin")
  const codexHome = path.join(workspace, ".codex-home")
  const calls = path.join(root, "bun-calls")
  const entrypoint = write(
    "entrypoint.sh",
    readFileSync(path.join(repository, "scripts/agent-entrypoint.sh"), "utf8")
      .replaceAll("/workspace", workspace)
      .replaceAll("/opt/", `${root}/opt/`)
      .replaceAll("/usr/local/bin/", `${bin}/`),
  )
  if (includeRuntime) {
    write(
      "opt/trellage-source/scripts/bun-runtime.sh",
      readFileSync(path.join(repository, "scripts/bun-runtime.sh"), "utf8"),
    )
    write("opt/trellage-source/packages/trellage-runtime/bunfig.toml", '[install]\nauto = "disable"\n')
  }
  const bun = write(
    "bin/bun",
    '#!/bin/sh\nif [ "$1" = --version ]; then printf "1.3.3\\n"; exit; fi\nprintf "%s\\0" "$@" >>"$BUN_CALLS"\nprintf "\\0" >>"$BUN_CALLS"\n',
    0o755,
  )
  write("bin/git", "#!/bin/sh\nexit 0\n", 0o755)
  write("bin/adapt-agent-kit.sh", "#!/bin/sh\nexit 0\n", 0o755)
  write("opt/agent-kit/.codex/agents/custom.toml", 'name = "custom"\n')
  write("opt/agent-kit-inventory.txt", ".codex/agents/custom.toml\n")
  write("opt/codex-config.toml", 'model = "fixture"\n')
  const cwd = path.join(root, "caller")
  mkdirSync(cwd)
  const result = spawnSync("/bin/bash", [entrypoint, "/bin/sh", "-c", "printf '%s\\n' \"$PWD\"; exit 23"], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      CODEX_HOME: codexHome,
      PATH: `${bin}:/usr/bin:/bin`,
      TRELLAGE_BUN_EXECUTABLE: bun,
      BUN_CALLS: calls,
    },
  })
  return { root, workspace, source, codexHome, cwd, calls, result }
}

test("comparison entrypoint uses workspace TS helpers and preserves the final command status and cwd", () => {
  const { root, source, codexHome, cwd, calls, result } = fixture(true)
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.status).toBe(23)
  expect(result.stdout.trim()).toBe(cwd)
  const invocations = readFileSync(calls, "utf8")
    .split("\0\0")
    .filter(Boolean)
    .map((invocation) => invocation.split("\0"))
  const flags = ["--no-install", "--no-env-file", `--config=${source}/packages/trellage-runtime/bunfig.toml`]
  expect(invocations).toEqual([
    [
      ...flags,
      `${source}/scripts/floating-skills.ts`,
      "--",
      "sync",
      "--catalog",
      `${root}/opt/floating-skills-catalog.json`,
      "--bundle",
      "comparison-common",
      "--output",
      `${root}/opt/floating-skills`,
      "--target",
      `${codexHome}/skills`,
    ],
    [
      ...flags,
      `${root}/opt/codex-common/codex-agents.ts`,
      "--",
      "install",
      `${codexHome}/agents`,
      `${root}/opt/codex-common/agents`,
    ],
  ])
  expect(readFileSync(`${codexHome}/agents/custom.toml`, "utf8")).toBe('name = "custom"\n')
})

test("comparison entrypoint fails before workspace mutation when the source runtime is absent", () => {
  const { workspace, calls, result } = fixture(false)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("missing or unsafe source runtime helper")
  expect(existsSync(workspace)).toBe(false)
  expect(existsSync(calls)).toBe(false)
})
