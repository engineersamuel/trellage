import { spawn, type ChildProcess } from "node:child_process"

export const POSIX_ALARM_SCRIPT = 'alarm($ENV{TRELLAGE_TEST_ALARM_SECONDS} // 8); exec @ARGV or die "$!\\n";'

export type ProcessResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: Error
  closed: boolean
}

export type ManagedProcess = {
  child: ChildProcess
  settled: Promise<ProcessResult>
  closed: boolean
}

type LifecycleOptions = {
  settleDeadline?: number
}

export async function runCleanupStages(stages: Array<() => Promise<void>>, label: string): Promise<void> {
  const errors: Error[] = []
  for (const stage of stages) {
    try {
      await stage()
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, label)
}

export function createProcessLifecycle(options: LifecycleOptions = {}) {
  const processes: ManagedProcess[] = []
  const settleDeadline = options.settleDeadline ?? 3_000

  const spawnManaged = (command: string, args: string[], spawnOptions: Parameters<typeof spawn>[2]): ManagedProcess => {
    const child = spawn(command, args, spawnOptions)
    const managed = {
      child,
      settled: Promise.resolve(undefined as unknown as ProcessResult),
      closed: false,
    }
    // Register immediately after spawn, before any caller can await or launch another child.
    processes.push(managed)

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += `${chunk}` })
    child.stderr?.on("data", (chunk) => { stderr += `${chunk}` })
    managed.settled = new Promise<ProcessResult>((resolve) => {
      let exitCode: number | null = null
      let exitSignal: NodeJS.Signals | null = null
      let error: Error | undefined
      child.once("error", (eventError) => { error = eventError })
      child.once("exit", (code, signalValue) => {
        exitCode = code
        exitSignal = signalValue
      })
      // A spawn error is not a reaping event. Resolve only after close has fired.
      child.once("close", (code, signalValue) => {
        managed.closed = true
        resolve({
          code: exitCode ?? code,
          signal: exitSignal ?? signalValue,
          stdout,
          stderr,
          ...(error === undefined ? {} : { error }),
          closed: true,
        })
      })
    })
    return managed
  }

  const waitForClosure = async (duration: number): Promise<boolean> => {
    const deadline = Date.now() + duration
    while (processes.some((managed) => !managed.closed)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, remaining)))
    }
    return true
  }

  const cleanup = async (): Promise<void> => {
    if (!(await waitForClosure(settleDeadline))) throw new Error("managed processes did not close before cleanup deadline")
  }

  return {
    spawn: spawnManaged,
    processes,
    cleanup,
  }
}
