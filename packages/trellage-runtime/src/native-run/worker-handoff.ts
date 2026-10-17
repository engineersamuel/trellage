import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import type { LaunchCommand } from "./adapters.ts"
import { NativeRunError } from "./paths.ts"

/**
 * Firstmate starts its workers in new terminal panes. Those panes do not inherit the
 * environment trx gives the supervisor, so the harness setup has to live in files the
 * workers already find:
 *
 * - Claude workers receive the supervisor's CLAUDE_CONFIG_DIR, so the proxy variables go
 *   into that directory's settings.json `env` block.
 * - Pi workers receive no PI_CODING_AGENT_DIR, so the Firstmate home pins them to the
 *   generated Pi directory (config/pi-account) and names a default worker model with an
 *   explicit provider (config/crew-dispatch.json), which that pin requires.
 */

/**
 * Tool directories a worker shell may lack: worker panes start a fresh login shell, and a
 * shell such as zsh does not read the user's fish config. Only directories that exist are used.
 */
export const workerToolDirectories = (home: string): string[] =>
  [path.join(home, ".local", "share", "mise", "shims"), path.join(home, ".local", "bin"), "/opt/homebrew/bin"].filter(
    (directory) => existsSync(directory),
  )

/** PATH for worker shells: the tool directories first, then the supervisor's PATH, without repeats. */
export const workerPath = (home: string, current: string | undefined): string =>
  [...new Set([...workerToolDirectories(home), ...(current ?? "").split(path.delimiter).filter(Boolean)])].join(
    path.delimiter,
  )

/** Environment names Claude reads that point it at the local proxy; copied from the launch, never from the host. */
const CLAUDE_WORKER_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
] as const

const readObject = async (file: string): Promise<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Write the launch's proxy variables into the generated Claude settings, so workers that share the directory use them. */
export const writeClaudeWorkerEnvironment = async (
  generationPath: string,
  launch: LaunchCommand,
  path_: string,
): Promise<void> => {
  const file = path.join(generationPath, "settings.json")
  const settings = await readObject(file)
  const env = Object.fromEntries(
    CLAUDE_WORKER_ENV.flatMap((name) => {
      const value = launch.env[name]
      return typeof value === "string" ? [[name, value]] : []
    }),
  )
  const current = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {}
  await writeFile(
    file,
    `${JSON.stringify({ ...settings, env: { ...current, ...env, PATH: path_ } }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

/** Prefix every Pi shell command with the worker PATH; Pi reads this from its settings.json. */
export const writePiWorkerShell = async (generationPath: string, home: string): Promise<void> => {
  const file = path.join(generationPath, "settings.json")
  const directories = workerToolDirectories(home)
  if (directories.length === 0) return
  const quoted = directories.map((directory) => `'${directory.replaceAll("'", "'\\''")}'`).join(":")
  await writeFile(
    file,
    `${JSON.stringify({ ...(await readObject(file)), shellCommandPrefix: `export PATH=${quoted}:"$PATH";` }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

const readText = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8")
  } catch {
    return undefined
  }
}

const DISPATCH_MARKER = "Written by trx run pi firstmate"

/** A Firstmate config file trx wrote: the Pi pin names a trx generation, the dispatch file carries the marker. */
const ownedBy = (compositions: string) => ({
  "pi-account": (text: string) => text.startsWith(`${compositions}${path.sep}`),
  "crew-dispatch.json": (text: string) => text.includes(DISPATCH_MARKER),
})

const writeOwned = async (file: string, content: string, owned: (text: string) => boolean): Promise<void> => {
  const existing = await readText(file)
  if (existing !== undefined && existing !== content && !owned(existing))
    throw new NativeRunError(
      "launch",
      `${file} was not written by trx; remove it or move it away so trx can configure Firstmate's Pi workers`,
    )
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, content, { mode: 0o600 })
}

/**
 * Pin Firstmate's Pi workers to the generated Pi directory and its proxy provider.
 * Files trx did not write are never replaced.
 */
export const writeFirstmatePiWorkers = async (
  home: string,
  compositions: string,
  generationPath: string,
  provider: string,
  model: string,
  effort: string | undefined,
): Promise<void> => {
  const owned = ownedBy(compositions)
  await writeOwned(path.join(home, "config", "pi-account"), `${generationPath}\n${provider}\n`, owned["pi-account"])
  await writeOwned(
    path.join(home, "config", "crew-dispatch.json"),
    `${JSON.stringify(
      {
        rules: [],
        default: { harness: "pi", model: `${provider}/${model}`, ...(effort ? { effort } : {}), why: DISPATCH_MARKER },
      },
      null,
      2,
    )}\n`,
    owned["crew-dispatch.json"],
  )
}

/** Remove the Pi worker pin trx wrote, so workers of a Claude supervisor mirror Claude again. */
export const clearFirstmatePiWorkers = async (home: string, compositions: string): Promise<void> => {
  for (const [name, owned] of Object.entries(ownedBy(compositions))) {
    const file = path.join(home, "config", name)
    const existing = await readText(file)
    if (existing !== undefined && owned(existing)) await rm(file, { force: true })
  }
}

/** Generations whose workers may outlive the trx process; pruning keeps them this long after the last launch. */
export const WORKER_GENERATION_MARKER = ".trellage-workers"
export const WORKER_GENERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export const markWorkerGeneration = async (generationPath: string): Promise<void> => {
  await writeFile(path.join(generationPath, WORKER_GENERATION_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 })
}
