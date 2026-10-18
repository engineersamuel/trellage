import { test, expect } from "bun:test"
import { createHash } from "node:crypto"
import { verifyCoverage } from "./verify-exhaustive-coverage.ts"

const expected = {
  scope: "guide-arguments-only",
  domainHash: "fixture-domain",
  sourceHashes: { parser: "fixture-source" },
  totalCases: 6n,
}
const report = (start: number, end: number) => ({
  ...expected,
  totalCases: "6",
  start: String(start),
  endExclusive: String(end),
  executedCases: String(end - start),
  distinctTupleIds: String(end - start),
  complete: start === 0 && end === 6,
  outcomes: { accepted: end - start },
  serviceOutcomes: { match: end - start },
  idSequenceSha256: createHash("sha256")
    .update(Array.from({ length: end - start }, (_, index) => `${start + index}\n`).join(""))
    .digest("hex"),
})

test("complete disordered shards cover each Cartesian ID exactly once", () => {
  expect(verifyCoverage([report(3, 6), report(0, 3)], expected)).toMatchObject({
    complete: true,
    executedCases: "6",
    distinctTupleIds: "6",
    ranges: 2,
  })
})
test("rejects missing, duplicated, overlapping and truncated ranges", () => {
  for (const shards of [
    [report(1, 6)],
    [report(0, 3), report(0, 3), report(3, 6)],
    [report(0, 4), report(3, 6)],
    [report(0, 5)],
  ])
    expect(() => verifyCoverage(shards, expected)).toThrow()
})
test("rejects drift and an incorrect Cartesian product", () => {
  for (const edit of [{ domainHash: "old" }, { sourceHashes: { parser: "old" } }, { totalCases: "7" }])
    expect(() => verifyCoverage([{ ...report(0, 6), ...edit }], expected)).toThrow()
})
test("rejects fabricated execution and completeness claims", () => {
  for (const edit of [
    { executedCases: "5" },
    { distinctTupleIds: "5" },
    { complete: false },
    { outcomes: { accepted: 5 } },
    { idSequenceSha256: "wrong" },
  ])
    expect(() => verifyCoverage([{ ...report(0, 6), ...edit }], expected)).toThrow()
})
test("rejects malformed and empty evidence", () => {
  expect(() => verifyCoverage([], expected)).toThrow()
  for (const start of [0, "00", "-1", "1.5", "1e3"])
    expect(() => verifyCoverage([{ ...report(0, 6), start }], expected)).toThrow()
})

test("preview and dispatch scopes count their own complete outcome sets", () => {
  for (const scope of ["basket-preview-arguments-only", "fork-preview-arguments-only", "guide-root-dispatch-only"]) {
    const contract = { ...expected, scope }
    const outcomes =
      scope === "guide-root-dispatch-only" ? { accepted: 1, rejected: 2, help: 3 } : { accepted: 2, rejected: 4 }
    expect(verifyCoverage([{ ...report(0, 6), scope, outcomes }], contract)).toMatchObject({ complete: true })
    expect(() =>
      verifyCoverage([{ ...report(0, 6), scope, outcomes: { accepted: 1, rejected: 2 } }], contract),
    ).toThrow()
  }
})

test("unknown scopes cannot pass using the Guide outcome fallback", () => {
  const scope = "unimplemented-command"
  expect(() => verifyCoverage([{ ...report(0, 6), scope }], { ...expected, scope })).toThrow(
    "unrecognized verification scope",
  )
})

test("Guide service counts reject missing, unknown, negative and incomplete classifications", () => {
  for (const serviceOutcomes of [undefined, {}, { unknown: 6 }, { match: -1, generation: 7 }, { match: 5 }])
    expect(() => verifyCoverage([{ ...report(0, 6), serviceOutcomes }], expected)).toThrow()
})
