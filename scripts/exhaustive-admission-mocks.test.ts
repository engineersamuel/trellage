import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativePresetProfiles, parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { createAdmissionMocks } from "./exhaustive-admission-mocks.ts"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

test("lifecycle mocks return only declared metadata and reject model commands and malformed admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-admission-mocks-"))
  try {
    const fixture = await createAdmissionMocks(root, path.join(root, "inert-final-executable"))
    const valid: Record<string, string[][]> = {
      claude: ["default", "office", "office-charts"].map((profile) => ["_trx-admit", profile]),
      copilot: nativePresetProfiles("copilot").map((profile) => ["_trx-admit", profile]),
      agency: [["inventory", "trellage-azure", "--json"]],
      jcode: [["_trx-executable"]],
    }
    let invoked = 0
    for (const [role, binary] of Object.entries(fixture.binaries)) {
      const guard = `TRELLAGE_TRX_${role.toUpperCase()}_ADAPTER`
      const environment = { HOME: root, PATH: "/usr/bin:/bin", TRELLAGE_TEST_OFFLINE: "1", [guard]: "1" }
      for (const args of valid[role]!) {
        const result = spawnSync(binary, args, { env: environment, encoding: "utf8", timeout: 5000 })
        invoked++
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stderr).toBe("")
        if (role === "jcode") expect(result.stdout.trim()).toBe(fixture.executable)
        else expect(JSON.parse(result.stdout)).toEqual(fixture.payloads[role as keyof typeof fixture.payloads])
      }
      for (const args of [
        [],
        ["exec", "fixture prompt"],
        ["_trx-admit", "unknown-profile"],
        ["_trx-executable", "unexpected"],
        [...valid[role]![0]!, "unexpected"],
      ]) {
        const result = spawnSync(binary, args, { env: environment, encoding: "utf8", timeout: 5000 })
        invoked++
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(97)
        expect(result.stdout).toBe("")
        expect(result.stderr).toBe("Unexpected lifecycle metadata request\n")
      }
      if (role !== "agency") {
        const result = spawnSync(binary, valid[role]![0]!, {
          env: { ...environment, [guard]: "0" },
          encoding: "utf8",
          timeout: 5000,
        })
        invoked++
        expect(result.status).toBe(97)
        expect(result.stdout).toBe("")
      }
    }
    expect(await fixture.calls()).toHaveLength(invoked)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const harness of ["claude", "copilot", "agency", "jcode"]) {
  test(`${harness} reaches its real admission adapter and only the inert final spawner`, async () => {
    const world = await createCleanRunWorld()
    try {
      const fixture = await createAdmissionMocks(world.root, world.dependencies.environment!.TRELLAGE_CODEX_BIN!)
      const environment: NodeJS.ProcessEnv = {
        ...world.dependencies.environment,
        ...fixture.environment,
        TRELLAGE_CONFIG: fileURLToPath(new URL("../config.toml", import.meta.url)),
      }
      if (harness === "jcode") delete environment.TRELLAGE_JCODE_BIN
      const result = await runNative(parseRunArguments([harness, "--no-always", "--", "fixture prompt"]), {
        ...world.dependencies,
        environment,
        refreshHarness: async () => undefined,
      })
      expect(result).toBe(23)
      expect(world.launches).toHaveLength(1)
      expect(world.lines.some(line => line.startsWith("Resume     "))).toBe(harness === "claude" || harness === "copilot")
      expect(world.unexpected).toEqual([])
      expect(await world.discoveries()).toEqual([])
      const { launch, cwd } = world.launches[0]!
      expect(cwd).toBe(world.work)
      expect(launch.args).toContain("fixture prompt")
      if (harness === "claude") {
        expect(await fixture.calls()).toEqual([{ role: harness, args: ["_trx-admit", "default"] }])
        expect(launch.args.slice(-2)).toEqual(["--plugin-dir", fixture.plugin])
      } else if (harness === "copilot") {
        expect(await fixture.calls()).toEqual([{ role: harness, args: ["_trx-admit", "hve"] }])
        const home = launch.env.COPILOT_HOME!
        expect(await readlink(path.join(home, "installed-plugins"))).toBe(fixture.payloads.copilot.installedPlugins)
        const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"))
        expect(config.installedPlugins).toEqual(fixture.payloads.copilot.pluginRegistrations)
        expect(config.trustedFolders).toContain(world.work)
      } else if (harness === "agency") {
        expect(await fixture.calls()).toEqual([{ role: harness, args: ["inventory", "trellage-azure", "--json"] }])
        expect(launch.env.AZURE_TOKEN_CREDENTIALS).toBe("AzureCliCredential")
      } else {
        expect(await fixture.calls()).toEqual([{ role: harness, args: ["_trx-executable"] }])
        expect(launch.command).toBe(fixture.executable)
      }
    } finally {
      await world.close()
    }
  })
}
