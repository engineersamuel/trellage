import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"
import { createGithubBridge } from "./exhaustive-github-bridge.ts"
import { createFirstmateFixture } from "./exhaustive-firstmate.ts"

test("Firstmate transport rejects unexpected repositories and prerequisite tools cannot execute", async () => {
  const world = await createCleanRunWorld()
  try {
    const environment = world.dependencies.environment!
    const fixture = await createFirstmateFixture(world.root, environment)
    for (const executable of fixture.stubs) {
      const result = spawnSync(executable, ["fixture prompt"], { env: environment })
      expect(result.status).toBe(97)
      expect(result.stdout.toString()).toBe("")
    }
    await expect(fixture.syncRepository(world.work, fixture.repository, environment)).rejects.toThrow()
    await expect(
      fixture.syncRepository(fixture.directory, { ...fixture.repository, branch: "other" }, environment),
    ).rejects.toThrow()
    await expect(
      fixture.syncRepository(fixture.directory, fixture.repository, {
        ...environment,
        TRELLAGE_TEST_OFFLINE: undefined,
      }),
    ).rejects.toThrow()
    expect(fixture.calls).toEqual([])
    await expect(lstat(fixture.directory)).rejects.toMatchObject({ code: "ENOENT" })
  } finally {
    await world.close()
  }
})

test("Firstmate launches Pi workers then clears owned pins for Claude without launching a model", async () => {
  const world = await createCleanRunWorld()
  try {
    await createGithubBridge(world.root, world.home, path.join(world.root, "bin"))
    const environment = {
      ...world.dependencies.environment,
      TRELLAGE_CONFIG: fileURLToPath(new URL("../config.example.toml", import.meta.url)),
    }
    const fixture = await createFirstmateFixture(world.root, environment)
    for (const harness of ["pi", "claude"]) {
      const result = await runNative(parseRunArguments([harness, "firstmate", "--no-always", "--", "fixture prompt"]), {
        ...world.dependencies,
        environment,
        syncRepository: fixture.syncRepository,
        refreshHarness: async () => undefined,
      })
      expect(result).toBe(23)
      const { launch, cwd } = world.launches.at(-1)!
      expect(cwd).toBe(fixture.directory)
      expect(launch.args.at(-1)).toBe("fixture prompt")
      const generation = launch.env[harness === "pi" ? "PI_CODING_AGENT_DIR" : "CLAUDE_CONFIG_DIR"]!
      expect((await lstat(path.join(generation, ".trellage-workers"))).isFile()).toBe(true)
      const pin = path.join(fixture.directory, "config/pi-account")
      const dispatch = path.join(fixture.directory, "config/crew-dispatch.json")
      if (harness === "pi") {
        const provider = launch.args[launch.args.indexOf("--provider") + 1]!
        const model = launch.args[launch.args.indexOf("--model") + 1]!
        expect(await readFile(pin, "utf8")).toBe(`${generation}\n${provider}\n`)
        expect(JSON.parse(await readFile(dispatch, "utf8"))).toEqual({
          rules: [],
          default: {
            harness: "pi",
            model: `${provider}/${model}`,
            effort: "medium",
            why: "Written by trx run pi firstmate",
          },
        })
      } else {
        await expect(lstat(pin)).rejects.toMatchObject({ code: "ENOENT" })
        await expect(lstat(dispatch)).rejects.toMatchObject({ code: "ENOENT" })
        const settings = JSON.parse(await readFile(path.join(generation, "settings.json"), "utf8"))
        expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8080")
        expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe("trellage-local-proxy")
      }
    }
    expect(fixture.calls).toEqual([fixture.directory, fixture.directory])
    expect(world.launches).toHaveLength(2)
    expect(world.unexpected).toEqual([])
    expect(await world.discoveries()).toEqual([])
  } finally {
    await world.close()
  }
}, 120000)

test("Firstmate dry runs skip synchronization; strict admission preserves each harness isolation contract", async () => {
  const world = await createCleanRunWorld()
  try {
    await createGithubBridge(world.root, world.home, path.join(world.root, "bin"))
    const environment = {
      ...world.dependencies.environment,
      TRELLAGE_CONFIG: fileURLToPath(new URL("../config.example.toml", import.meta.url)),
    }
    const fixture = await createFirstmateFixture(world.root, environment)
    for (const harness of ["pi", "claude"]) {
      for (const dry of [true, false]) {
        const before = fixture.calls.length
        const launches = world.launches.length
        const result = runNative(
          parseRunArguments([
            harness,
            "firstmate",
            "--no-always",
            "--require-proven-isolation",
            ...(dry ? ["--dry-run"] : []),
          ]),
          {
            ...world.dependencies,
            environment,
            syncRepository: fixture.syncRepository,
            refreshHarness: async () => undefined,
          },
        )
        if (!dry && harness === "claude") await expect(result).rejects.toMatchObject({ code: "isolation" })
        else expect(await result).toBe(dry ? 0 : 23)
        expect(fixture.calls.length - before).toBe(dry ? 0 : 1)
        expect(world.launches.length - launches).toBe(!dry && harness === "pi" ? 1 : 0)
      }
    }
    expect(world.unexpected).toEqual([])
  } finally {
    await world.close()
  }
}, 120000)
