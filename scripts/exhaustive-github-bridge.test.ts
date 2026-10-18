import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, lstat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { createGithubBridge } from "./exhaustive-github-bridge.ts"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

test("fixture GitHub bridge permits only guarded metadata lookup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-github-bridge-"))
  try {
    const fixture = await createGithubBridge(root, root, path.join(root, "bin"))
    for (const args of [[], ["auth", "login"], ["api", "/user"], [...fixture.args, "extra"]]) {
      const result = spawnSync(fixture.executable, args, { env: fixture.required, encoding: "utf8" })
      expect(result.status).toBe(97)
      expect(result.stdout).toBe("")
    }
    for (const key of Object.keys(fixture.required)) {
      const environment: NodeJS.ProcessEnv = { ...fixture.required }
      delete environment[key]
      const result = spawnSync(fixture.executable, fixture.args, { env: environment, encoding: "utf8" })
      expect(result.status).toBe(97)
      expect(result.stdout).toBe("")
    }
    expect(await fixture.calls()).toEqual([])
    const result = spawnSync(fixture.executable, fixture.args, { env: fixture.required, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("fixture-github-token\n")
    expect(await fixture.calls()).toEqual([{ args: fixture.args }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const harness of ["grok", "uji"]) {
  test(`${harness} builds a launch without reaching host credentials or a model`, async () => {
    const world = await createCleanRunWorld()
    try {
      const fixture = await createGithubBridge(world.root, world.home, path.join(world.root, "bin"))
      const result = await runNative(
        parseRunArguments([harness, "--no-always", "--continue", "--plan", "--", "fixture prompt"]),
        {
          ...world.dependencies,
          environment: {
            ...world.dependencies.environment,
            TRELLAGE_CONFIG: fileURLToPath(new URL("../config.toml", import.meta.url)),
          },
          refreshHarness: async () => undefined,
        },
      )
      expect(result).toBe(23)
      expect(world.launches).toHaveLength(1)
      expect(world.unexpected).toEqual([])
      expect(await world.discoveries()).toEqual([])
      expect(await fixture.calls()).toEqual(harness === "grok" ? [{ args: fixture.args }] : [])
      const launch = world.launches[0]!.launch
      if (harness === "grok") {
        expect(launch.args.slice(0, 6)).toEqual([
          "--sandbox",
          "trellage-workspace",
          "--permission-mode",
          "bypassPermissions",
          "--always-approve",
          "--trust",
        ])
        expect(launch.args.slice(-2)).toEqual(["--continue", "fixture prompt"])
        expect(launch.env.GH_TOKEN).toBe("fixture-github-token")
        await expect(lstat(path.join(launch.env.GROK_HOME!, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" })
      } else {
        expect(launch.args).toEqual(["resume", "fixture prompt"])
        expect(launch.env.TRX_UJI_PLAN).toBe("1")
        expect(launch.env.TRX_UJI_MODEL).toBe("copilot-proxy-rs/gpt-6-astra")
        expect(await readFile(path.join(launch.env.UJI_CONFIG_DIR!, "plugin", "trellage-tools.lua"), "utf8")).toBe(
          await readFile(
            fileURLToPath(new URL("../packages/trellage-runtime/src/native-run/uji-tools.lua", import.meta.url)),
            "utf8",
          ),
        )
      }
    } finally {
      await world.close()
    }
  })
}
