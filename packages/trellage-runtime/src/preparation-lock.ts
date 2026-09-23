import { mkdirSync, rmdirSync, lstatSync } from "node:fs"

export interface PreparationLockOptions {
  readonly signal?: AbortSignal
  readonly pollMs?: number
  readonly timeoutMs?: number
}

export interface PreparationLock {
  readonly release: () => Promise<void>
}

function unsafeLock(lock: string): Error {
  return new Error(`unsafe preparation lock: ${lock}`)
}

function validateLock(lock: string): { readonly dev: number; readonly ino: number } {
  const status = lstatSync(lock)
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    (process.getuid !== undefined && Number(status.uid) !== process.getuid()) ||
    (Number(status.mode) & 0o022) !== 0
  ) {
    throw unsafeLock(lock)
  }
  return { dev: Number(status.dev), ino: Number(status.ino) }
}

function waitForLock(delay: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("preparation lock wait cancelled"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delay)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(new Error("preparation lock wait cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

function validateContendedLock(lock: string): void {
  try {
    validateLock(lock)
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error
  }
}

export async function acquirePreparationLock(
  lock: string,
  options: PreparationLockOptions = {},
): Promise<PreparationLock> {
  const pollMs = options.pollMs ?? 50
  const timeoutMs = options.timeoutMs ?? 180_000
  const started = Date.now()
  for (;;) {
    options.signal?.throwIfAborted()
    try {
      mkdirSync(lock, { mode: 0o700 })
      const owner = validateLock(lock)
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          let current
          try {
            current = validateLock(lock)
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return
            throw error
          }
          if (current.dev !== owner.dev || current.ino !== owner.ino) throw unsafeLock(lock)
          rmdirSync(lock)
        },
      }
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error
      validateContendedLock(lock)
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for preparation lock: ${lock}`)
    await waitForLock(Math.max(0, pollMs), options.signal)
  }
}
