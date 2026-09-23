import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { acquirePreparationLock } from "../src/preparation-lock.ts"
import { bunExecutable, sourceEnvironment, sourceWorkspaceRoot } from "../src/index.ts"
import { preparationLockName } from "../src/workspace.ts"

const fixtures: string[] = []

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "trellage-preparation-lock-"))
  fixtures.push(root)
  return root
}

function sourceFixture(): {
  readonly parent: string
  readonly root: string
  readonly home: string
  readonly log: string
  readonly barrier: string
  readonly preload: string
} {
  const parent = realpathSync(fixture())
  const root = path.join(parent, "source")
  const home = path.join(parent, "home")
  const log = path.join(home, "installs.log")
  const barrier = path.join(home, "install-barrier")
  const preload = path.join(parent, "preload.ts")
  mkdirSync(home)
  for (const directory of ["bin", "packages", "prototypes", "scripts", "profile-guides", "profiles"]) {
    mkdirSync(path.join(root, directory), { recursive: true })
  }
  writeFileSync(
    path.join(root, "package.json"),
    '{"name":"preparation-fixture","private":true,"workspaces":["packages/*"],"dependencies":{"@fixture/tool":"workspace:*"}}',
  )
  writeFileSync(path.join(root, "bunfig.toml"), '[install]\nauto = "disable"\nlinker = "isolated"\n')
  writeFileSync(path.join(root, "tsconfig.base.json"), '{"compilerOptions":{"noEmit":true}}')
  writeFileSync(path.join(root, "skills.json"), "{}")
  mkdirSync(path.join(root, "packages/tool"), { recursive: true })
  writeFileSync(path.join(root, "packages/tool/package.json"), '{"name":"@fixture/tool","version":"1.0.0"}')
  const realBun = bunExecutable()
  const initial = Bun.spawnSync(
    [realBun, "--no-env-file", "install", "--ignore-scripts", `--config=${path.join(root, "bunfig.toml")}`],
    {
      cwd: root,
      env: sourceEnvironment({ ...process.env, HOME: home, BUN_INSTALL_CACHE_DIR: path.join(parent, "cache") }),
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  if (initial.exitCode !== 0) throw new Error(new TextDecoder().decode(initial.stderr))
  const wrapper = path.join(parent, "bun-wrapper.sh")
  writeFileSync(
    wrapper,
    `#!/bin/sh
is_install=0
for arg in "$@"; do
  if [ "$arg" = "install" ]; then is_install=1; fi
done
if [ "$is_install" = "1" ]; then
  printf 'install\\n' >> "$TRELLAGE_TEST_INSTALL_LOG"
  printf 'TRELLAGE_TEST_INSTALL_STARTED\\n' >&2
  if mkdir "$TRELLAGE_TEST_INSTALL_BARRIER" 2>/dev/null; then sleep 0.2; fi
fi
exec "$TRELLAGE_TEST_REAL_BUN" "$@"
`,
    { mode: 0o755 },
  )
  writeFileSync(
    preload,
    `import { mock } from "bun:test"\nmock.module(${JSON.stringify(path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/index.ts"))}, () => ({ bunExecutable: () => ${JSON.stringify(wrapper)} }))\n`,
  )
  return { parent, root, home, log, barrier, preload }
}

function runCli(action: string, root: string, home: string, log: string, barrier: string, onInstall?: () => void) {
  const cli = path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/workspace-cli.ts")
  return new Promise<{ readonly status: number | null; readonly stderr: string }>((resolve, reject) => {
    const child = spawn(
      bunExecutable(),
      [
        "--no-install",
        "--no-env-file",
        `--config=${path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/bunfig.toml")}`,
        "--preload",
        path.join(path.dirname(root), "preload.ts"),
        cli,
        action,
        root,
      ],
      {
        env: sourceEnvironment({
          ...process.env,
          HOME: home,
          TRELLAGE_TEST_REAL_BUN: bunExecutable(),
          TRELLAGE_TEST_INSTALL_LOG: log,
          TRELLAGE_TEST_INSTALL_BARRIER: barrier,
          BUN_INSTALL_CACHE_DIR: path.join(path.dirname(log), "cache"),
        }),
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 10_000,
      },
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
      if (stderr.includes("TRELLAGE_TEST_INSTALL_STARTED")) onInstall?.()
    })
    child.once("error", reject)
    child.once("close", (status) => resolve({ status, stderr }))
  })
}

test("waits for a competing preparation and only the owner releases the lock", async () => {
  const root = fixture()
  const lock = path.join(root, "source.prepare.lock")
  const owner = await acquirePreparationLock(lock, { pollMs: 2, timeoutMs: 100 })
  let released = false
  const waiting = acquirePreparationLock(lock, { pollMs: 2, timeoutMs: 100 }).then(async (held) => {
    released = true
    await held.release()
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(released).toBe(false)
  await owner.release()
  await waiting
})

test("cancels while waiting without removing the competing lock", async () => {
  const root = fixture()
  const lock = path.join(root, "source.prepare.lock")
  mkdirSync(lock, { mode: 0o700 })
  const cancellation = new AbortController()
  const waiting = acquirePreparationLock(lock, { pollMs: 2, timeoutMs: 1000, signal: cancellation.signal })
  cancellation.abort()
  await expect(waiting).rejects.toThrow("cancelled")
  expect(() => writeFileSync(path.join(lock, "owner"), "still held")).not.toThrow()
})

test("times out while a competing preparation remains held", async () => {
  const root = fixture()
  const lock = path.join(root, "source.prepare.lock")
  mkdirSync(lock, { mode: 0o700 })
  await expect(acquirePreparationLock(lock, { pollMs: 1, timeoutMs: 5 })).rejects.toThrow("timed out")
  expect(() => writeFileSync(path.join(lock, "owner"), "still held")).not.toThrow()
})

test("refuses unsafe existing lock paths", async () => {
  const root = fixture()
  const target = path.join(root, "target")
  mkdirSync(target)
  const lock = path.join(root, "source.prepare.lock")
  symlinkSync(target, lock)
  await expect(acquirePreparationLock(lock, { pollMs: 1, timeoutMs: 10 })).rejects.toThrow("unsafe preparation lock")
})

test("does not remove a lock replaced after acquisition", async () => {
  const root = fixture()
  const lock = path.join(root, "source.prepare.lock")
  const held = await acquirePreparationLock(lock)
  const original = path.join(root, "source.prepare.lock.original")
  renameSync(lock, original)
  mkdirSync(lock, { mode: 0o700 })
  await expect(held.release()).rejects.toThrow("unsafe preparation lock")
  expect(() => writeFileSync(path.join(lock, "owner"), "still held")).not.toThrow()
})

test("competing ensure callers perform one install and both observe readiness", async () => {
  const f = sourceFixture()
  expect(existsSync(path.join(f.root, ".trellage-source-ready.json"))).toBe(false)
  const [first, second] = await Promise.all([
    runCli("ensure", f.root, f.home, f.log, f.barrier),
    runCli("ensure", f.root, f.home, f.log, f.barrier),
  ])
  expect(first.status, first.stderr).toBe(0)
  expect(second.status, second.stderr).toBe(0)
  expect(readFileSync(f.log, "utf8").trim().split("\n")).toHaveLength(1)
  expect(readFileSync(path.join(f.root, ".trellage-source-ready.json"), "utf8")).toContain('"schema":1')
  expect(existsSync(path.join(f.root, preparationLockName))).toBe(false)
})

test("ensure waits for an explicit prepare and reuses its completed install", async () => {
  const f = sourceFixture()
  let installed!: () => void
  const started = new Promise<void>((resolve) => {
    installed = resolve
  })
  const preparePromise = runCli("prepare", f.root, f.home, f.log, f.barrier, installed)
  await Promise.race([
    started,
    preparePromise.then((result) => {
      throw new Error(`Preparation exited before installation: ${result.stderr}`)
    }),
  ])
  const [prepare, ensure] = await Promise.all([preparePromise, runCli("ensure", f.root, f.home, f.log, f.barrier)])
  expect(prepare.status, prepare.stderr).toBe(0)
  expect(ensure.status, ensure.stderr).toBe(0)
  expect(readFileSync(f.log, "utf8").trim().split("\n")).toHaveLength(1)
  expect(existsSync(path.join(f.root, ".trellage-source-ready.json"))).toBe(true)
}, 15_000)

test("preparation works when the workspace parent is non-writable", async () => {
  const f = sourceFixture()
  chmodSync(f.parent, 0o555)
  try {
    const result = await runCli("prepare", f.root, f.home, f.log, f.barrier)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(path.join(f.root, ".trellage-source-ready.json"))).toBe(true)
    const ready = await runCli("ensure", f.root, f.home, f.log, f.barrier)
    expect(ready.status, ready.stderr).toBe(0)
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toHaveLength(1)
  } finally {
    chmodSync(f.parent, 0o755)
  }
})
