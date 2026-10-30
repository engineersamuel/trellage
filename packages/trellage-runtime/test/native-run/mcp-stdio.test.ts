import { afterEach, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expandMcpEnvironment } from "../../src/native-run/mcp-stdio.ts"

const wrapperPath = fileURLToPath(new URL("../../src/native-run/mcp-stdio.ts", import.meta.url))
const roots: string[] = []
const wrappers: ChildProcessWithoutNullStreams[] = []
const groups: number[] = []
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

afterEach(async () => {
  for (const wrapper of wrappers.splice(0)) wrapper.kill("SIGKILL")
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      /* Already reaped. */
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const fixture = async (source: string, env: Record<string, string> = {}, launchEnv: NodeJS.ProcessEnv = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trx-mcp-stdio-"))
  roots.push(root)
  const childPath = path.join(root, "server.ts")
  await writeFile(childPath, source)
  const specification = path.join(root, "spec.json")
  await writeFile(
    specification,
    JSON.stringify({
      type: "stdio",
      enabled: true,
      command: process.execPath,
      args: [childPath, root],
      env,
    }),
  )
  const wrapper = spawn(process.execPath, [wrapperPath, specification], {
    stdio: "pipe",
    env: { ...process.env, ...launchEnv },
  })
  wrappers.push(wrapper)
  let stdout = ""
  let stderr = ""
  wrapper.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  wrapper.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    wrapper.once("error", reject)
    wrapper.once("close", resolve)
  })
  return { root, wrapper, exited, output: () => ({ stdout, stderr }) }
}

const waitForPid = async (root: string, file: string, group = false): Promise<number> => {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await readFile(path.join(root, file), "utf8").catch(() => "")
    if (value) {
      const pid = Number(value)
      if (group) groups.push(pid)
      return pid
    }
    await pause(10)
  }
  throw new Error(`fixture did not create ${file}`)
}

const expectStopped = async (pid: number): Promise<void> => {
  // Reparented zombies on minimal Linux test hosts are dead, but PID 0 probes
  // still succeed until init reaps them. Do not mistake that for a live server.
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).stdout.trim()
    if (!state || state.startsWith("Z")) return
    await pause(10)
  }
  throw new Error("MCP child survived wrapper shutdown")
}

test("stdio aliases capture original values without restoring foreign authentication globally", async () => {
  expect(expandMcpEnvironment("${GH_TOKEN}", { GH_TOKEN: "rewritten", TRX_MCP_ENV_GH_TOKEN: "captured" }, true)).toBe(
    "captured",
  )
  expect(expandMcpEnvironment("${KEY}", { KEY: "legacy" }, true)).toBe("legacy")
  const run = await fixture(
    `
console.log(JSON.stringify({ key: process.env.CONFIGURED_KEY, foreign: process.env.GH_TOKEN ?? null }));
process.stdin.on("data", chunk => process.stdout.write(chunk));
process.stdin.on("end", () => process.exit(0));
`,
    { CONFIGURED_KEY: "${GH_TOKEN}" },
    { GH_TOKEN: undefined, TRX_MCP_ENV_GH_TOKEN: "fixture-only-token" },
  )
  const protocol = '{"jsonrpc":"2.0","method":"initialize"}\n'
  run.wrapper.stdin.end(protocol)
  expect(await run.exited).toBe(0)
  expect(run.output()).toEqual({
    stdout: '{"key":"fixture-only-token","foreign":null}\n' + protocol,
    stderr: "",
  })
})

test("stdin EOF bounds shutdown even when the configured server ignores EOF and TERM", async () => {
  const run = await fixture(`
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
process.stdin.resume();
process.stdin.on("end", () => {});
setInterval(() => {}, 1000);
writeFileSync(process.argv[2] + "/pid", String(process.pid));
`)
  const pid = await waitForPid(run.root, "pid", true)
  const started = Date.now()
  run.wrapper.stdin.end()
  await run.exited
  expect(Date.now() - started).toBeLessThan(1800)
  await expectStopped(pid)
  expect(run.output().stderr).toBe("")
})

test("TERM kills a TERM-ignoring server and its descendants before the SDK hard-kill deadline", async () => {
  const run = await fixture(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); require("node:fs").writeFileSync(process.argv[1], String(process.pid))', process.argv[2] + "/descendant"], { stdio: "inherit" });
writeFileSync(process.argv[2] + "/pid", String(process.pid));
`)
  const pid = await waitForPid(run.root, "pid", true)
  const descendant = await waitForPid(run.root, "descendant")
  const started = Date.now()
  run.wrapper.kill("SIGTERM")
  await run.exited
  expect(Date.now() - started).toBeLessThan(1800)
  await expectStopped(pid)
  await expectStopped(descendant)
  expect(run.output().stderr).toBe("")
})

test("a normally exiting group leader cannot leave its MCP descendant running", async () => {
  const run = await fixture(`
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); require("node:fs").writeFileSync(process.argv[1], String(process.pid))', process.argv[2] + "/descendant"], { stdio: "inherit" });
writeFileSync(process.argv[2] + "/pid", String(process.pid));
const timer = setInterval(() => { if (existsSync(process.argv[2] + "/descendant")) { clearInterval(timer); process.exit(0); } }, 10);
`)
  await waitForPid(run.root, "pid", true)
  const descendant = await waitForPid(run.root, "descendant")
  expect(await run.exited).toBe(0)
  await expectStopped(descendant)
  expect(run.output().stderr).toBe("")
})
