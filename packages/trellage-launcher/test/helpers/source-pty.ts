import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { sourceEnvironment } from "@trellage/runtime"

export interface SourcePtyExit {
  readonly exitCode: number
  readonly signal?: number
  readonly error?: string
}

interface SourcePtyOptions {
  readonly name: string
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

enum PtyCommand {
  Input = "input",
  Signal = "signal",
  Resize = "resize",
  TerminalState = "terminal-state",
}

const isExitStatus = (value: unknown): value is Required<Pick<SourcePtyExit, "exitCode" | "signal">> =>
  typeof value === "object" &&
  value !== null &&
  "exitCode" in value &&
  typeof value.exitCode === "number" &&
  Number.isInteger(value.exitCode) &&
  value.exitCode >= 0 &&
  "signal" in value &&
  typeof value.signal === "number" &&
  Number.isInteger(value.signal) &&
  value.signal >= 0

const isProcessStatus = (value: unknown): value is { readonly pid: number } =>
  typeof value === "object" &&
  value !== null &&
  "pid" in value &&
  typeof value.pid === "number" &&
  Number.isSafeInteger(value.pid) &&
  value.pid > 0

const exitStatus = (code: number | null, stderr: string, failure?: string): SourcePtyExit => {
  if (failure !== undefined || code !== 0) {
    return { exitCode: code === null || code === 0 ? 1 : code, error: failure ?? stderr }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stderr)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return { exitCode: 1, error: `Invalid PTY status: ${stderr}` }
  }
  if (!isExitStatus(parsed)) {
    return { exitCode: 1, error: `Invalid PTY status: ${stderr}` }
  }
  return { exitCode: parsed.exitCode, signal: parsed.signal }
}

// node-pty's native transport does not deliver PTY data under Bun 1.4.2 on macOS.
export const spawnSourcePty = (executable: string, args: readonly string[], options: SourcePtyOptions) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Source PTY contracts require macOS or Linux.")
  }
  const python = Bun.which("python3")
  if (python === null) throw new Error("Source PTY contracts require Python 3.")
  const child = spawn(
    python,
    [
      "-I",
      "-B",
      fileURLToPath(new URL("../../../../tests/helpers/posix-pty.py", import.meta.url)),
      "--columns",
      String(options.cols),
      "--rows",
      String(options.rows),
      "--",
      executable,
      ...args,
    ],
    {
      cwd: options.cwd,
      env: sourceEnvironment({ ...options.env, TERM: options.name }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(status: SourcePtyExit) => void>()
  const stateRequests = new Map<number, { resolve: (raw: boolean) => void; reject: (error: Error) => void }>()
  let nextRequestId = 0
  let pendingStderr = ""
  let stderr = ""
  let failure: string | undefined
  let exit: SourcePtyExit | undefined
  let processId: number | undefined
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (data: string) => {
    for (const listener of dataListeners) listener(data)
  })
  child.stderr.on("data", (data: string) => {
    pendingStderr += data
    while (pendingStderr.includes("\n")) {
      const newline = pendingStderr.indexOf("\n")
      const message = pendingStderr.slice(0, newline)
      pendingStderr = pendingStderr.slice(newline + 1)
      let parsed: unknown
      try {
        parsed = JSON.parse(message)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        failure ??= `Invalid PTY status: ${message}`
        stderr += `${message}\n`
        continue
      }
      if (processId === undefined) {
        if (isProcessStatus(parsed)) processId = parsed.pid
        else failure ??= `Invalid PTY child process: ${message}`
      } else if (
        typeof parsed === "object" &&
        parsed !== null &&
        "requestId" in parsed &&
        typeof parsed.requestId === "number" &&
        "raw" in parsed &&
        typeof parsed.raw === "boolean"
      ) {
        const request = stateRequests.get(parsed.requestId)
        if (request) request.resolve(parsed.raw)
        else failure ??= `Unknown PTY state reply: ${message}`
      } else {
        stderr += `${message}\n`
      }
    }
  })
  child.on("error", (error) => {
    failure = error.message
  })
  child.stdin.on("error", (error) => {
    failure = error.message
  })
  child.on("close", (code) => {
    stderr += pendingStderr
    exit = exitStatus(
      code,
      stderr,
      failure ?? (processId === undefined ? `Missing PTY child process: ${stderr}` : undefined),
    )
    for (const request of stateRequests.values())
      request.reject(new Error("PTY exited before reporting terminal state"))
    for (const listener of exitListeners) listener(exit)
  })
  const send = (message: object): void => {
    if (exit !== undefined) throw new Error("PTY input requires a running fixture.")
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  return {
    get pid(): number | undefined {
      return processId
    },
    write: (data: string): void => send({ kind: PtyCommand.Input, data }),
    kill: (value: NodeJS.Signals = "SIGHUP"): void => send({ kind: PtyCommand.Signal, signal: value }),
    resize: (columns: number, rows: number): void => send({ kind: PtyCommand.Resize, columns, rows }),
    rawMode: (): Promise<boolean> =>
      new Promise((resolve, reject) => {
        const requestId = ++nextRequestId
        const finish = () => {
          clearTimeout(timeout)
          stateRequests.delete(requestId)
        }
        const timeout = setTimeout(() => {
          finish()
          reject(new Error("PTY terminal state query timed out"))
        }, 5000)
        stateRequests.set(requestId, {
          resolve: (raw) => {
            finish()
            resolve(raw)
          },
          reject: (error) => {
            finish()
            reject(error)
          },
        })
        try {
          send({ kind: PtyCommand.TerminalState, requestId })
        } catch (error) {
          finish()
          reject(error)
        }
      }),
    onData(listener: (data: string) => void): void {
      dataListeners.add(listener)
    },
    onExit(listener: (status: SourcePtyExit) => void): void {
      if (exit !== undefined) listener(exit)
      else exitListeners.add(listener)
    },
  }
}

export type SourcePty = ReturnType<typeof spawnSourcePty>

export const waitForRawInput = async (child: SourcePty, timeoutMs = 15000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await child.rawMode())) {
    if (Date.now() >= deadline) throw new Error("Terminal did not enable raw input")
    await Bun.sleep(20)
  }
}
