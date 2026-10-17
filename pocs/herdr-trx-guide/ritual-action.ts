import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { bunExecutable } from "@trellage/runtime"
import type { InvocationContext } from "./lib/context.ts"
import { copyToClipboard } from "./lib/clipboard.ts"
import { requestHerdr, runHerdr } from "./lib/herdr.ts"
import { findTrellageRoot } from "./lib/trellage-root.ts"

const execute = promisify(execFile)
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const ritualSourceChoice = () => ({
  kind: "ritual",
  label: "Rituals",
  detail: "Open saved prompts. Copy one into the current agent.",
  preview: [
    "Opens this checkout's ritual list in a new pane.",
    "No model call. Nothing is copied until you press Enter in that list.",
  ].join("\n\n"),
})

export const watchSourceChoice = (context: InvocationContext) => ({
  kind: "watch",
  label: "Progress page",
  detail: "Copy the progress-page prompt for this repository.",
  preview: [
    `Repository: ${context.cwd}`,
    "Copies the progress-page prompt to the clipboard.",
    "Paste it into the current agent. No pane opens and no model runs.",
  ].join("\n\n"),
})

const shellArgument = (value: string): string =>
  /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`

export const ritualGuideCommand = (root: string, runtime: string): string => [
  "env",
  "-u", "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON",
  "-u", "TRELLAGE_GUIDE_HERDR_INTENT_FILE",
  "-u", "TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
  `TRELLAGE_BUN_EXECUTABLE=${runtime}`,
  `TRELLAGE_TRX_SOURCE_ROOT=${path.join(root, "prototypes/trellage-router")}`,
  "TRELLAGE_TRX_NATIVE_SOURCE=1",
  path.join(root, "prototypes/trellage-router/bin/trx"),
  "guide", "--ritual",
].map(shellArgument).join(" ")

export const progressPageClipboardText = (prompt: string, cwd: string): string =>
  `${prompt.replace(/\s+$/u, "")}\n\nRepository: ${cwd}\nWrite the page at .dashboard/index.html in this repository.\n`

export class ProgressPageCopyError extends Error {
  readonly prompt: string

  constructor(message: string, prompt: string) {
    super(message)
    this.name = "ProgressPageCopyError"
    this.prompt = prompt
  }
}

interface RitualPane {
  readonly id: string
  readonly terminalId: string
  readonly workspaceId: string
  readonly tabId: string
  readonly cwd: string
  readonly agent: string | null
}

const paneResult = (value: Record<string, unknown>): RitualPane => {
  const pane = value.pane
  if (!isRecord(pane)) throw new Error("Herdr returned no verifiable pane")
  const id = (key: string): string => {
    const result = pane[key]
    if (typeof result !== "string" || !identifier.test(result)) throw new Error(`Herdr pane ${key} is invalid`)
    return result
  }
  const cwd = pane.foreground_cwd ?? pane.cwd
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Herdr pane working directory is unavailable")
  let agent: string | null = null
  if (pane.agent !== undefined && pane.agent !== null) {
    if (typeof pane.agent !== "string") throw new Error("Herdr pane agent is invalid")
    agent = pane.agent
  }
  return { id: id("pane_id"), terminalId: id("terminal_id"), workspaceId: id("workspace_id"), tabId: id("tab_id"), cwd, agent }
}

const sourceMatches = (pane: RitualPane, context: InvocationContext): void => {
  if (pane.id !== context.paneId || pane.workspaceId !== context.workspaceId ||
      (context.tabId !== undefined && pane.tabId !== context.tabId) ||
      path.resolve(pane.cwd) !== path.resolve(context.cwd)) {
    throw new Error("The source pane or repository changed. Reopen the TRX menu.")
  }
}

const repositoryRoot = async (cwd: string): Promise<string> => {
  const directory = await realpath(cwd)
  const result = await execute("git", ["--no-optional-locks", "-C", directory, "rev-parse", "--show-toplevel"], {
    timeout: 10_000, maxBuffer: 64_000, encoding: "utf8",
  })
  const root = result.stdout.trim()
  if (!path.isAbsolute(root)) throw new Error("The ritual list requires a local Git worktree")
  const relative = path.relative(root, directory)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Git resolved a repository outside the focused pane. Check its Git environment.")
  }
  return root
}

const assertRouter = async (root: string): Promise<string> => {
  const router = path.join(root, "prototypes/trellage-router/bin/trx")
  const metadata = await lstat(router)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The worktree trx launcher is unsafe")
  await access(router, constants.X_OK)
  return router
}

export interface RitualActionOptions {
  readonly context: InvocationContext
  readonly env?: NodeJS.ProcessEnv
  readonly root?: string
  readonly runtime?: string
  readonly request?: typeof requestHerdr
  readonly run?: typeof runHerdr
  readonly inspectRepository?: typeof repositoryRoot
}

export const openRitualGuide = async ({
  context, env = process.env, root: suppliedRoot, runtime = bunExecutable(),
  request = requestHerdr, run = runHerdr, inspectRepository = repositoryRoot,
}: RitualActionOptions): Promise<string> => {
  const root = suppliedRoot ?? await findTrellageRoot(fileURLToPath(new URL(".", import.meta.url)))
  await assertRouter(root)
  const source = paneResult(await request("pane.get", { pane_id: context.paneId }))
  sourceMatches(source, context)
  const cwd = await inspectRepository(source.cwd)
  const current = paneResult(await request("pane.get", { pane_id: source.id }))
  sourceMatches(current, context)
  if (current.terminalId !== source.terminalId) throw new Error("The source terminal changed. Reopen the TRX menu.")

  const created = paneResult(await request("pane.split", {
    target_pane_id: source.id, workspace_id: source.workspaceId,
    direction: "right", cwd, focus: false,
  }))
  if (created.id === source.id) throw new Error("Herdr did not allocate a new ritual pane; nothing was sent")
  try {
    const destination = paneResult(await request("pane.get", { pane_id: created.id }))
    if (destination.id !== created.id || destination.terminalId !== created.terminalId ||
        destination.workspaceId !== source.workspaceId || destination.tabId !== source.tabId ||
        path.resolve(destination.cwd) !== path.resolve(cwd) || destination.agent !== null) {
      throw new Error("The new pane is not an idle terminal in the selected repository")
    }
    const options = { ...(env.HERDR_BIN_PATH === undefined ? {} : { binary: env.HERDR_BIN_PATH }), timeoutMs: 35_000 }
    await run(["pane", "run", created.id, ritualGuideCommand(root, runtime)], options)
    await run(["pane", "wait-output", created.id, "--match", "Rituals", "--source", "visible", "--timeout", "30000"], options)
    await request("pane.rename", { pane_id: created.id, label: "Rituals" })
    await request("pane.focus", { pane_id: created.id })
    return created.id
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Inspect ritual pane ${created.id} before retrying: ${message}`, { cause })
  }
}

const guideEnv = (env: NodeJS.ProcessEnv, root: string, runtime: string): NodeJS.ProcessEnv => {
  const child: NodeJS.ProcessEnv = { ...env }
  delete child.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON
  delete child.TRELLAGE_GUIDE_HERDR_INTENT_FILE
  delete child.TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE
  child.BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"
  child.TRELLAGE_BUN_EXECUTABLE = runtime
  child.TRELLAGE_TRX_SOURCE_ROOT = path.join(root, "prototypes/trellage-router")
  child.TRELLAGE_TRX_NATIVE_SOURCE = "1"
  return child
}

const printProgressPrompt = async (router: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> => {
  const result = await execute(router, ["guide", "--ritual", "progress-page", "--print"], {
    cwd, env, timeout: 20_000, maxBuffer: 256_000, encoding: "utf8",
  })
  const prompt = result.stdout.trim()
  if (prompt.length === 0) throw new Error("The progress-page prompt was empty")
  return prompt
}

export interface ProgressPageCopyOptions {
  readonly context: InvocationContext
  readonly env?: NodeJS.ProcessEnv
  readonly root?: string
  readonly runtime?: string
  readonly request?: typeof requestHerdr
  readonly printPrompt?: (cwd: string) => Promise<string>
  readonly copy?: (value: string) => void
}

export const copyProgressPagePrompt = async ({
  context, env = process.env, root: suppliedRoot, runtime = bunExecutable(),
  request = requestHerdr, printPrompt, copy = copyToClipboard,
}: ProgressPageCopyOptions): Promise<string> => {
  const root = suppliedRoot ?? await findTrellageRoot(fileURLToPath(new URL(".", import.meta.url)))
  const router = await assertRouter(root)
  const source = paneResult(await request("pane.get", { pane_id: context.paneId }))
  sourceMatches(source, context)
  const prompt = await (printPrompt ?? ((cwd: string) => printProgressPrompt(router, cwd, guideEnv(env, root, runtime))))(source.cwd)
  const text = progressPageClipboardText(prompt, source.cwd)
  try {
    copy(text)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new ProgressPageCopyError(message, text)
  }
  return "Copied the progress-page prompt. Paste it into the current agent."
}
