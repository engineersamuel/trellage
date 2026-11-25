import { describe, expect, test } from "bun:test"
import { freePortBlock, TEST_PORT_BLOCK, testPortNote } from "../src/testPorts.ts"

// A fake probe: the hook runs tests with network denied, so no test opens a socket.
const busyPorts = (busy: number[]) => async (port: number) => !busy.includes(port)

describe("test ports", () => {
  test("returns an aligned block in range whose ports are all free", async () => {
    const base = await freePortBlock(TEST_PORT_BLOCK, () => 0.25, busyPorts([]))
    expect(base).toBe(37_500)
    expect(base % TEST_PORT_BLOCK).toBe(0)
  })

  test("skips a block with a port in use", async () => {
    const picks = [0, 1 / 3000]
    const base = await freePortBlock(TEST_PORT_BLOCK, () => picks.shift() ?? 0.5, busyPorts([30_003]))
    expect(base).toBe(30_010)
  })

  test("never throws: when no probe succeeds it still returns a block", async () => {
    expect(
      await freePortBlock(
        TEST_PORT_BLOCK,
        () => 0,
        async () => false,
      ),
    ).toBe(30_000)
  })

  test("the note names the range and forbids doc ports", () => {
    const n = testPortNote(41_230)
    expect(n).toContain("41230-41239")
    expect(n).toContain("18080")
  })
})
