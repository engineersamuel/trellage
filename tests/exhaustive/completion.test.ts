import { expect, test } from "bun:test"
import { assertCompleteReceipt } from "./completion.ts"

test("completion requires the exact full product, source identity, and outcome total", () => {
  const receipt = {
    status: "passed",
    declared: "12",
    executed: "12",
    range: { start: "0", end: "12" },
    fullRange: true,
    completeDeclaredMatrix: true,
    counts: { accepted: "4", rejected: "8" },
    sourceIdentity: { sha256: "expected" },
  }
  expect(() => assertCompleteReceipt(receipt, 12n, "expected")).not.toThrow()
  for (const patch of [
    { status: "range-passed" },
    { executed: "11" },
    { declared: "13" },
    { range: { start: "1", end: "12" } },
    { fullRange: false },
    { completeDeclaredMatrix: false },
    { sourceIdentity: { sha256: "changed" } },
    { counts: { accepted: "4", rejected: "7" } },
    { failure: { error: "hidden" } },
    { cancellation: "SIGTERM" },
    { counts: { accepted: "-1", rejected: "13" } },
  ])
    expect(() => assertCompleteReceipt({ ...receipt, ...patch }, 12n, "expected")).toThrow()
})
