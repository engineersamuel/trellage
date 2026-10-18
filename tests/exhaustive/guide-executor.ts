import { existsSync } from "node:fs"
import { captureSourceIdentity } from "./source-identity.ts"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { exhaustiveDomains } from "./domains.ts"
import { cartesianCases, matrixSize } from "./matrix.ts"
import { guideWorld } from "./guide-world.ts"
import { createGuideCaseVerifier } from "./guide-case.ts"
import { verifyRootHelp } from "./root-help.ts"

if (process.env.TRELLAGE_TEST_OFFLINE !== "1") throw Error("Run through scripts/test-offline.py")
const root = path.resolve(import.meta.dir, "../..")
const sourceIdentity = captureSourceIdentity(root)
const declaration = await exhaustiveDomains(root)
const domains = declaration.matrices.guide
const size = matrixSize(domains)
const argumentsByName = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]!,
    value = process.argv[index + 1]
  if (!["--start", "--end", "--output"].includes(name) || argumentsByName.has(name) || value === undefined)
    throw Error("Expected unique --start ORDINAL, --end ORDINAL, or --output FILE arguments")
  argumentsByName.set(name, value)
}
const start = BigInt(argumentsByName.get("--start") ?? "0")
const end = BigInt(argumentsByName.get("--end") ?? size.toString())
if (start < 0n || end <= start || end > size) throw Error("Expected a nonempty range within the declared matrix")
const output = argumentsByName.get("--output") ?? path.join(root, ".test-performance/guide-cartesian-results.json")
if (existsSync(output)) throw Error(`Output already exists: ${output}`)
await mkdir(path.dirname(output), { recursive: true })
const counts = new Map<string, bigint>()
let executed = 0n
let failure: unknown
let cancellation: string | undefined
let world: Awaited<ReturnType<typeof guideWorld>> | undefined
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
          "Declared guide argv product: real parsers and JSON services, real entrypoint/PTY acceptance and cancellation, seeded conversation and clipboard boundaries. Global/syntax/process-context domain audit remains a separate obligation.",
        declared: size.toString(),
        range: { start: start.toString(), end: end.toString() },
        executed: executed.toString(),
        fullRange: start === 0n && end === size,
        completeDeclaredMatrix: status === "passed" && start === 0n && end === size,
        counts: Object.fromEntries([...counts].map(([name, count]) => [name, count.toString()])),
        failure,
        cancellation,
        sourceHashes: declaration.inventory.hashes,
        sourceIdentity: { sha256: sourceIdentity.sha256, scope: sourceIdentity.scope },
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
  world = await guideWorld(root)
  let verify: Awaited<ReturnType<typeof createGuideCaseVerifier>> | undefined
  for (const entry of cartesianCases("guide", domains, { start, end })) {
    if (cancellation) throw Error(`Interrupted by ${cancellation}`)
    if (failure) throw Error("Cartesian execution already invalidated")
    try {
      let outcome: string
      if (entry.rootArgv.length) {
        await verifyRootHelp(world, "guide", entry.rootArgv, entry.argv, start + executed)
        outcome = "root-help"
      } else {
        verify ??= await createGuideCaseVerifier(world)
        outcome = await verify(entry, start + executed)
      }
      counts.set(outcome, (counts.get(outcome) ?? 0n) + 1n)
    } catch (error) {
      failure = {
        id: entry.id,
        values: entry.values,
        argv: entry.argv,
        error: error instanceof Error ? error.stack : String(error),
      }
      throw error
    }
    executed++
    if (executed % 1000n === 0n) await Bun.sleep(0)
    if (executed % 10000n === 0n) {
      await publish("running")
      console.log(`guide: ${executed}/${end - start} cases`)
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
    for (const signal of signals) process.off(signal, interrupt)
  }
}
if (!failure) console.log(`Guide Cartesian range passed: ${executed} cases`)
