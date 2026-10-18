import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { caseAt, productSize } from "./exhaustive-cli-domains.ts"
import { loadRunBehaviorDomain } from "./exhaustive-run-behavior.ts"
import { expectedRun, expectedRunOutcome } from "./exhaustive-run-oracle.ts"

const integer = (value: unknown): bigint => {
  assert(typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value), "noncanonical range integer")
  return BigInt(value)
}

export const verifyRunBehaviorReports = async (reports: Record<string, unknown>[], allowPartial = false) => {
  assert(reports.length > 0, "no reports supplied")
  const { run, sourceHashes, domainHash } = await loadRunBehaviorDomain()
  const {
    config: { native: catalog },
  } = await readTrellageConfig({
    environment: { TRELLAGE_CONFIG: fileURLToPath(new URL("../config.toml", import.meta.url)) },
  })
  const total = productSize(run)
  const ranges = reports
    .map((report) => {
      assert.equal(report.scope, "run-full-domain-lifecycle", "wrong scope")
      assert.equal(report.domainHash, domainHash, "stale domains")
      assert.deepEqual(report.sourceHashes, sourceHashes, "source identity mismatch")
      assert.equal(integer(report.totalCases), total, "wrong product")
      const start = integer(report.start),
        end = integer(report.endExclusive)
      assert(start < end && end <= total, "invalid range")
      assert.equal(integer(report.executedCases), end - start, "wrong executed count")
      assert.equal(integer(report.distinctTupleIds), end - start, "wrong distinct count")
      assert.equal(report.complete, start === 0n && end === total, "false completion claim")
      const digest = createHash("sha256"),
        outcomes: Record<string, number> = {}
      for (let index = start; index < end; index++) {
        digest.update(`${index}\n`)
        const outcome = expectedRunOutcome(expectedRun(caseAt(run, index)), catalog)
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
      }
      assert.equal(report.idSequenceSha256, digest.digest("hex"), "omitted or duplicate tuple")
      assert.deepEqual(report.outcomes, outcomes, "incorrect outcome counts")
      return { start, end }
    })
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  let cursor = 0n,
    covered = 0n,
    gap = false
  for (const range of ranges) {
    assert(range.start >= cursor, "overlapping or duplicate ranges")
    if (range.start !== cursor) gap = true
    covered += range.end - range.start
    cursor = range.end
  }
  const complete = !gap && cursor === total
  assert(allowPartial || complete, "incomplete full run product")
  assert.deepEqual((await loadRunBehaviorDomain()).sourceHashes, sourceHashes, "source changed during verification")
  return {
    scope: "run-full-domain-lifecycle",
    complete,
    independentlyVerified: true,
    totalCases: total.toString(),
    executedCases: covered.toString(),
    ranges: ranges.length,
    sourceHashes,
    domainHash,
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "allow-partial": { type: "boolean", default: false } },
  })
  const reports = await Promise.all(positionals.map(async (name) => JSON.parse(await readFile(name, "utf8"))))
  console.log(JSON.stringify(await verifyRunBehaviorReports(reports, values["allow-partial"]), null, 2))
}
