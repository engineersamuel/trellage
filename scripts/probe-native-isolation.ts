#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { promisify } from "node:util"

const execFilePromise = promisify(execFile)
const selectedName = "trx-selected-sentinel"
const repositoryName = "trx-repository-sentinel"
const reloadName = "trx-reload-sentinel"
const sentinels = new Set([selectedName, repositoryName, reloadName])

enum Harness {
  Copilot = "copilot",
  Codex = "codex",
}

interface Fixture {
  readonly cwd: string
  readonly managed: string
  readonly environment: NodeJS.ProcessEnv
}

interface Observation {
  readonly stage: string
  readonly enabledSentinels: readonly string[]
  readonly selectedOnly: boolean
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (cause: Error) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const writeSkill = async (directory: string, name: string): Promise<void> => {
  const target = path.join(directory, name)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await writeFile(
    path.join(target, "SKILL.md"),
    `---\nname: ${name}\ndescription: Native discovery fixture.\n---\nFixture only.\n`,
    { mode: 0o600 },
  )
}

const capture = async (executable: string, args: readonly string[], fixture: Fixture): Promise<string> => {
  const { stdout } = await execFilePromise(executable, args, {
    cwd: fixture.cwd,
    env: fixture.environment,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  })
  return stdout
}

const observation = (stage: string, skills: unknown): Observation => {
  if (!Array.isArray(skills)) throw new Error("Discovery did not return a skill array")
  const enabled: string[] = []
  for (const skill of skills) {
    if (!isRecord(skill) || typeof skill.name !== "string" || typeof skill.enabled !== "boolean") {
      throw new Error("Discovery returned an invalid skill entry")
    }
    if (skill.enabled && sentinels.has(skill.name)) enabled.push(skill.name)
  }
  const names = [...new Set(enabled)].sort()
  return { stage, enabledSentinels: names, selectedOnly: names.length === 1 && names[0] === selectedName }
}

const probeCopilot = async (executable: string, fixture: Fixture): Promise<readonly Observation[]> => {
  const inspect = async (stage: string) =>
    observation(stage, JSON.parse(await capture(executable, ["--no-auto-update", "skill", "list", "--json"], fixture)))
  const startup = await inspect("startup")
  await capture(executable, ["--no-auto-update", "skill", "disable", "*"], fixture)
  const wildcard = await inspect("after-disabling-literal-star")
  await writeSkill(path.join(fixture.cwd, ".agents", "skills"), reloadName)
  const reload = await inspect("new-process-after-repository-change")
  return [startup, wildcard, reload]
}

const probeCodex = async (executable: string, fixture: Fixture): Promise<readonly Observation[]> => {
  const child = spawn(executable, ["app-server", "--stdio", "--enable", "skip_host_skill_discovery"], {
    cwd: fixture.cwd,
    env: fixture.environment,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  const pending = new Map<number, PendingRequest>()
  let nextId = 0
  let stderr = ""
  const rejectPending = (cause: Error) => {
    for (const request of pending.values()) request.reject(cause)
    pending.clear()
  }
  child.stderr.setEncoding("utf8").on("data", (text: string) => {
    stderr = (stderr + text).slice(-8192)
  })
  child.on("error", rejectPending)
  child.stdin.on("error", rejectPending)
  child.on("exit", (code) => rejectPending(new Error(`Codex discovery exited ${code}: ${stderr}`)))
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      rejectPending(new Error("Codex emitted an invalid JSON-RPC response"))
      return
    }
    if (!isRecord(message)) {
      rejectPending(new Error("Codex emitted an invalid JSON-RPC message"))
      return
    }
    if (typeof message.id !== "number") return
    const request = pending.get(message.id)
    if (request === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) request.reject(new Error("Codex rejected a discovery RPC request"))
    else request.resolve(message.result)
  })
  const call = (method: string, params: object): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Timed out waiting for Codex ${method}`))
      }, 15_000)
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        reject: (cause) => {
          clearTimeout(timer)
          reject(cause)
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  const inspect = async (stage: string): Promise<Observation> => {
    const result = await call("skills/list", { cwds: [fixture.cwd], forceReload: true })
    if (!isRecord(result) || !Array.isArray(result.data) || result.data.length !== 1) {
      throw new Error("Codex did not return one workspace discovery result")
    }
    const entry: unknown = result.data[0]
    if (!isRecord(entry) || !Array.isArray(entry.errors) || entry.errors.length !== 0) {
      throw new Error("Codex reported skill discovery errors")
    }
    return observation(stage, entry.skills)
  }
  try {
    await call("initialize", {
      clientInfo: { name: "trellage_isolation_probe", version: "1" },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`)
    const startup = await inspect("startup-with-skip-host-discovery")
    await writeSkill(path.join(fixture.cwd, ".agents", "skills"), reloadName)
    const reload = await inspect("force-reload-after-repository-change")
    await call("skills/extraRoots/set", { extraRoots: [path.join(fixture.managed, "skills")] })
    const extraRoots = await inspect("after-setting-explicit-extra-roots")
    return [startup, reload, extraRoots]
  } finally {
    child.stdin.end()
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
    await closed
    clearTimeout(timer)
    lines.close()
  }
}

const runProbe = async (harness: Harness, executable: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-isolation-probe-"))
  try {
    const home = path.join(root, "home")
    const managed = path.join(root, "managed")
    const cwd = path.join(root, "workspace")
    for (const directory of [home, managed, cwd]) await mkdir(directory, { mode: 0o700 })
    const fixture: Fixture = {
      cwd,
      managed,
      environment: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_STATE_HOME: path.join(home, ".state"),
        CODEX_HOME: managed,
        COPILOT_HOME: managed,
        COPILOT_AUTO_UPDATE: "false",
        COPILOT_OFFLINE: "true",
        COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:9/v1",
        COPILOT_PROVIDER_TYPE: "openai",
        COPILOT_MODEL: "gpt-4.1",
      },
    }
    await capture("git", ["init", "--quiet"], fixture)
    await writeSkill(path.join(cwd, ".agents", "skills"), repositoryName)
    await writeSkill(path.join(managed, "skills"), selectedName)
    await writeFile(path.join(cwd, "AGENTS.md"), "Repository engineering instructions must remain available.\n")
    await writeFile(path.join(managed, "config.json"), JSON.stringify({ trustedFolders: [cwd], autoUpdate: false }), {
      mode: 0o600,
    })
    await writeFile(
      path.join(managed, "config.toml"),
      `[analytics]\nenabled = false\n[feedback]\nenabled = false\n[features]\nplugins = false\nhooks = false\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`,
      { mode: 0o600 },
    )
    const versionArgs = harness === Harness.Copilot ? ["--no-auto-update", "--version"] : ["--version"]
    const version = (await capture(executable, versionArgs, fixture)).trim()
    const observations =
      harness === Harness.Copilot ? await probeCopilot(executable, fixture) : await probeCodex(executable, fixture)
    return {
      harness,
      version,
      scope: "Selected-only skill discovery; not full configuration isolation or model-turn verification.",
      observations,
      selectedOnly: observations.every((entry) => entry.selectedOnly),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  try {
    const [harness, executable, ...extra] = process.argv.slice(2)
    if (
      (harness !== Harness.Copilot && harness !== Harness.Codex) ||
      executable === undefined ||
      !path.isAbsolute(executable) ||
      extra.length !== 0
    ) {
      throw new Error("Usage: bun scripts/probe-native-isolation.ts copilot|codex /absolute/executable")
    }
    const result = await runProbe(harness, executable)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.exitCode = result.selectedOnly ? 0 : 1
  } catch (cause) {
    process.stderr.write(`Native isolation probe: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 2
  }
}
