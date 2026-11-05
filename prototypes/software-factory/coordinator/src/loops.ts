// Background loops of the coordinator as Effect fibers instead of bare setInterval calls.
// - A failing or throwing tick is logged and the loop continues (setInterval + `void promise` lost the error).
// - Ticks never overlap: the next tick starts `every` after the previous one ended.
// - stopLoops() interrupts every loop, so shutdown stops them before it stops the workers.
import { Duration, Effect, Fiber, Schedule } from "effect"

const fibers = new Set<Fiber.Fiber<unknown, unknown>>()

/** Run `tick` every `every`, first after `firstAfter` (default: `every`). Returns the fiber. */
export const loop = (
  name: string,
  every: Duration.Input,
  tick: () => unknown,
  firstAfter: Duration.Input = every,
): Fiber.Fiber<unknown, unknown> => {
  const once = Effect.tryPromise(async () => await tick()).pipe(
    Effect.catchCause((cause) => Effect.logError(`loop ${name}: tick failed`, cause)),
  )
  const fiber = Effect.runFork(Effect.sleep(firstAfter).pipe(Effect.andThen(once.pipe(Effect.repeat(Schedule.spaced(every))))))
  fibers.add(fiber)
  fiber.addObserver(() => fibers.delete(fiber))
  return fiber
}

/** Interrupt every running loop and wait until they stopped. */
export const stopLoops = (): Promise<void> => Effect.runPromise(Fiber.interruptAll([...fibers]))
