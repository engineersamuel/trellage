import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { freePortBlock, TEST_PORT_BLOCK, testPortNote } from "../src/testPorts.ts"

describe("test ports", () => {
  test("returns a block whose ports are all free", async () => {
    const base = await freePortBlock()
    expect(base).toBeGreaterThanOrEqual(30_000)
    expect(base % TEST_PORT_BLOCK).toBe(0)
    const s = createServer()
    await new Promise<void>((r) => s.listen(base + TEST_PORT_BLOCK - 1, "127.0.0.1", () => r()))
    s.close()
  })

  test("skips a block with a port in use", async () => {
    const busy = createServer()
    await new Promise<void>((r) => busy.listen(30_003, "127.0.0.1", () => r()))
    // First pick is the busy block 30000-30009, the second is 30010.
    const picks = [0, 1 / 3000]
    const base = await freePortBlock(TEST_PORT_BLOCK, () => picks.shift() ?? 0.5)
    busy.close()
    expect(base).toBe(30_010)
  })

  test("the note names the range and forbids doc ports", () => {
    const n = testPortNote(41_230)
    expect(n).toContain("41230-41239")
    expect(n).toContain("18080")
  })
})
