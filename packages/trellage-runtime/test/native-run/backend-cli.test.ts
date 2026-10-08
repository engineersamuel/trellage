import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { promisify } from "node:util"
import path from "node:path"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

const exec = promisify(execFile)
const cli = path.resolve(import.meta.dir, "../../src/native-run/cli.ts")
const backend = path.resolve(import.meta.dir, "../../src/native-run/backend-cli.ts")
afterEach(cleanupFixtures)

test("canonical OMP launch and inventory use owned private backend without alias PATH", async () => {
  const home = await tempRoot("private-backend")
  const root = path.join(home, ".local/share/trellage/omp")
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(path.join(root, ".managed-by-trellage-omp-profiles"), "trellage-omp-profiles-v2\n")
  await writeFile(path.join(root, "bin/omp"), `#!/bin/sh
if [ "$1" = inventory ]; then printf '{"launcher":"omp","harness":"oh-my-pi","profile":"%s","readiness":"not-setup"}\\n' "$2"; exit; fi
printf '%s\\n' "$@" > "$HOME/argv"
printf '%s' "$TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT" > "$HOME/snapshot"
`, { mode: 0o755 })
  const config = path.join(home, "config.toml")
  await writeFile(config, "[native.profiles.preset-omp-default]\nharnesses = [\"omp\"]\n", { mode: 0o600 })
  const env = { HOME: home, TRELLAGE_CONFIG: config, PATH: "/usr/bin:/bin" }
  await exec(process.execPath, [cli, "omp", "default", "--", "--resume", "old-session"], { env })
  expect(await readFile(path.join(home, "argv"), "utf8")).toBe("copilot\n--resume\nold-session\n")
  expect(await readFile(path.join(home, "snapshot"), "utf8")).toContain("/generations/")
  const result = await exec(process.execPath, [backend, "inventory", "omp", "default", "--json"], { env })
  expect(JSON.parse(result.stdout)).toEqual({ launcher: "omp", harness: "omp", profile: "default", readiness: "not-setup" })
})

test("JSON translation preserves unrelated launcher fields and passes unsupported shapes through", async () => {
  const home = await tempRoot("backend-json")
  const root = path.join(home, ".local/share/trellage/codex")
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(path.join(root, ".managed-by-trellage-codex-profiles"), "trellage-codex-profiles-v2\n")
  await writeFile(path.join(root, "bin/codex"), `#!/bin/sh
if [ "$2" = unrelated ]; then printf '{"launcher":"upstream","profile":"%s"}\\n' "$2"; exit; fi
printf '{"launcher":"codex","profiles":["unsupported"]}\\n'
`, { mode: 0o755 })
  const env = { HOME: home, PATH: "/usr/bin:/bin" }

  const unrelated = await exec(process.execPath, [backend, "inventory", "codex", "unrelated", "--json"], { env })
  expect(JSON.parse(unrelated.stdout)).toEqual({ launcher: "upstream", profile: "unrelated" })

  const unsupported = await exec(process.execPath, [backend, "list", "codex", "--json"], { env })
  expect(unsupported.stdout).toBe('{"launcher":"codex","profiles":["unsupported"]}\n')
})

test("old private backends cannot receive unknown maintenance verbs", async () => {
  const home = await tempRoot("old-backend")
  const root = path.join(home, ".local/share/trellage/codex")
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(path.join(root, ".managed-by-trellage-codex-profiles"), "trellage-codex-profiles-v2\n")
  await writeFile(path.join(root, "bin/codex"), `#!/bin/sh
if [ "$1" = --help ]; then printf 'Usage: codex PROFILE\\n'; exit; fi
printf '%s\\n' "$@" > "$HOME/unexpected-mutation"
`, { mode: 0o755 })
  const env = { HOME: home, PATH: "/usr/bin:/bin" }
  for (const args of [["upgrade", "codex", "pstack", "--harness-only"], ["skills-update", "codex", "pstack"]]) {
    await expect(exec(process.execPath, [backend, ...args], { env })).rejects.toThrow("Refresh the installed Trellage launcher first")
  }
  expect(await Bun.file(path.join(home, "unexpected-mutation")).exists()).toBe(false)
})

test("maintenance cancellation stays nonzero when its backend handles TERM with a successful exit", async () => {
  const home = await tempRoot("backend-cancellation")
  const root = path.join(home, ".local/share/trellage/codex")
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(path.join(root, ".managed-by-trellage-codex-profiles"), "trellage-codex-profiles-v2\n")
  await writeFile(path.join(root, "bin/codex"), `#!/bin/sh
trap 'exit 0' TERM
printf 'ready\\n'
sleep 30 &
wait
`, { mode: 0o755 })
  const child = spawn(process.execPath, [backend, "setup", "codex", "pstack"], {
    env: { HOME: home, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"],
  })
  try {
    await once(child.stdout!, "data")
    child.kill("SIGTERM")
    const [code, signal] = await once(child, "exit")
    expect(code).toBe(143)
    expect(signal).toBeNull()
  } finally { child.kill("SIGKILL") }
})

test("attached runs cancel startup descendants without changing their terminal process group", async () => {
  const home = await tempRoot("backend-run-cancellation")
  const root = path.join(home, ".local/share/trellage/codex")
  await mkdir(path.join(root, "bin"), { recursive: true })
  await writeFile(path.join(root, ".managed-by-trellage-codex-profiles"), "trellage-codex-profiles-v2\n")
  await writeFile(path.join(root, "bin/codex"), `#!/bin/sh
sleep 30 &
printf '%s\\n' "$!" > "$HOME/worker"
printf 'ready\\n'
wait
`, { mode: 0o755 })
  const config = path.join(home, "config.toml")
  await writeFile(config, '[native.profiles.preset-codex-pstack]\n', { mode: 0o600 })
  const child = spawn(process.execPath, [backend, "run", "codex", "pstack"], {
    env: { HOME: home, TRELLAGE_CONFIG: config, PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"],
  })
  let worker: number | undefined
  try {
    await once(child.stdout!, "data")
    worker = Number(await readFile(path.join(home, "worker"), 'utf8'))
    child.kill("SIGTERM")
    const [code] = await once(child, "exit")
    expect(code).toBe(143)
    let state = ""
    try { state = (await exec("ps", ["-o", "stat=", "-p", String(worker)])).stdout.trim() } catch {}
    expect(state === "" || state.startsWith("Z")).toBe(true)
  } finally {
    child.kill("SIGKILL")
    if (worker) { try { process.kill(worker, "SIGKILL") } catch {} }
  }
})
