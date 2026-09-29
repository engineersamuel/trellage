import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, lstat, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { bunExecutable } from "@trellage/runtime"
import type { InvocationContext } from "./lib/context.ts"
import { requestHerdr, runHerdr } from "./lib/herdr.ts"
import { findTrellageRoot } from "./lib/trellage-root.ts"

const execute = promisify(execFile)
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const engagementSourceChoice = (context: InvocationContext) => ({
  kind: "engagement",
  label: "Check the engagement (HVE next steps)",
  detail: "Find the next HVE step from this repository's engagement evidence.",
  preview: [
    `Repository: ${context.cwd}`,
    "Question: What's the next step in this engagement?",
    "Opens this checkout's Guide in a new pane for the same repository.",
    "Select evidence and approve model use in Guide. No capture, model call, or HVE agent launch is required to open it.",
  ].join("\n\n"),
})

const shellArgument = (value: string): string =>
  /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`

export const engagementGuideCommand = (root: string, runtime: string): string => [
  "env",
  "-u", "TRELLAGE_GUIDE_HERDR_CONTEXT_JSON",
  "-u", "TRELLAGE_GUIDE_HERDR_INTENT_FILE",
  "-u", "TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE",
  "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
  `TRELLAGE_BUN_EXECUTABLE=${runtime}`,
  `TRELLAGE_TRX_SOURCE_ROOT=${path.join(root, "prototypes/trellage-router")}`,
  "TRELLAGE_TRX_NATIVE_SOURCE=1",
  path.join(root, "prototypes/trellage-router/bin/trx"),
  "guide", "--engagement",
].map(shellArgument).join(" ")

interface EngagementPane {
  readonly id: string
  readonly terminalId: string
  readonly workspaceId: string
  readonly tabId: string
  readonly cwd: string
  readonly agent: string | null
}

const paneResult = (value: Record<string, unknown>): EngagementPane => {
  const pane = value.pane
  if (!isRecord(pane)) {
    throw new Error("Herdr returned no verifiable pane")
  }
  const fields = pane
  const id = (key: string): string => {
    const result = fields[key]
    if (typeof result !== "string" || !identifier.test(result)) throw new Error(`Herdr pane ${key} is invalid`)
    return result
  }
  const cwd = fields.foreground_cwd ?? fields.cwd
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Herdr pane working directory is unavailable")
  let agent: string | null = null
  if (fields.agent !== undefined && fields.agent !== null) {
    if (typeof fields.agent !== "string") throw new Error("Herdr pane agent is invalid")
    agent = fields.agent
  }
  return { id: id("pane_id"), terminalId: id("terminal_id"), workspaceId: id("workspace_id"), tabId: id("tab_id"), cwd, agent }
}

const sourceMatches = (pane: EngagementPane, context: InvocationContext): void => {
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
  if (!path.isAbsolute(root)) throw new Error("Engagement guidance requires a local Git worktree")
  const relative = path.relative(root, directory)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Git resolved a repository outside the focused pane. Check its Git environment.")
  }
  return root
}

export interface EngagementActionOptions {
  readonly context: InvocationContext
  readonly env?: NodeJS.ProcessEnv
  readonly root?: string
  readonly runtime?: string
  readonly request?: typeof requestHerdr
  readonly run?: typeof runHerdr
  readonly inspectRepository?: typeof repositoryRoot
}

export const openEngagementGuide = async ({
  context, env = process.env, root: suppliedRoot, runtime = bunExecutable(),
  request = requestHerdr, run = runHerdr, inspectRepository = repositoryRoot,
}: EngagementActionOptions): Promise<string> => {
  const root = suppliedRoot ?? await findTrellageRoot(fileURLToPath(new URL(".", import.meta.url)))
  const router = path.join(root, "prototypes/trellage-router/bin/trx")
  const metadata = await lstat(router)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("The worktree trx launcher is unsafe")
  await access(router, constants.X_OK)
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
  if (created.id === source.id) throw new Error("Herdr did not allocate a new engagement pane; nothing was sent")
  try {
    const destination = paneResult(await request("pane.get", { pane_id: created.id }))
    if (destination.id !== created.id || destination.terminalId !== created.terminalId ||
        destination.workspaceId !== source.workspaceId || destination.tabId !== source.tabId ||
        path.resolve(destination.cwd) !== path.resolve(cwd) || destination.agent !== null) {
      throw new Error("The new pane is not an idle terminal in the selected repository")
    }
    const options = { ...(env.HERDR_BIN_PATH === undefined ? {} : { binary: env.HERDR_BIN_PATH }), timeoutMs: 35_000 }
    await run(["pane", "run", created.id, engagementGuideCommand(root, runtime)], options)
    await run(["pane", "wait-output", created.id, "--match", "Engagement sources", "--source", "visible", "--timeout", "30000"], options)
    await request("pane.rename", { pane_id: created.id, label: "Engagement (HVE)" })
    await request("pane.focus", { pane_id: created.id })
    return created.id
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`Inspect engagement pane ${created.id} before retrying: ${message}`, { cause })
  }
}
