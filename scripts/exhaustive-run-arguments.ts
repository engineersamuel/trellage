import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { adapters, adapterFor, assertEffort, assertForwardedArgs, NativeRunError, parseRunArguments,
  type RunOptions } from "@trellage/runtime/native-run"
import { assertCliSourcesUnchanged, caseAt, loadCliDomains, productSize } from "./exhaustive-cli-domains.ts"

import { renderArgumentForm } from "./exhaustive-argument-syntax.ts"

import { expectedRun } from "./exhaustive-run-oracle.ts"

const { values } = parseArgs({ options: {
  start: { type: "string", default: "0" }, count: { type: "string" }, output: { type: "string" },
} })
assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
const { run, sourceHashes } = await loadCliDomains()
const total = productSize(run)
const start = BigInt(values.start!)
const count = values.count === undefined ? total - start : BigInt(values.count)
assert(start >= 0n && count > 0n && start + count <= total, "requested range is outside the declared matrix")
const end = start + count
const domainHash = createHash("sha256").update(JSON.stringify({ run, sourceHashes })).digest("hex")
const outcomes: Record<string, number> = {}
const digest = createHash("sha256")
const started = Date.now()
const record = (outcome: string): void => { outcomes[outcome] = (outcomes[outcome] ?? 0) + 1 }
for (let index = start; index < end; index++) {
  const selected = caseAt(run, index)
  const argv = renderArgumentForm("run", selected)
  const expected = expectedRun(selected)
  const caseId = `${domainHash}:${index}`
  let result: RunOptions | undefined
  let error: unknown
  try { result = parseRunArguments(argv) } catch (caught) { error = caught }
  if (expected === undefined) {
    assert(error instanceof NativeRunError, `${caseId}: expected parser rejection`)
    assert.equal(error.code, "usage", caseId)
    record("parser-rejection")
  } else {
    assert.equal(error, undefined, caseId)
    assert.deepEqual(result, expected, caseId)
    record("parser-accepted")
    const adapter = adapters[expected.harness]
    if (!adapter) {
      assert.throws(() => adapterFor(expected.harness), NativeRunError, caseId)
      record("unsupported-harness")
    } else {
      assert.equal(adapterFor(expected.harness), adapter, caseId)
      const effortAccepted = expected.effort === undefined || adapter.efforts.includes(expected.effort)
      if (effortAccepted) assert.doesNotThrow(() => assertEffort(adapter, expected.effort), caseId)
      else assert.throws(() => assertEffort(adapter, expected.effort), NativeRunError, caseId)
      const forwardedAccepted = !expected.forwardedArgs.some(argument =>
        adapter.managedFlags.some(flag => argument === flag || argument.startsWith(`${flag}=`)))
      if (forwardedAccepted) assert.doesNotThrow(() => assertForwardedArgs(adapter, expected.forwardedArgs), caseId)
      else assert.throws(() => assertForwardedArgs(adapter, expected.forwardedArgs), NativeRunError, caseId)
      record(effortAccepted && forwardedAccepted ? "adapter-input-accepted" : "adapter-input-rejected")
    }
  }
  digest.update(`${index}\n`)
  if ((index - start + 1n) % 100_000n === 0n)
    console.error(JSON.stringify({ scope: "run-arguments", checked: (index - start + 1n).toString(), total: total.toString() }))
}
await assertCliSourcesUnchanged(sourceHashes)
const report = {
  scope: "run-arguments-and-adapter-inputs-only", complete: start === 0n && end === total,
  domainHash, sourceHashes, totalCases: total.toString(), start: start.toString(), endExclusive: end.toString(),
  executedCases: count.toString(), distinctTupleIds: count.toString(), idSequenceSha256: digest.digest("hex"),
  elapsedSeconds: (Date.now() - started) / 1000, outcomes,
  remainingVerification: ["profile composition and harness launch", "remaining draft domains", "process-sensitive behavior"],
}
if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify(report, null, 2))
