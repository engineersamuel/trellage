import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
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
import { fileURLToPath } from "node:url"

const roots: string[] = []
const repository = fileURLToPath(new URL("../../../", import.meta.url))

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-bootstrap-")))
  roots.push(root)
  const write = (relative: string, contents: string, mode = 0o644) => {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, contents, { mode })
    return target
  }
  const runtime = path.join(root, "runtime")
  const source = path.join(runtime, "source")
  const cwd = path.join(root, "caller")
  const state = path.join(root, "state")
  const calls = path.join(root, "calls")
  mkdirSync(cwd)
  const bootstrap = readFileSync(path.join(repository, "scripts/bootstrap-development-dependencies.sh"), "utf8")
  const entrypoint = write("runtime/lib/bootstrap-development-dependencies.sh", bootstrap, 0o755)
  const sourceEntrypoint = write("runtime/source/scripts/bootstrap-development-dependencies.sh", bootstrap, 0o755)
  const marker = write("runtime/.managed-by-trellage-router", "trellage-router-v3\n")
  write(
    "runtime/source/scripts/build-profile-compiler.sh",
    '#!/bin/bash\nprintf "prepare\\0%s\\0%s\\0\\0" "$(cd -P -- "$(dirname -- "$0")/.." && pwd -P)" "$PWD" >>"$BOOTSTRAP_CALLS"\nexit "${PREPARE_STATUS:-0}"\n',
    0o755,
  )
  write(
    "bin/mise",
    '#!/bin/sh\nprintf "%s\\0" mise "$@" >>"$BOOTSTRAP_CALLS"\nprintf "\\0" >>"$BOOTSTRAP_CALLS"\n',
    0o755,
  )
  const invocations = () =>
    readFileSync(calls, "utf8")
      .split("\0\0")
      .filter(Boolean)
      .map((invocation) => invocation.split("\0"))
  const run = (script = entrypoint, argument = "--run", prepareStatus = "0") =>
    spawnSync("/bin/bash", [script, argument], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        BASH_ENV: "/dev/null",
        PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
        TRELLAGE_BOOTSTRAP_STATE_DIR: state,
        BOOTSTRAP_CALLS: calls,
        PREPARE_STATUS: prepareStatus,
      },
    })
  return {
    root,
    runtime,
    source,
    cwd,
    state,
    calls,
    entrypoint,
    sourceEntrypoint,
    marker,
    run,
    invocations,
  }
}

test("installed lib bootstrap prepares its complete source workspace without changing the caller cwd", () => {
  const f = fixture()
  const result = f.run()
  expect(result.error).toBeUndefined()
  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
  expect(f.invocations()).toEqual([
    ["prepare", f.source, f.cwd],
    ["mise", "where", "uv@latest"],
    ["mise", "exec", "uv@latest", "--", "uvx", "--offline", "yt-dlp", "--version"],
  ])
  expect(existsSync(path.join(f.state, "dependency-bootstrap.lock"))).toBe(false)
})

test("canonical source bootstrap does not require a surrounding router installation", () => {
  const f = fixture()
  rmSync(f.marker)
  const result = f.run(f.sourceEntrypoint)
  expect(result.status).toBe(0)
  expect(f.invocations()[0]).toEqual(["prepare", f.source, f.cwd])
})

test.each(["source", "source/scripts", "source/scripts/build-profile-compiler.sh", ".managed-by-trellage-router"])(
  "installed bootstrap refuses a redirected %s before preparation or locking",
  (relative) => {
    const f = fixture()
    const target = path.join(f.runtime, relative)
    const redirected = path.join(f.root, "redirected")
    renameSync(target, redirected)
    symlinkSync(redirected, target)
    const result = f.run()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("bootstrap")
    expect(existsSync(f.calls)).toBe(false)
    expect(existsSync(f.state)).toBe(false)
  },
)

test.each(["trellage-router-v2\n", "unrelated\n"])("installed bootstrap refuses the non-v3 marker %j", (marker) => {
  const f = fixture()
  writeFileSync(f.marker, marker)
  const result = f.run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("router")
  expect(existsSync(f.calls)).toBe(false)
  expect(existsSync(f.state)).toBe(false)
})

test("installed bootstrap refuses a missing source preparer without skipping dependency preparation", () => {
  const f = fixture()
  rmSync(path.join(f.source, "scripts/build-profile-compiler.sh"))
  const result = f.run()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("build-profile-compiler.sh")
  expect(existsSync(f.calls)).toBe(false)
  expect(existsSync(f.state)).toBe(false)
})

test("explicit source preparation failure preserves its status and releases the bootstrap lock", () => {
  const f = fixture()
  const result = f.run(f.entrypoint, "--run", "23")
  expect(result.status).toBe(23)
  expect(f.invocations()).toEqual([["prepare", f.source, f.cwd]])
  expect(existsSync(path.join(f.state, "dependency-bootstrap.lock"))).toBe(false)
})

test("background bootstrap rejects automatic installation without preparation or locking", () => {
  const f = fixture()
  const result = f.run(f.entrypoint, "--background")
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("Automatic dependency installation is disabled")
  expect(existsSync(f.calls)).toBe(false)
  expect(existsSync(f.state)).toBe(false)
})
