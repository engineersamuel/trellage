import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { captureFocusedConversation } from "../src/conversation-capture.ts"
import { readConversationRequest, writeConversationRequest } from "../src/conversation-state.ts"
import { captureFixture } from "./fixtures.ts"

const cli = new URL(import.meta.resolve("@trellage/conversation-source/cli"))
const syntheticCli = new URL("./fixtures/source-cli.ts", import.meta.url)

const fixtureTree = async (root: string) => {
  const entries = (await readdir(root, { recursive: true })).sort()
  return Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry)
    const status = await lstat(target)
    return { path: entry, mode: status.mode, content: status.isFile() ? await readFile(target) : null }
  }))
}

test("package runners disable the transpiler cache before starting Bun", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  for (const name of ["check", "test"]) {
    assert.match(manifest.scripts[name], /^BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file /)
  }
})

test("public CLI resolves to Bun source and import has no capture or entrypoint effects", async (t) => {
  const fixture = await captureFixture(t)
  assert.match(cli.pathname, /\/src\/cli\.ts$/)
  assert.doesNotMatch(cli.pathname, /\/pocs\/|\/dist\//)
  await writeFile(path.join(fixture.root, ".env"), "CONVERSATION_TEST_ENV_SENTINEL=must-not-load\n", { mode: 0o600 })
  await writeFile(path.join(fixture.root, "bunfig.toml"), 'preload = ["./untrusted-preload.ts"]\n', { mode: 0o600 })
  await writeFile(path.join(fixture.root, "untrusted-preload.ts"), 'throw new Error("Untrusted fixture config loaded")\n')
  assert.equal(fixture.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, "0")
  const before = await fixtureTree(fixture.root)
  const result = spawnSync(bunExecutable(), bunArguments(new URL("./fixtures/import-cli.ts", import.meta.url)), {
    cwd: fixture.root, env: fixture.env, encoding: "utf8", timeout: 5_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), { imported: true, bun: "1.3.3", environmentLoaded: false })
  assert.deepEqual(await fixtureTree(fixture.root), before)
})

test("invalid request checks preserve the metadata protocol and hide path diagnostics", async (t) => {
  const fixture = await captureFixture(t)
  const result = spawnSync(bunExecutable(), bunArguments(cli, [
    "--check", path.join(fixture.root, "EXCLUDED_SYNTHETIC_REQUEST"),
  ]), { cwd: fixture.cwd, env: fixture.env, encoding: "utf8", timeout: 5_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, "")
  assert.deepEqual(JSON.parse(result.stdout), {
    sameSource: false, revision: "0".repeat(64), advanced: false,
    message: "The private conversation request or original source could not be verified.",
  })
  assert.doesNotMatch(result.stdout, /EXCLUDED_SYNTHETIC_REQUEST/)
})

for (const operation of ["--check", "--refresh"]) {
  test(`${operation} never includes capture failure details in its protocol`, async (t) => {
    const fixture = await captureFixture(t)
    const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
    const requestPath = await writeConversationRequest(fixture.root, snapshot)
    const result = spawnSync(bunExecutable(), bunArguments(syntheticCli, [operation, requestPath, "failure"]), {
      cwd: fixture.cwd, env: fixture.env, encoding: "utf8", timeout: 5_000,
    })
    assert.equal(result.status, operation === "--check" ? 0 : 1, result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /EXCLUDED_SYNTHETIC_MODEL_AND_INPUT/)
    if (operation === "--check") {
      const response = JSON.parse(result.stdout)
      assert.equal(response.sameSource, false)
      assert.equal(response.revision, snapshot.revision)
      assert.equal(result.stderr, "")
    } else {
      assert.equal(result.stdout, "")
      assert.equal(result.stderr, "The focused conversation could not be refreshed. No other source was selected.\n")
    }
  })

  for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`${operation} ${signal} waits for cleanup and preserves its owned request`, async (t) => {
      const fixture = await captureFixture(t)
      const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
      const requestPath = await writeConversationRequest(fixture.root, snapshot)
      const child = spawn(bunExecutable(), bunArguments(syntheticCli, [operation, requestPath, "wait"]), {
        cwd: fixture.cwd, env: fixture.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk })
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk })
      const finished = once(child, "close")
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      })
      const [ready] = await Promise.race([
        once(child, "message"),
        finished.then(() => { throw new Error(`Synthetic CLI exited before capture: ${stderr}`) }),
      ])
      assert.equal(ready, "capture-ready")
      child.kill(signal)
      assert.deepEqual(await finished, [code, null])
      assert.equal(stdout, "")
      assert.equal(stderr, "")
      assert.equal(await readFile(path.join(fixture.root, "cleanup.receipt"), "utf8"), "clean")
      assert.deepEqual(await readConversationRequest(fixture.root, requestPath), snapshot)
    })
  }
}
