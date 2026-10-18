import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { exhaustiveDomains } from "./domains.ts"
import { matrixSize } from "./matrix.ts"
import { captureSourceIdentity } from "./source-identity.ts"
import { assertCompleteReceipt } from "./completion.ts"

if (process.env.TRELLAGE_TEST_OFFLINE !== "1") throw Error("Use make test-exhaustive for enforced offline execution")
if (process.argv.length !== 2) throw Error("Full exhaustive execution accepts no range or skip arguments")
const root = path.resolve(import.meta.dir, "../..")
const identity = captureSourceIdentity(root)
const declaration = await exhaustiveDomains(root)
await mkdir(path.join(root, ".test-performance"), { recursive: true })
const directory = await mkdtemp(path.join(root, ".test-performance/exhaustive-"))
console.log(`Exhaustive evidence: ${directory}`)
const receipts: Record<string, unknown> = {}
let child: ReturnType<typeof Bun.spawn> | undefined
let cancellation: string | undefined
const interrupt = (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => {
  cancellation = signal
  child?.kill(signal)
}
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
for (const signal of signals) process.on(signal, interrupt)
const run = async (argv: string[]) => {
  identity.assertUnchanged()
  if (cancellation) throw Error(`Interrupted by ${cancellation}`)
  child = Bun.spawn(argv, { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" })
  const status = await child.exited
  child = undefined
  if (status !== 0 || cancellation) throw Error(`Exhaustive child failed (${status}): ${argv.join(" ")}`)
  identity.assertUnchanged()
}
const publish = async (status: string, failure?: string) => {
  const output = path.join(directory, "result.json")
  await writeFile(
    `${output}.tmp`,
    JSON.stringify(
      {
        status,
        completeDeclaredMatrices: status === "passed",
        sourceIdentity: identity.sha256,
        domainAudit:
          "Pending final global, syntax and process-context inventory audit; declared-product completion alone does not establish task C2",
        declared: Object.fromEntries(
          Object.entries(declaration.matrices).map(([name, domains]) => [name, matrixSize(domains).toString()]),
        ),
        receipts,
        failure,
        cancellation,
      },
      null,
      2,
    ) + "\n",
  )
  await rename(`${output}.tmp`, output)
}
await publish("running")
try {
  await run(["python3", "tests/exhaustive/router-help-processes.py"])
  await run([process.execPath, "tests/exhaustive/run-selector-regression.ts", "--all-terminal-widths"])
  await run([process.execPath, "tests/exhaustive/guide-process-regression.ts", "--all-terminal-widths"])
  await run([process.execPath, "tests/exhaustive/controlling-input-regression.ts"])
  await run([process.execPath, "tests/exhaustive/guide-stdin-regression.ts", "--process-all"])
  await run([process.execPath, "tests/exhaustive/guide-request-overrides.ts"])
  await run([process.execPath, "tests/exhaustive/guide-request-context.ts"])
  await run([process.execPath, "tests/exhaustive/guide-request-fields-regression.ts", "--all-goals"])
  for (const command of ["run", "guide"] as const) {
    const output = path.join(directory, `${command}.json`)
    await run([process.execPath, `tests/exhaustive/${command}-executor.ts`, "--output", output])
    const receipt: unknown = JSON.parse(await readFile(output, "utf8"))
    assertCompleteReceipt(receipt, matrixSize(declaration.matrices[command]), identity.sha256)
    receipts[command] = receipt
    await publish("running")
  }
  identity.assertUnchanged()
  await publish("passed")
} catch (error) {
  await publish(cancellation ? "interrupted" : "failed", error instanceof Error ? error.stack : String(error))
  throw error
} finally {
  for (const signal of signals) process.off(signal, interrupt)
}
