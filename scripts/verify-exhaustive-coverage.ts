import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { coverageStride, assertCliSourcesUnchanged, loadCliDomains, productSize, type CliDomain } from "./exhaustive-cli-domains.ts"

import { assertPreviewSourcesUnchanged, loadPreviewDomains } from "./exhaustive-preview-domains.ts"

import { guideDispatchStride, loadGuideDispatchDomains } from "./exhaustive-guide-dispatch.ts"

interface ExpectedCoverage {
  readonly scope: string
  readonly domainHash: string
  readonly sourceHashes: Readonly<Record<string, string>>
  readonly totalCases: bigint
}

const integer = (value: unknown, label: string): bigint => {
  assert(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value),
    `${label} must be a canonical nonnegative integer`,
  )
  return BigInt(value)
}
const record = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "coverage report must be an object")
  return value as Record<string, unknown>
}

export const verifyCoverage = (inputs: readonly unknown[], expected: ExpectedCoverage) => {
  assert(inputs.length > 0, "no coverage reports supplied")
  const reports = inputs
    .map(record)
    .map((report) => {
      assert.equal(report.scope, expected.scope, "wrong verification scope")
      assert.equal(report.domainHash, expected.domainHash, "stale or different finite domains")
      assert.deepEqual(report.sourceHashes, expected.sourceHashes, "production source drift")
      const total = integer(report.totalCases, "totalCases")
      const start = integer(report.start, "start")
      const end = integer(report.endExclusive, "endExclusive")
      const executed = integer(report.executedCases, "executedCases")
      assert.equal(total, expected.totalCases, "wrong Cartesian product")
      assert(start < end && end <= total, "range is outside the Cartesian product")
      const stride = report.stride === undefined ? 1n : integer(report.stride, "stride")
      if (stride !== 1n)
        assert.equal(stride, report.scope === "guide-root-dispatch-only" ? guideDispatchStride : coverageStride(total), "unsupported sample stride")
      assert.equal(executed, (end - start + stride - 1n) / stride, "executed count differs from range length")
      assert.equal(integer(report.distinctTupleIds, "distinctTupleIds"), executed, "tuple IDs are not distinct")
      assert.equal(report.complete, stride === 1n && start === 0n && end === total, "incorrect single-range completeness claim")
      const outcomes = record(report.outcomes)
      const keys = (
        {
          "run-arguments-and-adapter-inputs-only": ["parser-accepted", "parser-rejection"],
          "guide-arguments-only": ["accepted", "GuideArgsError", "GuideValidationError"],
          "basket-preview-arguments-only": ["accepted", "rejected"],
          "fork-preview-arguments-only": ["accepted", "rejected"],
          "guide-root-dispatch-only": ["accepted", "rejected", "help"],
        } as Record<string, readonly string[]>
      )[expected.scope]
      assert(keys, "unrecognized verification scope")
      let classified = 0n
      for (const key of keys) {
        const count = outcomes[key] ?? 0
        assert(typeof count === "number" && Number.isSafeInteger(count) && count >= 0, `invalid outcome count: ${key}`)
        classified += BigInt(count)
      }
      assert.equal(classified, executed, "not every executed tuple has a parser outcome")
      if (expected.scope === "guide-arguments-only") {
        const services = record(report.serviceOutcomes)
        const allowed = [
          "help",
          "non-json",
          "next-steps-preconditions",
          "next-steps-entry",
          "next-steps-assessment",
          "next-steps-preparation",
          "next-steps-launch",
          "review-target",
          "interactive-intent",
          "match",
          "generation",
          "unknown-profile",
          "ritual-print",
          "ritual-copy",
          "ritual-ui",
          "unknown-ritual",
        ]
        let serviced = 0
        for (const [key, count] of Object.entries(services)) {
          assert(allowed.includes(key), "unknown Guide service outcome")
          assert(typeof count === "number" && Number.isSafeInteger(count) && count >= 0, "invalid Guide service count")
          serviced += count
        }
        assert.equal(serviced, outcomes.accepted ?? 0, "accepted Guide tuples lack service classifications")
      }
      const digest = createHash("sha256")
      for (let id = start; id < end; id += stride) digest.update(`${id}\n`)
      assert.equal(report.idSequenceSha256, digest.digest("hex"), "tuple sequence does not match its range")
      return { start, end, executed }
    })
    .sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0))
  let cursor = 0n
  for (const range of reports) {
    assert.equal(range.start, cursor, range.start < cursor ? "duplicate or overlapping ranges" : "missing tuple range")
    cursor = range.end
  }
  assert.equal(cursor, expected.totalCases, "incomplete Cartesian coverage")
  return {
    scope: expected.scope,
    complete: true,
    domainHash: expected.domainHash,
    totalCases: expected.totalCases.toString(),
    executedCases: reports.reduce((sum, range) => sum + range.executed, 0n).toString(),
    distinctTupleIds: reports.reduce((sum, range) => sum + range.executed, 0n).toString(),
    ranges: reports.length,
    sourceHashes: expected.sourceHashes,
  }
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { command: { type: "string" } },
  })
  const command = values.command
  assert(
    command === "run" ||
      command === "guide" ||
      command === "basket" ||
      command === "fork" ||
      command === "guide-dispatch",
    "--command must be run, guide, basket, fork or guide-dispatch",
  )
  const preview = command === "basket" || command === "fork"
  let domains: readonly CliDomain[]
  let sourceHashes: Readonly<Record<string, string>>
  if (command === "guide-dispatch") ({ domains, sourceHashes } = await loadGuideDispatchDomains())
  else if (preview) {
    const manifest = await loadPreviewDomains()
    domains = manifest[command]
    sourceHashes = manifest.sourceHashes
  } else {
    const manifest = await loadCliDomains()
    domains = manifest[command]
    sourceHashes = manifest.sourceHashes
  }
  const key = command === "guide-dispatch" ? "guideDispatch" : command
  const domainHash = createHash("sha256")
    .update(JSON.stringify({ [key]: domains, sourceHashes }))
    .digest("hex")
  const inputs = await Promise.all(positionals.map(async (name) => JSON.parse(await readFile(name, "utf8"))))
  const report = verifyCoverage(inputs, {
    scope:
      command === "guide-dispatch"
        ? "guide-root-dispatch-only"
        : preview
          ? `${command}-preview-arguments-only`
          : command === "run"
            ? "run-arguments-and-adapter-inputs-only"
            : "guide-arguments-only",
    domainHash,
    sourceHashes,
    totalCases: productSize(domains),
  })
  await (preview ? assertPreviewSourcesUnchanged : assertCliSourcesUnchanged)(sourceHashes)
  console.log(JSON.stringify(report, null, 2))
}
