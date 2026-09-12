import { spawnSync } from "node:child_process"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { expect, it } from "vitest"

it("executes the test worker with Bun", () => {
  expect(process.versions.bun).toBe("1.3.3")
})

it("executes the requested source file and preserves arguments through the public Bun helper", () => {
  const result = spawnSync(
    bunExecutable(),
    bunArguments(new URL("./fixtures/bun-runtime-sentinel.ts", import.meta.url), [
      "--",
      "fixture argument",
      "--sentinel-option",
    ]),
    { encoding: "utf8", timeout: 5000 },
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toBe(
    '{"sentinel":"TRELLAGE_BUN_SOURCE_EXECUTED","args":["--","fixture argument","--sentinel-option"]}\n',
  )
})

it("keeps Node available to external programs without a Bun shim", () => {
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      'process.stdout.write(JSON.stringify({bun: process.versions.bun ?? null, node: process.versions.node}))',
    ],
    { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 },
  )
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe("")
  const runtime: unknown = JSON.parse(result.stdout)
  expect(runtime).toEqual({ bun: null, node: expect.stringMatching(/^\d+\.\d+\.\d+$/u) })
})
