import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { adapters, parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { createRunWorld } from "./exhaustive-run-world.ts"
import { assertRunLaunch } from "./exhaustive-run-launch.ts"

test.each([undefined, "claude-opus-5.5", "gpt-6-astra"])(
  "Claude clean launch oracle accepts model %s",
  async (model) => {
    const world = await createRunWorld("claude")
    try {
      const options = parseRunArguments(["claude", "clean", ...(model ? ["--model", model] : [])])
      expect(await runNative(options, world.dependencies)).toBe(23)
      const generation = world.lines.find((line) => line.startsWith("Generation  "))!.slice("Generation  ".length)
      const manifest = JSON.parse(await readFile(path.join(generation, "manifest.json"), "utf8"))
      await assertRunLaunch(options, world, generation, manifest, "Claude clean model mapping")
      expect(world.unexpected).toEqual([])
    } finally {
      await world.close()
    }
  },
  120000,
)

for (const harness of Object.keys(adapters).sort())
  test(`${harness}: launch oracle rejects substituted model and lost forwarded value`, async () => {
    const world = await createRunWorld(harness)
    try {
      const model = harness === "uji" ? "copilot-proxy-rs/fixture" : "模型"
      const options = parseRunArguments([harness, "--no-always", "--model", model, "--", "space value", "", "*"])
      expect(await runNative(options, world.dependencies)).toBe(23)
      const generation = world.lines.find((line) => line.startsWith("Generation  "))!.slice("Generation  ".length)
      const manifest = JSON.parse(await readFile(path.join(generation, "manifest.json"), "utf8"))
      const check = () => assertRunLaunch(options, world, generation, manifest, "mutation")
      await check()
      const original = world.launches[0]!.launch
      world.launches[0]!.launch = { ...original, args: original.args.slice(0, -1) }
      await expect(check()).rejects.toThrow()
      const key = (
        { fx: "FX_MODEL", headlong: "SHELLM_MODEL", jcode: "JCODE_MODEL", uji: "TRX_UJI_MODEL" } as Record<
          string,
          string
        >
      )[harness]
      if (key) world.launches[0]!.launch = { ...original, env: { ...original.env, [key]: "substituted" } }
      else {
        const args = [...original.args],
          flag = harness === "codex" ? "-m" : "--model"
        expect(args.indexOf(flag)).toBeGreaterThanOrEqual(0)
        args[args.indexOf(flag) + 1] = "substituted"
        world.launches[0]!.launch = { ...original, args }
      }
      await expect(check()).rejects.toThrow()
      world.launches[0]!.launch = original
      await check()
      expect(world.unexpected).toEqual([])
    } finally {
      await world.close()
    }
  }, 120000)
