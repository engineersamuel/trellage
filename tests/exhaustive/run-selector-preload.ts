import assert from "node:assert/strict"
import { mock } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { installGuideModelFixture } from "./guide-model-fixture.ts"
import { nativeMatrixWorld } from "./native-world.ts"
import { createSelectionHistory, scopeKeysFor } from "../../packages/trellage-runtime/src/native-run/history.ts"
import { NativeRunError, resolveNativeRunPaths } from "../../packages/trellage-runtime/src/native-run/paths.ts"
import type { SelectorExpectation } from "./run-selector-process.ts"
import { expectedRunArgumentTail } from "./run-behavior-oracle.ts"

assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1")
const receipt = process.env.TRELLAGE_SELECTOR_RECEIPT
assert.ok(receipt && !existsSync(receipt), "A new selector audit receipt is required")
const fixture = await installGuideModelFixture()
const models = await import("../../packages/trellage-runtime/src/native-run/models.ts")
const loadCatalog = models.loadModelCatalog
mock.module("../../packages/trellage-runtime/src/native-run/models.ts", () => ({
  ...models,
  loadModelCatalog: (options: Parameters<typeof loadCatalog>[0]) =>
    loadCatalog({
      ...options,
      fetchImpl: async (url) =>
        fixture.audit.run("models.list", () => {
          assert.equal(url, "http://127.0.0.1:8080/v1/models")
          return Response.json({ data: [{ id: "gpt-6.1-sol" }] })
        }),
    }),
}))
const launchRequested = process.env.TRELLAGE_SELECTOR_ACTION === "launch"
let world: Awaited<ReturnType<typeof nativeMatrixWorld>> | undefined
let launch: { argv: readonly string[]; spawned: number; status: number } | undefined
let failure: string | undefined
process.on("exit", () => {
  try {
    fixture.audit.assertClean()
    if (launchRequested) assert.ok(launch, "Selector never completed the requested launch")
  } catch (error) {
    failure ??= error instanceof Error ? error.stack : String(error)
  }
  if (failure) process.exitCode = 2
  if (world) rmSync(world.root, { recursive: true, force: true })
  writeFileSync(receipt, JSON.stringify({ failure, calls: fixture.audit.snapshot(), entry: process.argv[1], launch }), {
    flag: "wx",
    mode: 0o600,
  })
})
if (launchRequested) {
  const root = path.resolve(import.meta.dir, "../..")
  world = await nativeMatrixWorld(root)
  const privateWorld = world
  const selection = { harness: "pi", profiles: ["clean"], model: "gpt-6.1-sol", effort: "high" }
  await createSelectionHistory(resolveNativeRunPaths({ environment: process.env })).record(
    await scopeKeysFor(process.cwd()),
    selection,
  )
  const runtime = await import("../../packages/trellage-runtime/src/native-run/run.ts")
  const runMain = runtime.main
  const extras: string[] = JSON.parse(process.env.TRELLAGE_SELECTOR_EXPECTED_ARGS ?? "[]")
  const expectation: SelectorExpectation | undefined = process.env.TRELLAGE_SELECTOR_EXPECTATION
    ? JSON.parse(process.env.TRELLAGE_SELECTOR_EXPECTATION)
    : undefined
  mock.module("../../packages/trellage-runtime/src/native-run/run.ts", () => ({
    ...runtime,
    main: async (argv: readonly string[]) => {
      let spawned = 0
      try {
        assert.deepEqual(argv, ["pi", "clean", "--model", "gpt-6.1-sol", "--effort", "high", ...extras])
        let parsed: ReturnType<typeof runtime.parseRunArguments> | undefined
        try {
          parsed = runtime.parseRunArguments(argv)
        } catch (error) {
          assert.ok(error instanceof NativeRunError)
          assert.equal(error.code, "usage")
          assert.equal(expectation?.rejection, "usage")
          assert.equal(expectation?.options, undefined)
        }
        if (parsed && expectation) assert.deepEqual(parsed, expectation.options)
        const dependencies: Parameters<typeof runtime.runNative>[1] = {
          ...privateWorld.dependencies,
          write: () => {},
          spawner: async (command, environment, cwd, onSpawn) => {
            assert.equal(expectation?.rejection, undefined, "Rejected cases must never launch")
            assert.equal(command.command, "pi")
            assert.equal(environment.HOME, privateWorld.root)
            assert.equal(cwd, root)
            assert.equal(command.args[command.args.indexOf("--model") + 1], parsed?.model)
            assert.equal(command.args[command.args.indexOf("--thinking") + 1], parsed?.effort)
            assert.ok(parsed)
            const tail = expectedRunArgumentTail(parsed.harness, parsed.resume, parsed.forwardedArgs)
            if (tail.length) assert.deepEqual(command.args.slice(-tail.length), tail)
            assert.ok(command.args.includes("--no-skills"))
            spawned++
            onSpawn(undefined)
            return 17
          },
        }
        if (parsed && expectation?.rejection) {
          await assert.rejects(
            runtime.runNative(parsed, dependencies),
            (error: unknown) => error instanceof NativeRunError && error.code === expectation.rejection,
          )
        }
        const status = await runMain(argv, dependencies)
        const dryRun = parsed?.dryRun
        assert.equal(status, expectation?.rejection ? (expectation.rejection === "usage" ? 2 : 1) : dryRun ? 0 : 17)
        assert.equal(spawned, expectation?.rejection || dryRun ? 0 : 1)
        launch = { argv, spawned, status }
        return status
      } catch (error) {
        failure = error instanceof Error ? error.stack : String(error)
        throw error
      } finally {
        await privateWorld.dispose()
        world = undefined
      }
    },
  }))
}
