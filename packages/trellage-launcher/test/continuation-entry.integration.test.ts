import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Terminal } from "@xterm/headless"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { expect, test, vi, type TestContext } from "vitest"
import { ConversationAgent, ConversationRole, ConversationSurface } from "@trellage/guide-core"
import { ContinuationStore } from "../src/continuation-store.ts"
import { runtimeCatalog } from "./helpers/continuation-runtime-fixtures.ts"
import { spawnSourcePty, type SourcePtyExit } from "./helpers/source-pty.ts"

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))
const launcherEntry = fileURLToPath(new URL("../src/cli.tsx", import.meta.url))
const captureEntry = fileURLToPath(new URL("./fixtures/continuation-capture.ts", import.meta.url))
const execFileAsync = promisify(execFile)
const waitOptions = { timeout: 5000, interval: 20 }
const initialModel = "fixture-initial-model"
const editedModel = "fixture-saved-model"
const userText = "SYNTHETIC ENTRY QUESTION: explain the bounded capture."
const assistantText = "SYNTHETIC ENTRY ANSWER: the source capture is ready for review."

enum MetadataMethod {
  Agent = "agent.get",
  Process = "pane.process_info",
}

enum HelperRootMode {
  Configured,
  Automatic,
  Invalid,
}

interface MetadataRequest {
  readonly id: string
  readonly method: string
  readonly params: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const createFixture = async (onTestFailed: TestContext["onTestFailed"]) => {
  const root = await realpath(await mkdtemp(path.join(os.homedir(), ".trx-cie-")))
  const home = path.join(root, "home")
  const guideRoot = path.join(home, ".local", "share", "trellage", "trx", "share", "profile-guides")
  const stateRoot = path.join(root, "state")
  const bin = path.join(root, "bin")
  const scratch = path.join(root, "scratch")
  const socketPath = path.join(root, "h")
  const catalogPath = path.join(root, "catalog.json")
  const deniedCallsPath = path.join(root, "denied-commands.jsonl")
  const cwd = await realpath(repositoryRoot)
  const sessionId = randomUUID()
  let currentSessionId = sessionId
  let sequence = 0
  const context = {
    schemaVersion: 1,
    surface: "popup",
    workspaceId: "entry-workspace",
    paneId: "entry-pane",
    cwd,
  }
  const requests: MetadataRequest[] = []
  const protocolErrors: string[] = []
  const sockets = new Set<net.Socket>()
  const terminals: Array<ReturnType<typeof createTerminal>> = []
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.setEncoding("utf8")
    let buffered = ""
    socket.on("data", (chunk: string) => {
      buffered += chunk
      const newline = buffered.indexOf("\n")
      if (newline < 0) return
      const value: unknown = JSON.parse(buffered.slice(0, newline))
      if (
        !isRecord(value) ||
        typeof value.id !== "string" ||
        typeof value.method !== "string" ||
        !isRecord(value.params)
      ) {
        protocolErrors.push("Invalid metadata request envelope.")
        socket.end()
        return
      }
      const request: MetadataRequest = { id: value.id, method: value.method, params: value.params }
      requests.push(request)
      let result: Record<string, unknown>
      if (request.method === MetadataMethod.Agent && request.params.target === context.paneId) {
        result = {
          type: "agent_info",
          agent: {
            workspace_id: context.workspaceId,
            tab_id: "entry-tab",
            pane_id: context.paneId,
            cwd,
            agent: ConversationAgent.Copilot,
            agent_status: "working",
            state_change_seq: ++sequence,
            agent_session: {
              agent: ConversationAgent.Copilot,
              kind: "id",
              value: currentSessionId,
            },
          },
        }
      } else if (request.method === MetadataMethod.Process && request.params.pane_id === context.paneId) {
        result = {
          type: "pane_process_info",
          process_info: {
            pane_id: context.paneId,
            foreground_process_group_id: 12345,
            foreground_processes: [{ name: "copilot", argv: ["copilot", "--session-id", currentSessionId] }],
          },
        }
      } else {
        protocolErrors.push(`Unexpected source request: ${request.method}`)
        socket.end(
          `${JSON.stringify({
            id: request.id,
            error: {
              code: "fixture-denied",
              message: "Only the original pane metadata is available.",
            },
          })}\n`,
        )
        return
      }
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`)
    })
  })

  const close = async (): Promise<void> => {
    try {
      for (const terminal of terminals) await terminal.close()
    } finally {
      for (const socket of sockets) socket.destroy()
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      await rm(root, { recursive: true, force: true })
    }
  }

  try {
    for (const directory of [home, stateRoot, bin, scratch]) await mkdir(directory, { mode: 0o700 })
    await mkdir(guideRoot, { recursive: true, mode: 0o700 })
    const promptMaster = path.join(path.dirname(guideRoot), "prompt-master")
    await mkdir(promptMaster, { mode: 0o700 })
    await writeFile(path.join(promptMaster, "SKILL.md"), "# Synthetic prompt master\n", { mode: 0o600 })
    await expect(stat(path.join(path.dirname(guideRoot), "pocs"))).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(path.join(root, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600 })
    await writeFile(deniedCallsPath, "", { mode: 0o600 })
    for (const command of ["copilot", "cpx", "codex", "cdx", "claude", "cldx", "trellage", "trx", "herdr"]) {
      await writeFile(
        path.join(bin, command),
        `#!${bunExecutable()}
require("node:fs").appendFileSync(${JSON.stringify(deniedCallsPath)}, JSON.stringify({
  command: ${JSON.stringify(command)}, args: process.argv.slice(2)
}) + "\\n")
process.exitCode = 86
`,
        { mode: 0o700 },
      )
    }
    const catalog = runtimeCatalog()
    await writeFile(
      catalogPath,
      JSON.stringify({
        ...catalog,
        sandboxCommandPath: path.join(bin, "trellage"),
        native: catalog.native.map((entry) => ({
          ...entry,
          commandPath: path.join(bin, entry.launcher),
        })),
      }),
      { mode: 0o600 },
    )
    const transcriptRoot = path.join(home, ".copilot", "session-state", sessionId)
    await mkdir(transcriptRoot, { recursive: true, mode: 0o700 })
    await writeFile(path.join(transcriptRoot, "workspace.yaml"), `id: ${sessionId}\ncwd: ${cwd}\n`, { mode: 0o600 })
    await writeFile(
      path.join(transcriptRoot, "events.jsonl"),
      [
        { type: "session.start", data: { sessionId } },
        { type: "user.message", id: "entry-user", data: { content: userText } },
        {
          type: "assistant.message",
          id: "entry-answer",
          data: { phase: "final_answer", content: assistantText },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      { mode: 0o600 },
    )
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, () => {
        server.off("error", reject)
        resolve()
      })
    })
  } catch (error) {
    await close()
    throw error
  }

  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    PATH: bin,
    TERM: "xterm-256color",
    CI: "true",
    FORCE_COLOR: "1",
    COPILOT_HOME: path.join(home, ".copilot"),
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    COPILOT_CLI_PATH: path.join(bin, "copilot"),
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PLUGIN_STATE_DIR: stateRoot,
    TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify(context),
    TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT: cwd,
  }
  const store = new ContinuationStore(stateRoot)
  onTestFailed(() => {
    console.error(
      `Source metadata methods: ${requests.map(({ method }) => method).join(", ")}\nProtocol errors: ${protocolErrors.join("; ")}`,
    )
  })

  return {
    store,
    stateRoot,
    requests,
    context,
    sessionId,
    close,
    replaceSession: (): void => {
      currentSessionId = randomUUID()
    },
    async capture() {
      const result = await execFileAsync(bunExecutable(), bunArguments(captureEntry), {
        cwd,
        env,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      })
      expect(result.stderr).toBe("")
      expect(result.stdout).not.toContain(userText)
      expect(result.stdout).not.toContain(assistantText)
      const value: unknown = JSON.parse(result.stdout)
      if (!isRecord(value) || typeof value.requestPath !== "string")
        throw new Error("Capture did not return a private request path.")
      const snapshot = await store.consumeRequest(value.requestPath)
      return { snapshot, requestPath: value.requestPath }
    },
    start(requestPath: string, model = initialModel, helperRootMode = HelperRootMode.Configured) {
      const launchEnv = { ...env }
      if (helperRootMode === HelperRootMode.Automatic) delete launchEnv.TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT
      if (helperRootMode === HelperRootMode.Invalid)
        launchEnv.TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT = "relative-helper-root"
      const terminal = createTerminal({
        guideRoot,
        cwd,
        catalogPath,
        requestPath,
        env: launchEnv,
        model,
        onTestFailed,
      })
      terminals.push(terminal)
      return terminal
    },
    async assertNoInferenceOrLaunch(): Promise<void> {
      expect(await readFile(deniedCallsPath, "utf8")).toBe("")
      expect(protocolErrors).toEqual([])
      expect(
        requests.every(({ method, params }) =>
          method === MetadataMethod.Agent
            ? params.target === context.paneId
            : method === MetadataMethod.Process && params.pane_id === context.paneId,
        ),
      ).toBe(true)
    },
  }
}

const createTerminal = (options: {
  readonly guideRoot: string
  readonly cwd: string
  readonly catalogPath: string
  readonly requestPath: string
  readonly env: Record<string, string>
  readonly model: string
  readonly onTestFailed: TestContext["onTestFailed"]
}) => {
  const terminal = new Terminal({ cols: 160, rows: 42, scrollback: 0, allowProposedApi: true })
  let status: SourcePtyExit | undefined
  let screen = ""
  let output = ""
  let inputReady = false
  // The router supplies catalog fd3. This shell only reproduces that descriptor plumbing.
  const child = spawnSourcePty(
    "/bin/sh",
    [
      "-c",
      'exec "$@" 3<"$0"',
      options.catalogPath,
      bunExecutable(),
      ...bunArguments(launcherEntry, [
        "guide",
        options.guideRoot,
        path.join(path.dirname(options.guideRoot), "prompt-master"),
        "--next-steps",
        "--model",
        options.model,
        "--effort",
        "medium",
      ]),
    ],
    {
      name: "xterm-256color",
      cols: terminal.cols,
      rows: terminal.rows,
      cwd: options.cwd,
      env: { ...options.env, TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE: options.requestPath },
    },
  )
  terminal.onData((data) => child.write(data))
  child.onData((data) => {
    output = (output + data).slice(-12_000)
    const inputEnabled = output.lastIndexOf("\u001b[?2004h")
    const inputDisabled = output.lastIndexOf("\u001b[?2004l")
    if (inputEnabled >= 0 || inputDisabled >= 0) inputReady = inputEnabled > inputDisabled
    terminal.write(data, () => {
      const buffer = terminal.buffer.active
      screen = Array.from(
        { length: terminal.rows },
        (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
      ).join("\n")
    })
  })
  child.onExit((exit) => {
    status = exit
  })
  options.onTestFailed(() => {
    console.error(`Source launcher screen:\n${screen}\nPTY tail: ${JSON.stringify(output)}`)
  })
  const flush = (): Promise<void> => new Promise((resolve) => terminal.write("", resolve))
  const waitForText = async (...texts: ReadonlyArray<string>): Promise<void> => {
    await vi.waitFor(() => {
      expect(status, "The source launcher exited before review.").toBeUndefined()
      expect(child.pid, "The PTY must report the actual launcher process.").toBeGreaterThan(0)
      // Ink can paint its first screen before its effects enable terminal input.
      expect(inputReady, "The source launcher must enable terminal input.").toBe(true)
      for (const text of texts) expect(screen).toContain(text)
    }, waitOptions)
  }
  const press = (input: string): void => {
    if (status !== undefined) throw new Error("Cannot send input after the launcher exits.")
    child.write(input)
  }
  return {
    get pid(): number | undefined {
      return child.pid
    },
    press,
    waitForText,
    text: (): string => screen,
    async waitForExit(exitCode: number): Promise<void> {
      await vi.waitFor(() => expect(status).toMatchObject({ exitCode }), waitOptions)
      expect(status?.signal ?? 0).toBe(0)
      await flush()
    },
    async finish(): Promise<void> {
      press("q")
      await this.waitForExit(0)
    },
    async close(): Promise<void> {
      try {
        if (status === undefined) {
          child.kill("SIGKILL")
          await vi.waitFor(() => expect(status).toBeDefined(), waitOptions)
        }
        await flush()
      } finally {
        terminal.dispose()
      }
    },
  }
}

type EntryFixture = Awaited<ReturnType<typeof createFixture>>
const it = test.extend<{ fixture: EntryFixture }>({
  fixture: async ({ onTestFailed }, use) => {
    const fixture = await createFixture(onTestFailed)
    try {
      await use(fixture)
    } finally {
      await fixture.close()
    }
  },
})

it("opens installed-style guide assets with the configured helper, saves a real draft, and resumes edits without inference", async ({
  fixture,
}) => {
  const captured = await fixture.capture()
  expect(captured.snapshot.source).toMatchObject({
    surface: ConversationSurface.Host,
    agent: ConversationAgent.Copilot,
    sessionId: fixture.sessionId,
    workspaceId: fixture.context.workspaceId,
    paneId: fixture.context.paneId,
  })
  expect(captured.snapshot.messages.map(({ role, text, recordIndex }) => ({ role, text, recordIndex }))).toEqual([
    { role: ConversationRole.User, text: userText, recordIndex: 1 },
    { role: ConversationRole.Assistant, text: assistantText, recordIndex: 2 },
  ])
  expect((await stat(captured.requestPath)).mode & 0o777).toBe(0o600)
  expect(await fixture.store.find(captured.snapshot.source)).toBeUndefined()
  const before = fixture.requests.length
  const ui = fixture.start(captured.requestPath)
  await ui.waitForText(
    "TRX conversation next steps - Review source before analysis",
    fixture.context.paneId,
    captured.snapshot.cutoff.messageId,
    `Model: ${initialModel}`,
    "Planned calls: 0 summary + 1 assessment",
  )
  const sourceChecks = fixture.requests.slice(before)
  expect(sourceChecks.filter(({ method }) => method === MetadataMethod.Agent).length).toBeGreaterThanOrEqual(2)
  expect(sourceChecks.filter(({ method }) => method === MetadataMethod.Process).length).toBeGreaterThanOrEqual(2)
  expect(sourceChecks.every(({ id }) => ![String(process.pid), String(ui.pid)].includes(id.split("-")[0] ?? ""))).toBe(
    true,
  )
  const draft = await fixture.store.find(captured.snapshot.source)
  expect(draft).toBeDefined()
  if (draft === undefined) throw new Error("The review screen did not persist its draft.")
  expect(draft.snapshot).toEqual(captured.snapshot)
  expect(draft).toMatchObject({
    revision: 0,
    model: initialModel,
    effort: "medium",
    summaries: [],
    actions: [],
  })
  expect(draft.assessment).toBeUndefined()
  await expect(stat(captured.requestPath)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readdir(path.join(fixture.stateRoot, "continuations", "requests"))).toEqual([])

  ui.press("m")
  await ui.waitForText("Edit Analysis and preparation model")
  ui.press("\u0015")
  await vi.waitFor(() => expect(ui.text()).not.toContain(initialModel), waitOptions)
  ui.press(`\u001b[200~${editedModel}\u001b[201~`)
  await ui.waitForText(editedModel)
  ui.press("\r")
  await ui.waitForText("Review source before analysis", `Model: ${editedModel}`, "Draft saved")
  await ui.finish()
  const edited = await fixture.store.load(draft.id)
  expect(edited).toMatchObject({ model: editedModel, revision: 1, actions: [], summaries: [] })
  expect(edited.snapshot).toEqual(captured.snapshot)
  expect(edited.assessment).toBeUndefined()

  const reopened = await fixture.capture()
  expect(reopened.snapshot.id).not.toBe(captured.snapshot.id)
  const resumed = fixture.start(reopened.requestPath, "fixture-ignored-model")
  await resumed.waitForText("Review source before analysis", `Model: ${editedModel}`, captured.snapshot.id)
  resumed.press("r")
  await resumed.waitForText("Saved draft resumed. No model call was made.")
  await resumed.finish()
  expect(await fixture.store.find(captured.snapshot.source)).toEqual(edited)
  expect(await fixture.store.load(draft.id)).toEqual(edited)
  expect(await readdir(path.join(fixture.stateRoot, "continuations", "drafts"))).toEqual([`${draft.id}.json`])
  expect(await readdir(path.join(fixture.stateRoot, "continuations", "requests"))).toEqual([])
  expect((await stat(path.join(fixture.stateRoot, "continuations", "drafts", `${draft.id}.json`))).mode & 0o777).toBe(
    0o600,
  )
  expect((await stat(path.join(fixture.stateRoot, "continuations", "drafts"))).mode & 0o777).toBe(0o700)
  await fixture.assertNoInferenceOrLaunch()
}, 20_000)

it("opens captured source messages from Setup and returns without inference or launch", async ({
  fixture,
}) => {
  const captured = await fixture.capture()
  const ui = fixture.start(captured.requestPath)
  await ui.waitForText(
    "TRX conversation next steps - Review source before analysis",
    "Review source before analysis",
    `Model: ${initialModel}`,
  )

  ui.press("t")
  await ui.waitForText("Messages 1 of 2", "user", userText)
  ui.press("\u001b[C")
  await ui.waitForText("Messages 2 of 2", "assistant", assistantText)
  ui.press("\u001b")
  await ui.waitForText("Review source before analysis")

  await fixture.assertNoInferenceOrLaunch()
  await ui.finish()
}, 20_000)

it("rejects an invalid explicit helper root without consuming the request or changing private state", async ({
  fixture,
}) => {
  const captured = await fixture.capture()
  const originalRequest = await readFile(captured.requestPath)
  const metadataCalls = fixture.requests.length
  const ui = fixture.start(captured.requestPath, initialModel, HelperRootMode.Invalid)
  await ui.waitForExit(2)
  expect(ui.text()).toContain("The conversation helper root must be absolute.")
  expect(ui.text()).not.toContain("Review source before analysis")
  expect(fixture.requests).toHaveLength(metadataCalls)
  expect(await readFile(captured.requestPath)).toEqual(originalRequest)
  expect(await fixture.store.find(captured.snapshot.source)).toBeUndefined()
  expect(await readdir(path.join(fixture.stateRoot, "continuations", "requests"))).toEqual([
    path.basename(captured.requestPath),
  ])
  await fixture.assertNoInferenceOrLaunch()
}, 20_000)

it("resolves the public conversation source entrypoint without a helper root beside installed-style assets", async ({
  fixture,
}) => {
  const captured = await fixture.capture()
  const ui = fixture.start(captured.requestPath, initialModel, HelperRootMode.Automatic)
  await ui.waitForText("Review source before analysis", fixture.context.paneId, `Model: ${initialModel}`)
  await ui.finish()
  const draft = await fixture.store.find(captured.snapshot.source)
  expect(draft?.snapshot).toEqual(captured.snapshot)
  expect(draft?.assessment).toBeUndefined()
  expect(draft?.actions).toEqual([])
  await expect(stat(captured.requestPath)).rejects.toMatchObject({ code: "ENOENT" })
  expect(await readdir(path.join(fixture.stateRoot, "continuations", "requests"))).toEqual([])
  await fixture.assertNoInferenceOrLaunch()
}, 20_000)

it("rejects an actual source-helper session mismatch without consuming the request or changing the saved draft", async ({
  fixture,
}) => {
  const captured = await fixture.capture()
  const saved = await fixture.store.create(captured.snapshot, editedModel, "high")
  const originalRequest = await readFile(captured.requestPath)
  fixture.replaceSession()
  const ui = fixture.start(captured.requestPath)
  await ui.waitForExit(2)
  expect(ui.text()).toContain("The original pane changed sessions")
  expect(ui.text()).not.toContain("Review source before analysis")
  expect(ui.text()).not.toContain(userText)
  expect(ui.text()).not.toContain(assistantText)
  expect(await readFile(captured.requestPath)).toEqual(originalRequest)
  expect(await fixture.store.load(saved.id)).toEqual(saved)
  expect(await readdir(path.join(fixture.stateRoot, "continuations", "requests"))).toEqual([
    path.basename(captured.requestPath),
  ])
  await fixture.assertNoInferenceOrLaunch()
}, 20_000)
