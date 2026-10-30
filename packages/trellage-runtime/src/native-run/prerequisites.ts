import { spawn } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { NativeRunError } from "./paths.ts"

export interface Prerequisite {
  readonly command: string
  readonly install: string
  readonly autoInstall?: boolean | undefined
}

export interface PrerequisiteIo {
  /** Ask a yes/no question; undefined when no terminal can answer. */
  readonly confirm?: (question: string) => Promise<boolean>
  /** Run one install command with inherited output; resolves to its exit status. */
  readonly install?: (command: string, environment: NodeJS.ProcessEnv) => Promise<number>
  readonly write: (line: string) => void
}

export const onPath = (command: string, environment: NodeJS.ProcessEnv): boolean =>
  (environment.PATH ?? "").split(path.delimiter).some((directory) => {
    if (!directory) return false
    try {
      accessSync(path.join(directory, command), constants.X_OK)
      return true
    } catch {
      return false
    }
  })

export const missingPrerequisites = (
  prerequisites: ReadonlyArray<Prerequisite>,
  environment: NodeJS.ProcessEnv,
): Prerequisite[] => prerequisites.filter((entry) => !onPath(entry.command, environment))

const terminalConfirm = async (question: string): Promise<boolean> => {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/iu.test((await prompt.question(`${question} [y/N] `)).trim())
  } finally {
    prompt.close()
  }
}

const shellInstall = (command: string, environment: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env: environment, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (status) => resolve(status ?? 1))
  })

export const defaultPrerequisiteIo = (write: (line: string) => void): PrerequisiteIo => ({
  ...(process.stdin.isTTY && process.stdout.isTTY ? { confirm: terminalConfirm } : {}),
  install: shellInstall,
  write,
})

/**
 * Stop before launch unless every prerequisite is on PATH. Missing ones are listed with
 * their install commands, and installed after confirmation unless explicitly automatic.
 */
export const ensurePrerequisites = async (
  label: string,
  prerequisites: ReadonlyArray<Prerequisite>,
  environment: NodeJS.ProcessEnv,
  io: PrerequisiteIo,
): Promise<void> => {
  const missing = missingPrerequisites(prerequisites, environment)
  if (missing.length === 0) return
  io.write(`${label} needs ${missing.length} missing tool${missing.length === 1 ? "" : "s"}:`)
  for (const entry of missing) io.write(`  ${entry.command}  install: ${entry.install}`)
  const refused = () =>
    new NativeRunError(
      "prerequisite",
      `missing ${missing.map((entry) => entry.command).join(", ")}; install ${missing.length === 1 ? "it" : "them"} with the commands above and run again`,
    )
  const needsConfirmation = missing.some((entry) => !entry.autoInstall)
  if (
    io.install === undefined ||
    (needsConfirmation && (io.confirm === undefined || !(await io.confirm("Install them now?"))))
  )
    throw refused()
  for (const entry of missing) {
    io.write(`Installing ${entry.command}: ${entry.install}`)
    const status = await io.install(entry.install, environment)
    if (status !== 0) throw new NativeRunError("prerequisite", `installing ${entry.command} failed (exit ${status})`)
  }
  const still = missingPrerequisites(missing, environment)
  if (still.length > 0)
    throw new NativeRunError(
      "prerequisite",
      `${still.map((entry) => entry.command).join(", ")} still not on PATH after install; check the install location and PATH`,
    )
}
