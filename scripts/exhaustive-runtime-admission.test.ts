import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { access, mkdtemp, readFile, rm, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { createRuntimeAdmission } from "./exhaustive-runtime-admission.ts"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

test("runtime mocks reject model commands, missing guards, and incorrect lifecycle state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-runtime-admission-"))
  try {
    const fixture = await createRuntimeAdmission(root, root, path.join(root, "inert-model"))
    const environment = { HOME: root, TRELLAGE_TEST_OFFLINE: "1", TRELLAGE_TRX_OMP_ADAPTER: "1" }
    for (const binary of Object.values(fixture.binaries)) {
      for (const args of [[], ["exec", "fixture prompt"], ["_trx-admit", "unknown"], ["setup", "default", "extra"]]) {
        const result = spawnSync(binary, args, { env: environment, encoding: "utf8" })
        expect(result.status).toBe(97)
        expect(result.stdout).toBe("")
      }
      expect(spawnSync(binary, [], { env: { HOME: root }, encoding: "utf8" }).status).toBe(97)
      for (const key of ["HOME", "TRELLAGE_TEST_OFFLINE"]) {
        const missing: NodeJS.ProcessEnv = { ...environment }
        delete missing[key]
        const args = binary === fixture.binaries.omp ? ["_trx-admit", "local"] : ["setup", "default"]
        const result = spawnSync(binary, args, { env: missing, encoding: "utf8" })
        expect(result.status).toBe(97)
        expect(result.stdout).toBe("")
      }
    }
    expect(
      spawnSync(fixture.binaries.omp!, ["_trx-admit", "default"], {
        env: { ...environment, TRELLAGE_TRX_OMP_ADAPTER: "0" },
      }).status,
    ).toBe(97)
    expect(await fixture.calls()).toEqual([])
    for (const profile of ["default", "local"]) {
      const result = spawnSync(fixture.binaries.omp!, ["_trx-admit", profile], { env: environment, encoding: "utf8" })
      expect(result.status).toBe(0)
      const metadata = JSON.parse(result.stdout)
      expect(metadata.ompProfile).toBe(profile === "default" ? "trellage-copilot-native" : "trellage-qwen-local")
      expect(metadata.copilotCredentialFile).toBe(profile === "default" ? fixture.credential : null)
      if (profile === "default") await unlink(fixture.credential)
    }
    expect(spawnSync(fixture.binaries.prime!, ["repair", "default"], { env: environment }).status).toBe(97)
    for (const action of ["setup", "repair"]) {
      expect(spawnSync(fixture.binaries.prime!, [action, "default"], { env: environment }).status).toBe(0)
    }
    const version = spawnSync(process.execPath, [fixture.cli, "--version"], { env: environment, encoding: "utf8" })
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe("0.7.0")
    for (const key of ["HOME", "TRELLAGE_TEST_OFFLINE"]) {
      const missing: NodeJS.ProcessEnv = { ...environment }
      delete missing[key]
      const result = spawnSync(process.execPath, [fixture.cli, "--version"], { env: missing, encoding: "utf8" })
      expect(result.status).toBe(97)
      expect(result.stdout).toBe("")
    }
    for (const args of [[], ["exec", "fixture prompt"], ["--version", "extra"]]) {
      const result = spawnSync(process.execPath, [fixture.cli, ...args], { env: environment, encoding: "utf8" })
      expect(result.status).toBe(97)
      expect(result.stdout).toBe("")
    }
    expect(spawnSync(fixture.prime.kernelPython, ["-c", "fixture prompt"], { env: environment }).status).toBe(97)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const harness of ["omp", "prime"]) {
  test(`${harness} uses real admission/runtime validation and an inert final spawner`, async () => {
    const world = await createCleanRunWorld()
    try {
      const fixture = await createRuntimeAdmission(
        world.root,
        world.home,
        world.dependencies.environment!.TRELLAGE_CODEX_BIN!,
      )
      const environment = {
        ...world.dependencies.environment,
        ...fixture.environment,
        TRELLAGE_CONFIG: fileURLToPath(new URL("../config.toml", import.meta.url)),
      }
      for (let turn = 0; turn < 2; turn++) {
        expect(
          await runNative(parseRunArguments([harness, "--no-always", "--", "fixture prompt"]), {
            ...world.dependencies,
            environment,
            refreshHarness: async () => undefined,
          }),
        ).toBe(23)
        const launch = world.launches.at(-1)!.launch
        expect(launch.args.at(-1)).toBe("fixture prompt")
        if (harness === "omp") {
          expect(launch.command).toBe(fixture.executable)
          expect(launch.env.COPILOT_GITHUB_TOKEN).toBe("fixture-copilot-token")
          expect(launch.env.GH_TOKEN).toBeNull()
          await expect(access(fixture.credential)).rejects.toMatchObject({ code: "ENOENT" })
        } else {
          expect(launch.command).toBe(process.execPath)
          expect(launch.args[0]).toBe(fixture.cli)
          expect(launch.env.PRIME_AGENT_KERNEL_PYTHON).toBe(fixture.prime.kernelPython)
          expect(launch.env.COPILOT_GITHUB_TOKEN).toBeNull()
          const stamp = JSON.parse(await readFile(fixture.prime.daemonEnvStamp, "utf8"))
          expect(stamp.kernelPython).toBe(fixture.prime.kernelPython)
        }
      }
      expect(world.launches).toHaveLength(2)
      expect(world.unexpected).toEqual([])
      expect(await world.discoveries()).toEqual([])
      expect(await fixture.calls()).toEqual(
        harness === "omp"
          ? [
              { role: "omp", args: ["_trx-admit", "default"] },
              { role: "omp", args: ["_trx-admit", "default"] },
            ]
          : [
              { role: "prime", args: ["setup", "default"] },
              { role: "prime-version", args: ["--version"] },
              { role: "prime", args: ["repair", "default"] },
              { role: "prime-version", args: ["--version"] },
            ],
      )
    } finally {
      await world.close()
    }
  })
}
