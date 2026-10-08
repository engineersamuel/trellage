import { setTimeout as delay } from "node:timers/promises"

export interface InstallRetryOptions {
  readonly attempts?: number
  readonly signal?: AbortSignal
  readonly shouldRetry?: (error: unknown) => boolean
  readonly onRetry?: (error: unknown, nextAttempt: number, attempts: number) => void
  readonly wait?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>
}

const waitWithSignal = async (milliseconds: number, signal: AbortSignal | undefined): Promise<void> => {
  await delay(milliseconds, undefined, { signal })
}

export function isFrozenLockfileFailure(stderr: string): boolean {
  return /lockfile.*(?:frozen|changes)/i.test(stderr)
}

export async function retryInstall(
  install: () => Promise<void>,
  options: InstallRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 3
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("install retry attempts must be positive")
  const wait = options.wait ?? waitWithSignal

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.signal?.throwIfAborted()
    try {
      await install()
      return
    } catch (error) {
      options.signal?.throwIfAborted()
      if (attempt === attempts || options.shouldRetry?.(error) === false) throw error
      options.onRetry?.(error, attempt + 1, attempts)
      await wait(attempt * 1_000, options.signal)
    }
  }
}
