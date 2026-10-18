import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { captureSourceIdentity } from "./source-identity.ts"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { nativeMatrixWorld } from "./native-world.ts"
import { guideWorld } from "./guide-world.ts"
import { verifyRootHelp } from "./root-help.ts"
import { observeRunDispatch, expectedRunDispatch } from "./run-dispatch.ts"
import { verifyRunSelectorProcess, type SelectorExpectation } from "./run-selector-process.ts"
import { installHostFixtures } from "./host-fixtures.ts"
import { expectedRunRejection, expectedRunArgumentTail } from "./run-behavior-oracle.ts"
import { exhaustiveDomains } from "./domains.ts"
import { cartesianCases, matrixSize } from "./matrix.ts"
import { runParserExpectation } from "./run-parser-oracle.ts"
import { parseRunArguments, runNative } from "../../packages/trellage-runtime/src/native-run/run.ts"
import { NativeRunError } from "../../packages/trellage-runtime/src/native-run/paths.ts"

const root = path.resolve(import.meta.dir, "../..")
if (process.env.TRELLAGE_TEST_OFFLINE !== "1")
  throw Error("Run through scripts/test-offline.py to enforce offline execution")
const sourceIdentity = captureSourceIdentity(root)
const declaration = await exhaustiveDomains(root)
const domains = declaration.matrices.run
const size = matrixSize(domains)
const argumentsByName = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]!,
    argument = process.argv[index + 1]
  if (!["--start", "--end", "--output"].includes(name) || argumentsByName.has(name) || argument === undefined)
    throw Error("Expected unique --start ORDINAL, --end ORDINAL, or --output FILE arguments")
  argumentsByName.set(name, argument)
}
const value = (name: string, fallback: string) => argumentsByName.get(name) ?? fallback
const start = BigInt(value("--start", "0")),
  end = BigInt(value("--end", size.toString()))
if (start < 0n || end <= start || end > size) throw Error("Expected a nonempty range within the declared matrix")
const output = value("--output", path.join(root, ".test-performance/run-cartesian-results.json"))
if (existsSync(output)) throw Error(`Output already exists: ${output}`)
await mkdir(path.dirname(output), { recursive: true })
const counts: Record<string, number> = {}
const selectorContexts = { terminalCancel: 0, terminalLaunch: 0, detached: 0 }
let executed = 0n
let failure: unknown
let cancellation: string | undefined
let world: Awaited<ReturnType<typeof nativeMatrixWorld>> | undefined
let dispatchWorld: Awaited<ReturnType<typeof guideWorld>> | undefined
const interrupt = (signal: string) => {
  cancellation = signal
}
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
for (const signal of signals) process.on(signal, interrupt)
const publish = async (status: string) => {
  try {
    sourceIdentity.assertUnchanged()
  } catch (error) {
    failure = { error: error instanceof Error ? error.stack : String(error), previousFailure: failure }
    status = "failed"
    process.exitCode = 1
  }
  const temporary = `${output}.${process.pid}.tmp`
  await writeFile(
    temporary,
    JSON.stringify(
      {
        status,
        scope:
          "Actual Bash dispatch and real runtime behavior for the selected Cartesian run range; selector cases include three-width cancellation/launch and detached rejection with a fixed Pi clean selection. Complete selector selection/global/syntax/process-context inventory remains a separate obligation",
        declared: size.toString(),
        range: { start: start.toString(), end: end.toString() },
        executed: executed.toString(),
        fullRange: start === 0n && end === size,
        completeDeclaredMatrix: status === "passed" && start === 0n && end === size,
        counts,
        selectorContexts,
        failure,
        cancellation,
        sourceHashes: declaration.inventory.hashes,
        sourceIdentity: { sha256: sourceIdentity.sha256, scope: sourceIdentity.scope },
        sourceRequestCounts: Object.fromEntries(world?.requests ?? []),
        hostTraceLimitBytes: 65536,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  )
  await rename(temporary, output)
}
await publish("running")
try {
  world = await nativeMatrixWorld(root)
  dispatchWorld = await guideWorld(root)
  const fixture = world
  await installHostFixtures(world.root, world.dependencies.environment!)
  for (const entry of cartesianCases("run", domains, { start, end })) {
    if (cancellation) throw Error(`Interrupted by ${cancellation}`)
    if (failure) throw Error("Cartesian execution already invalidated")
    const ordinal = start + executed
    if (entry.rootArgv.length) {
      await verifyRootHelp(dispatchWorld, "run", entry.rootArgv, entry.argv, ordinal)
      counts["root-help"] = (counts["root-help"] ?? 0) + 1
    } else {
      const dispatch = await observeRunDispatch(dispatchWorld, entry.argv, ordinal)
      assert.deepEqual(dispatch, expectedRunDispatch(entry.argv, declaration.inventory.harnesses), entry.id)
      if (dispatch.kind === "rejected") {
        counts["router-rejected"] = (counts["router-rejected"] ?? 0) + 1
      } else if (dispatch.kind === "selector") {
        const selected = runParserExpectation(domains, {
          ...(dispatch.argv.length ? entry.values : {}),
          harness: "pi",
          profiles: "clean",
        })
        let expectation: SelectorExpectation
        if ("rejection" in selected) expectation = { rejection: "usage" }
        else {
          const options = {
            ...selected.expected,
            model: selected.expected.model ?? "gpt-6.1-sol",
            effort: selected.expected.effort ?? "high",
          }
          const rejection = expectedRunRejection(options, declaration.inventory)
          expectation = { options, ...(rejection ? { rejection } : {}) }
        }
        for (const width of [69, 70, 100]) {
          await verifyRunSelectorProcess(dispatchWorld, entry.argv, ordinal, width, "cancel", undefined, dispatch.argv)
          selectorContexts.terminalCancel++
          await verifyRunSelectorProcess(
            dispatchWorld,
            entry.argv,
            ordinal,
            width,
            "launch",
            expectation,
            dispatch.argv,
          )
          selectorContexts.terminalLaunch++
        }
        await verifyRunSelectorProcess(dispatchWorld, entry.argv, ordinal)
        selectorContexts.detached++
        const outcome = `selector-${expectation.rejection ?? (expectation.options?.dryRun ? "dry-run" : "launched")}`
        counts[outcome] = (counts[outcome] ?? 0) + 1
      } else if (dispatch.argv.length === 1 && dispatch.argv[0] === "--help") {
        counts.help = (counts.help ?? 0) + 1
      } else {
        const oracle = runParserExpectation(domains, entry.values)
        let expected = "rejection" in oracle ? "usage" : undefined
        let spawned = 0
        const description: string[] = []
        try {
          const parsed = parseRunArguments(entry.argv)
          assert.ok("expected" in oracle, `${entry.id}: parser accepted invalid arguments`)
          assert.deepEqual(parsed, oracle.expected)
          expected = expectedRunRejection(parsed, declaration.inventory)
          const status = await runNative(parsed, {
            ...world.dependencies,
            write: (line) => description.push(line),
            prerequisiteIo: {
              write: () => {},
              install: async () => {
                throw Error("Unexpected prerequisite installation")
              },
            },
            syncRepository: async (directory, repository) => {
              assert.deepEqual(repository, { url: "https://github.com/kunchenguid/firstmate.git", branch: "main" })
              assert.equal(directory, path.join(fixture.root, ".local/share/trellage/firstmate"))
              await mkdir(directory, { recursive: true })
            },
            spawner: async (launch, environment, cwd, onSpawn) => {
              assert.equal(environment.HOME, fixture.root)
              assert.equal(
                cwd,
                parsed.profiles.includes("firstmate")
                  ? path.join(fixture.root, ".local/share/trellage/firstmate")
                  : root,
              )
              assert.ok(launch.command.length > 0)
              if (parsed.model !== undefined) {
                const modelVariable = (
                  { fx: "FX_MODEL", headlong: "SHELLM_MODEL", jcode: "JCODE_MODEL", uji: "TRX_UJI_MODEL" } as Record<
                    string,
                    string
                  >
                )[parsed.harness]
                if (modelVariable) assert.equal(launch.env[modelVariable], parsed.model)
                else {
                  const modelFlag = parsed.harness === "codex" ? "-m" : "--model"
                  const index = launch.args.indexOf(modelFlag)
                  assert.ok(index >= 0, `${parsed.harness}: missing model option`)
                  const selected =
                    parsed.harness === "omp" && !parsed.model.includes("/")
                      ? `github-copilot/${parsed.model}`
                      : parsed.model
                  assert.equal(launch.args[index + 1], selected)
                }
              }
              const tail = expectedRunArgumentTail(parsed.harness, parsed.resume, parsed.forwardedArgs)
              if (tail.length)
                assert.deepEqual(
                  launch.args.slice(-tail.length),
                  tail,
                  `${entry.id}: wrong resume or forwarded arguments`,
                )
              spawned++
              onSpawn(undefined)
              return 0
            },
          })
          assert.equal(expected, undefined, `${entry.id}: accepted forbidden combination`)
          assert.equal(status, 0)
          assert.equal(spawned, parsed.dryRun ? 0 : 1)
          const clean = parsed.profiles.includes("clean")
          const always =
            clean || parsed.noAlways
              ? []
              : Object.entries(declaration.inventory.catalog.profiles)
                  .filter(
                    ([, profile]) =>
                      profile.always && (!profile.harnesses || profile.harnesses.includes(parsed.harness)),
                  )
                  .map(([name]) => name)
                  .sort()
          assert.ok(
            description.includes(`Always-on   ${always.join(", ") || "none"}`),
            `${entry.id}: wrong always-profile selection`,
          )
          const presets: readonly string[] | undefined =
            declaration.inventory.presets[parsed.harness as keyof typeof declaration.inventory.presets]
          const profiles = parsed.profiles.map((profile) =>
            Object.hasOwn(declaration.inventory.catalog.profiles, profile)
              ? profile
              : presets?.includes(profile)
                ? `preset-${parsed.harness}-${profile}`
                : profile,
          )
          const skills = new Set<string>()
          for (const profile of clean ? [] : [...new Set([...always, ...profiles])]) {
            for (const selection of declaration.inventory.catalog.profiles[profile]!.skills) {
              const source = declaration.inventory.catalog.sources[selection.source]!
              for (const name of selection.names) {
                if (name !== "*") skills.add(name)
                else
                  for (const file of fixture.inventory.find((item) => item.repository === source.repository)!.files) {
                    const match = /^skills\/([^/]+)\/SKILL.md$/.exec(file)
                    if (match && !source.exclude?.includes(match[1]!)) skills.add(match[1]!)
                  }
              }
            }
          }
          for (const selector of parsed.skills ?? [])
            skills.add(selector.slice(selector.indexOf(":") + 1).toLowerCase())
          const reported = description.flatMap((line) => {
            const match = /^(?:Skills {6}| {12})([^ ]+)  /.exec(line)
            return match ? [match[1]!] : []
          })
          assert.deepEqual(reported.sort(), [...skills].sort(), `${entry.id}: wrong composed skill set`)
          const outcome = parsed.dryRun ? "dry-run" : "launched"
          counts[outcome] = (counts[outcome] ?? 0) + 1
        } catch (error) {
          if (expected && error instanceof NativeRunError && error.code === expected) {
            assert.equal(spawned, 0)
            counts[expected] = (counts[expected] ?? 0) + 1
          } else {
            failure = {
              id: entry.id,
              values: entry.values,
              argv: entry.argv,
              expected: expected ?? "accepted",
              error: error instanceof Error ? error.stack : String(error),
            }
            throw error
          }
        }
      }
    }
    executed++
    if (executed % 1000n === 0n) await Bun.sleep(0)
    if (executed % 100000n === 0n) {
      await publish("running")
      console.log(`run: ${executed}/${end - start} cases`)
    }
  }
} catch (error) {
  failure ??= { error: error instanceof Error ? error.stack : String(error) }
  throw error
} finally {
  try {
    await publish(
      cancellation
        ? "interrupted"
        : failure || executed !== end - start
          ? "failed"
          : start === 0n && end === size
            ? "passed"
            : "range-passed",
    )
  } finally {
    await world?.dispose()
    await dispatchWorld?.dispose()
    for (const signal of signals) process.off(signal, interrupt)
  }
}
if (!failure) console.log(`Run Cartesian range passed: ${executed} cases`)
