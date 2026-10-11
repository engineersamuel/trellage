import type { ChildProcess } from "node:child_process"
import type { LaunchGuard } from "./adapters.ts"

export const childSettlement = (child: ChildProcess, guard?: LaunchGuard) => {
  let closed = false
  child.once("close", () => { closed = true })
  const waitForClose = async (timeout: number): Promise<void> => {
    if (closed) return
    await new Promise<void>((resolve) => {
      const onClose = () => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => { child.off("close", onClose); resolve() }, timeout)
      child.once("close", onClose)
    })
  }
  const signal = (requested: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    if (guard) guard.signalTree(child.pid, requested)
    else child.kill(requested)
  }
  const wait = async (timeout: number): Promise<boolean> => {
    const [, settled] = await Promise.all([
      waitForClose(timeout),
      child.pid === undefined || guard?.waitForTree === undefined ? true : guard.waitForTree(child.pid, timeout),
    ])
    return closed && settled
  }
  const terminate = async (): Promise<boolean> => {
    for (const requested of ["SIGTERM", "SIGKILL"] as const) {
      try { signal(requested) } catch { /* Settlement still must prove the work has exited. */ }
      if (await wait(1_000).catch(() => false)) return true
    }
    return false
  }
  return { signal, wait, terminate }
}
