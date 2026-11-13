import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativePresetProfiles, parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { admit, createAdmissionMocks } from "./exhaustive-admission-mocks.ts"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

const valid: Record<string, string[][]> = {
  claude: ["default", "office", "office-charts"].map((profile) => ["_trx-admit", profile]),
  copilot: nativePresetProfiles("copilot").map((profile) => ["_trx-admit", profile]),
  agency: [["inventory", "trellage-azure", "--json"]],
  jcode: [["_trx-executable"]],
}
const guard = (role: string) => `TRELLAGE_TRX_${role.toUpperCase()}_ADAPTER`

test("lifecycle mocks return only declared metadata and reject model commands and malformed admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-admission-mocks-"))
  try {
    const { rules, payloads, executable } = await createAdmissionMocks(root, path.join(root, "inert-final-executable"))
    const refused = { status: 97, stdout: "", stderr: "Unexpected lifecycle metadata request\n" }
    for (const role of Object.keys(valid)) {
      const env = { [guard(role)]: "1" }
      const expected = role === "jcode" ? executable : JSON.stringify(payloads[role as keyof typeof payloads])
      for (const args of valid[role]!)
        expect(admit(rules, role, args, env)).toEqual({ status: 0, stdout: `${expected}\n`, stderr: "" })
      for (const args of [
        [],
        ["exec", "fixture prompt"],
        ["_trx-admit", "unknown-profile"],
        ["_trx-executable", "unexpected"],
        [...valid[role]![0]!, "unexpected"],
      ])
        expect([role, args, admit(rules, role, args, env)]).toEqual([role, args, refused])
      if (role !== "agency") expect(admit(rules, role, valid[role]![0]!, { [guard(role)]: "0" })).toEqual(refused)
    }
    expect(admit(rules, "codex", [], {})).toEqual(refused)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a mock binary runs admit() and logs every call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-admission-mocks-"))
  try {
    const fixture = await createAdmissionMocks(root, path.join(root, "inert-final-executable"))
    const env = { HOME: root, PATH: "/usr/bin:/bin", TRELLAGE_TEST_OFFLINE: "1", [guard("claude")]: "1" }
    const run = (args: string[]) =>
      spawnSync(fixture.binaries.claude!, args, { env, encoding: "utf8", timeout: 30_000 })
    const ok = run(["_trx-admit", "default"])
    expect([ok.status, JSON.parse(ok.stdout), ok.stderr]).toEqual([0, fixture.payloads.claude, ""])
    const model = run(["exec", "fixture prompt"])
    expect([model.status, model.stdout, model.stderr]).toEqual([97, "", "Unexpected lifecycle metadata request\n"])
    expect(await fixture.calls()).toEqual([
      { role: "claude", args: ["_trx-admit", "default"] },
      { role: "claude", args: ["exec", "fixture prompt"] },
    ])
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
        TRELLAGE_CONFIG: fileURLToPath(new URL("../config.example.toml", import.meta.url)),
      }
      if (harness === "jcode") delete environment.TRELLAGE_JCODE_BIN
      const result = await runNative(parseRunArguments([harness, "--no-always", "--", "fixture prompt"]), {
        ...world.dependencies,
        environment,
        refreshHarness: async () => undefined,
      })
      expect(result).toBe(23)
      expect(world.launches).toHaveLength(1)
      expect(world.lines.some((line) => line.startsWith("Resume     "))).toBe(
        harness === "claude" || harness === "copilot",
      )
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
