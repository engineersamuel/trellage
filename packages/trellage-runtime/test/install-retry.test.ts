import { describe, expect, test } from "bun:test"
import { isFrozenLockfileFailure, retryInstall } from "../src/install-retry.ts"

describe("retryInstall", () => {
  test("recognizes Bun frozen-lockfile failures as deterministic", () => {
    expect(isFrozenLockfileFailure("error: lockfile had changes, but lockfile is frozen")).toBe(true)
    expect(isFrozenLockfileFailure("error: failed to download terminal-size@4.0.1: HTTP 4xx")).toBe(false)
  })

  test("retries a transient failure and preserves bounded backoff", async () => {
    let attempts = 0
    const waits: number[] = []
    const retries: number[] = []
    await retryInstall(
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error("transient")
      },
      {
        onRetry: (_error, nextAttempt) => retries.push(nextAttempt),
        wait: async (milliseconds) => {
          waits.push(milliseconds)
        },
      },
    )
    expect(attempts).toBe(2)
    expect(retries).toEqual([2])
    expect(waits).toEqual([1_000])
  })

  test("stops after the configured attempt limit", async () => {
    let attempts = 0
    const waits: number[] = []
    await expect(
      retryInstall(
        async () => {
          attempts += 1
          throw new Error("unavailable")
        },
        {
          wait: async (milliseconds) => {
            waits.push(milliseconds)
          },
        },
      ),
    ).rejects.toThrow("unavailable")
    expect(attempts).toBe(3)
    expect(waits).toEqual([1_000, 2_000])
  })

  test("does not retry deterministic failures", async () => {
    let attempts = 0
    await expect(
      retryInstall(
        async () => {
          attempts += 1
          throw new Error("lockfile is frozen")
        },
        {
          shouldRetry: () => false,
          wait: async () => {
            throw new Error("unexpected wait")
          },
        },
      ),
    ).rejects.toThrow("lockfile is frozen")
    expect(attempts).toBe(1)
  })

  test("stops during backoff when cancelled", async () => {
    const cancellation = new AbortController()
    let attempts = 0
    await expect(
      retryInstall(
        async () => {
          attempts += 1
          throw new Error("transient")
        },
        {
          signal: cancellation.signal,
          wait: async (_milliseconds, signal) => {
            cancellation.abort(new Error("cancelled"))
            signal?.throwIfAborted()
          },
        },
      ),
    ).rejects.toThrow("cancelled")
    expect(attempts).toBe(1)
  })
})
