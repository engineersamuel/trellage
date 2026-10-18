import assert from "node:assert/strict"

export function assertCompleteReceipt(value: unknown, size: bigint, source: string): void {
  assert.ok(value && typeof value === "object")
  const receipt = value as Record<string, unknown>
  assert.equal(receipt.status, "passed")
  assert.equal(receipt.declared, size.toString())
  assert.equal(receipt.executed, size.toString())
  assert.deepEqual(receipt.range, { start: "0", end: size.toString() })
  assert.equal(receipt.fullRange, true)
  assert.equal(receipt.completeDeclaredMatrix, true)
  assert.equal(receipt.failure, undefined)
  assert.equal(receipt.cancellation, undefined)
  assert.equal((receipt.sourceIdentity as { sha256?: unknown })?.sha256, source)
  assert.ok(receipt.counts && typeof receipt.counts === "object")
  let total = 0n
  for (const count of Object.values(receipt.counts)) {
    assert.ok(typeof count === "string" || (typeof count === "number" && Number.isSafeInteger(count)))
    assert.match(String(count), /^\d+$/)
    total += BigInt(count)
  }
  assert.equal(total, size)
}
