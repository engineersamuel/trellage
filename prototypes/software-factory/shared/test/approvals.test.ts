import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { HttpError, Decision, makeStore, toApprovals, type Approvals } from "../approvals.ts"

const row = (id: string, status: "pending" | "answered", createdAt: number) => ({ id, title: id, status, createdAt, options: ["Approve"] })
const decodeAll = Schema.decodeUnknownSync(Schema.Array(Decision))

describe("shared/approvals", () => {
  test("old stored rows decode with defaults", () => {
    const [d] = decodeAll([{ id: "a", title: "Approve the demo plan", summary: "s", options: ["Approve", "Reject"], status: "answered", answer: "Approve", note: "ok", createdAt: 1, threadId: "t" }])
    expect(d).toMatchObject({ kind: "approval", context: "coordinator", allowText: false, optionDetails: [], threadId: "t" })
    expect("shadow" in d!).toBe(false)
  })

  test("a row with an unknown status is rejected", () => {
    expect(() => decodeAll([{ ...row("a", "pending", 1), status: "maybe" }])).toThrow()
  })

  test("pending holds only waiting decisions, oldest first", () => {
    const s = toApprovals(decodeAll([row("new", "pending", 3), row("done", "answered", 1), row("old", "pending", 2)]))
    expect(s.pending.map((d) => d.id)).toEqual(["old", "new"])
    expect(s.all).toHaveLength(3)
  })

  test("a newer reload wins over a slower older one", async () => {
    const answers = [
      { delay: 50, rows: [row("stale", "pending", 1)] },
      { delay: 0, rows: [row("fresh", "pending", 2)] },
    ]
    let call = 0
    const load = Effect.suspend(() => {
      const a = answers[Math.min(call++, answers.length - 1)]!
      return Effect.sleep(a.delay).pipe(Effect.as(decodeAll(a.rows)))
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<void>()
        const store = makeStore(load, Stream.fromQueue(q))
        const fiber = yield* Effect.forkChild(store.run)
        yield* Effect.sleep(5)
        yield* Queue.offer(q, undefined)
        yield* Effect.sleep(100)
        const s = yield* SubscriptionRef.get(store.ref)
        yield* Fiber.interrupt(fiber)
        return s
      }),
    )
    expect(result.pending.map((d) => d.id)).toEqual(["fresh"])
  })

  test("a failed reload keeps the last good list", async () => {
    let call = 0
    const load = Effect.suspend(() =>
      call++ === 0 ? Effect.succeed(decodeAll([row("kept", "pending", 1)])) : Effect.fail(new HttpError({ url: "/api/approvals", reason: "HTTP 502" })),
    )
    const seen: Approvals[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<void>()
        const store = makeStore(load, Stream.fromQueue(q))
        const fiber = yield* Effect.forkChild(store.run)
        yield* Effect.sleep(5)
        yield* Queue.offer(q, undefined)
        yield* Effect.sleep(5)
        seen.push(yield* SubscriptionRef.get(store.ref))
        yield* Fiber.interrupt(fiber)
      }),
    )
    expect(seen[0]!.pending.map((d) => d.id)).toEqual(["kept"])
  })
})
