import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { adapters, parseRunArguments, runNative, NativeRunError } from "@trellage/runtime/native-run"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

const supportedCleanHarnesses = new Set(["claude", "codex", "copilot", "pi"])

for (const harness of Object.keys(adapters)) {
  for (const dryRun of [false, true]) for (const plan of [false, true])
    for (const noAlways of [false, true]) for (const requireIsolation of [false, true]) {
    test(`${harness} clean ${JSON.stringify({ dryRun, plan, noAlways, requireIsolation })}`, async () => {
      const world = await createCleanRunWorld()
      try {
        const options = parseRunArguments([harness, "clean", ...(dryRun ? ["--dry-run"] : []),
          ...(plan ? ["--plan"] : []), ...(noAlways ? ["--no-always"] : []),
          ...(requireIsolation ? ["--require-proven-isolation"] : []), "--", "fixture prompt"])
        if (!supportedCleanHarnesses.has(harness)) {
          try {
            await runNative(options, world.dependencies)
            throw new Error("unsupported clean run was accepted")
          } catch (error) {
            expect(error).toBeInstanceOf(NativeRunError)
            expect((error as NativeRunError).code).toBe("unsupported")
          }
          expect(world.launches).toHaveLength(0)
          expect(await world.discoveries()).toEqual([])
        } else {
          expect(await runNative(options, world.dependencies)).toBe(dryRun ? 0 : 23)
          expect(world.launches).toHaveLength(dryRun ? 0 : 1)
          if (dryRun) expect(await world.discoveries()).toEqual([])
          else {
            const { launch, cwd } = world.launches[0]!
            expect(cwd).toBe(world.work)
            expect(launch.args.at(-1)).toBe("fixture prompt")
            const history = JSON.parse(await readFile(path.join(world.paths.state, "selections.json"), "utf8"))
            expect(history.global).toEqual({ harness, profiles: ["clean"] })
            if (harness === "codex") {
              expect(launch.args).toContain('skills.config=[{path="/fixture/unselected/SKILL.md",enabled=false}]')
              expect(await world.discoveries()).toContainEqual({ method: "skills/list" })
            } else if (harness === "copilot") {
              expect(launch.args).toContain("--disable-mcp-server")
              expect(launch.args).toContain("fixture-server")
              const home = launch.env.COPILOT_HOME
              expect(typeof home).toBe("string")
              const settings = JSON.parse(await readFile(path.join(home!, "settings.json"), "utf8"))
              expect(settings.disabledSkills).toEqual(["unselected-fixture"])
              expect(settings.memory).toBe(false)
            } else expect(await world.discoveries()).toEqual([])
          }
        }
        expect(world.unexpected).toEqual([])
      } finally { await world.close() }
    })
  }
}

test("the discovery executable rejects model-execution commands and unknown RPC methods", async () => {
  const world = await createCleanRunWorld()
  try {
    const environment = world.dependencies.environment!
    const executable = environment.TRELLAGE_CODEX_BIN!
    for (const [args, input] of [
      [["exec", "fixture prompt"], ""],
      [["app-server"], JSON.stringify({ id: 7, method: "turn/start" }) + "\n"],
    ] as [string[], string][]) {
      const result = spawnSync(executable, args, { env: environment, input, encoding: "utf8", timeout: 5000 })
      expect(result.status).toBe(97)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("Unexpected discovery command\n")
    }
  } finally { await world.close() }
})
