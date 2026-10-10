import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  PRIME_DEFAULT_MODEL,
  PRIME_PROFILE_MARKER,
  ensurePrimeRuntime,
  primeLaunchCommand,
  primeRuntimePaths,
  validatePrimeRuntime,
} from "../../src/native-run/prime-runtime.ts"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-prime-runtime-"))
  roots.push(root)
  const environment = { HOME: root, PATH: process.env.PATH ?? "" }
  const paths = primeRuntimePaths({ environment })
  const packageRoot = path.join(paths.npmPrefix, "lib", "node_modules", "prime-agent")
  await mkdir(path.join(packageRoot, "dist", "bundle"), { recursive: true })
  await mkdir(path.join(packageRoot, "node_modules"), { recursive: true })
  await writeFile(path.join(packageRoot, "package.json"), '{"name":"prime-agent","version":"0.7.0"}\n')
  await writeFile(path.join(packageRoot, "dist", "bundle", "cli.js"), "console.error('0.7.0')\n")
  await writeFile(paths.receiptFile, "0.7.0\n")
  const identity = {
    schemaVersion: 1,
    primeVersion: "0.7.0",
    runtimeHashAlgorithm: "sha256",
    runtimeHash: "a".repeat(64),
    kernelSpecVersion: 1,
  }
  await writeFile(paths.runtimeIdentityFile, `${JSON.stringify(identity)}\n`)
  await mkdir(path.join(paths.profileHome, "extensions"), { recursive: true })
  await writeFile(paths.profileMarker, `${PRIME_PROFILE_MARKER}\n`)
  await mkdir(path.join(paths.kernelVenv, "bin"), { recursive: true })
  await writeFile(paths.kernelPython, "#!/bin/sh\n")
  await chmod(paths.kernelPython, 0o755)
  await writeFile(paths.kernelIdentityStamp, `${JSON.stringify(identity)}\n`)
  return { environment, paths }
}

test("validates lifecycle state, reconciles the daemon stamp, and builds the canonical node launch", async () => {
  const { environment, paths } = await fixture()
  const state = await ensurePrimeRuntime(
    { environment },
    { verifyCliVersion: false, daemonIsListening: async () => false },
  )
  const stamp = JSON.parse(await readFile(paths.daemonEnvStamp, "utf8"))
  expect(stamp.kernelPython).toBe(state.paths.kernelPython)
  expect(stamp.kernelVenv).toBe(state.paths.kernelVenv)

  const launch = primeLaunchCommand(state, {
    model: "claude-opus-5",
    appendSystemPrompt: "Open with evidence.",
    codingAgentDirectory: "/tmp/prime-generation",
    forwardedArgs: ["-p", "Reply exactly OK"],
  })
  expect(launch.command).toBe("node")
  expect(launch.args).toEqual([
    state.cli,
    "--provider",
    "copilot-proxy-rs",
    "--model",
    PRIME_DEFAULT_MODEL,
    "--offline",
    "--autonomous",
    "--daemon-socket",
    state.paths.daemonSocket,
    "--append-system-prompt",
    "Open with evidence.",
    "-p",
    "Reply exactly OK",
  ])
  expect(launch.env).toMatchObject({
    PRIME_AGENT_CODING_AGENT_DIR: "/tmp/prime-generation",
    PRIME_AGENT_KERNEL_PYTHON: state.paths.kernelPython,
    PRIME_AGENT_KERNEL_VENV: state.paths.kernelVenv,
    ANTHROPIC_API_KEY: null,
    OPENAI_API_KEY: null,
    GH_TOKEN: null,
  })
})

test("rejects a runtime identity mismatch before creating a launch", async () => {
  const { environment, paths } = await fixture()
  await writeFile(
    paths.kernelIdentityStamp,
    `${JSON.stringify({
      schemaVersion: 1,
      primeVersion: "0.8.0",
      runtimeHashAlgorithm: "sha256",
      runtimeHash: "b".repeat(64),
      kernelSpecVersion: 1,
    })}\n`,
  )
  await expect(validatePrimeRuntime({ environment }, { verifyCliVersion: false })).rejects.toThrow(
    /kernel identity differs/,
  )
})
