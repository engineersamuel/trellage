import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  captureContextMenuRequest,
  contextMenuRequestFromChoice,
  contextMenuSourceMatches,
  parseContextMenuRequest,
  type ContextMenuRequest,
} from "../lib/context-menu.ts"
import { panelInvocationSource, parseInvocationContext } from "../lib/context.ts"
import { ExactCaptureUnavailableError } from "../lib/capture.ts"
import { readVisibleAgent } from "../lib/herdr.ts"
import { invokeContextMenuChoice, runContextMenuAction } from "../context-menu-action.ts"
import { contextMenuSourceChoice, orderedSourceChoices } from "../custom-popup.ts"
import { removeInvocation, resolvePluginStateDirectory, writeChoice } from "../lib/state.ts"
import { selectLatestVisibleMessage, VisibleMessageSelectionError } from "../lib/visible-message.ts"

const contextSource = (agent = "copilot") => ({
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  cwd: "/repo",
  agent,
})

const contextJson = (agent = "copilot", extra: Record<string, unknown> = {}) => JSON.stringify({
  workspace_id: "workspace-1",
  tab_id: "tab-1",
  focused_pane_id: "pane-1",
  focused_pane_cwd: "/repo",
  focused_pane_agent: agent,
  ...extra,
})

const agentInfo = (overrides: Record<string, unknown> = {}) => ({
  workspace_id: "workspace-1",
  tab_id: "tab-1",
  pane_id: "pane-1",
  terminal_id: "terminal-1",
  agent: "copilot",
  agent_status: "idle",
  ...overrides,
})

const visible = (text: string, overrides: Record<string, unknown> = {}) => ({
  paneId: "pane-1",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  source: "visible",
  format: "text",
  text,
  capturedAt: "2026-09-10T12:00:00.000Z",
  ...overrides,
})

const style = {
  id: "custom",
  title: "Custom voice",
  description: "A local style",
  instruction: "Use short direct sentences.",
} as const

const request = (overrides: Partial<ContextMenuRequest> = {}): ContextMenuRequest => ({
  schemaVersion: 1,
  kind: "rewrite-output",
  source: contextSource(),
  message: {
    paneId: "pane-1",
    role: "harness",
    text: "Latest answer",
    capturedAt: "2026-09-10T12:00:00.000Z",
    source: "visible",
  },
  styles: [style],
  ...overrides,
})

const runAction = async (
  stateDir: string,
  options: {
    readonly context?: string
    readonly capture?: (context: ReturnType<typeof parseInvocationContext>, env: NodeJS.ProcessEnv) => Promise<ContextMenuRequest>
    readonly choiceConsumer?: (directory: string, token: string) => Promise<unknown>
  } = {},
) => {
  const launches: Array<{ readonly args: ReadonlyArray<string>; readonly options: Record<string, unknown> }> = []
  const requests: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = []
  const result = await runContextMenuAction({
    env: {
      HERDR_PLUGIN_CONTEXT_JSON: options.context ?? contextJson(),
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_BIN_PATH: "/usr/bin/herdr",
    },
    ...(options.capture === undefined ? {} : { capture: options.capture }),
    ...(options.choiceConsumer === undefined ? {} : { choiceConsumer: options.choiceConsumer }),
    request: async (method, params) => {
      requests.push({ method, params })
      return {}
    },
    run: async (args, runOptions) => {
      launches.push({ args, options: runOptions as Record<string, unknown> })
    },
  })
  return { result, launches, requests }
}

test("captures exactly the active pane and selects its latest visible harness message", async () => {
  let reads = 0
  const context = parseInvocationContext(contextJson())
  const captured = await captureContextMenuRequest({
    context,
    visibleReader: async () => {
      reads += 1
      return visible("● Earlier answer\n\n● Latest answer\n\n› pending question")
    },
    agentReader: async () => agentInfo(),
  })
  assert.equal(reads, 1)
  assert.equal(captured.kind, "rewrite-output")
  assert.equal(captured.source.paneId, "pane-1")
  assert.equal(captured.message?.text, "Latest answer")
  assert.equal(captured.message?.source, "visible")
})

test("uses the exact latest harness message before consulting the viewport", async () => {
  const context = parseInvocationContext(contextJson())
  const before = agentInfo({
    state_change_seq: 7,
    agent_session: { agent: "copilot", kind: "id", value: "session-1" },
  })
  const process = { pane_id: "pane-1", foreground_processes: [] }
  let visibleCalled = false
  let exactOptions
  const captured = await captureContextMenuRequest({
    context,
    env: { COPILOT_HOME: "/fixture" },
    agentReader: async () => before,
    processReader: async () => process,
    exactCapture: async (options) => {
      exactOptions = options
      return {
        answer: "# Complete transcript answer\n\nwith Markdown.",
        source: "transcript",
        confidence: "exact",
        agent: "copilot",
        sessionId: "session-1",
      }
    },
    visibleReader: async () => {
      visibleCalled = true
      throw new Error("viewport should not be read when exact capture succeeds")
    },
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  })
  assert.equal(visibleCalled, false)
  assert.equal(exactOptions?.marker?.stateChangeSeq, 7)
  assert.equal(exactOptions?.mode, "exact")
  assert.equal(captured.kind, "rewrite-output")
  assert.equal(captured.message?.source, "transcript")
  assert.equal(captured.message?.sessionId, "session-1")
  assert.equal(captured.message?.text, "# Complete transcript answer\n\nwith Markdown.")
})

test("captures a Copilot task completion summary through the real exact transcript path", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "trx-context-menu-jsonl-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const canonicalRoot = await realpath(root)
  const sessionId = "2fa7ae08-b943-4c38-be36-99754414f7a1"
  const home = path.join(canonicalRoot, ".copilot")
  const session = path.join(home, "session-state", sessionId)
  await mkdir(session, { recursive: true })
  await writeFile(path.join(session, "workspace.yaml"), `id: ${sessionId}\ncwd: /repo\n`, "utf8")
  await writeFile(
    path.join(session, "events.jsonl"),
    [
      JSON.stringify({ type: "session.task_complete", data: { summary: "# Long exact answer\n\nThe task completion document." } }),
      JSON.stringify({ type: "assistant.message", data: { content: "" } }),
    ].join("\n") + "\n",
    "utf8",
  )
  const context = parseInvocationContext(contextJson())
  const agent = agentInfo({
    state_change_seq: 9,
    foreground_cwd: "/repo",
    agent_session: { agent: "copilot", kind: "id", value: sessionId },
  })
  let agentReads = 0
  const captured = await captureContextMenuRequest({
    context,
    env: { HOME: canonicalRoot, COPILOT_HOME: home },
    agentReader: async () => {
      agentReads += 1
      return agent
    },
    processReader: async () => ({ pane_id: "pane-1", foreground_processes: [] }),
    visibleReader: async () => {
      throw new Error("viewport should not be needed for an exact JSONL result")
    },
    now: () => new Date("2026-09-10T12:00:00.000Z"),
  })
  assert.equal(agentReads, 2)
  assert.equal(captured.kind, "rewrite-output")
  assert.equal(captured.message?.source, "transcript")
  assert.equal(captured.message?.sessionId, sessionId)
  assert.equal(captured.message?.text, "# Long exact answer\n\nThe task completion document.")
})

test("does not fall back after exact transcript identity or path failures", async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "trx-rewrite-integrity-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary)
  const home = path.join(root, ".copilot")
  const sessionId = "unsafe-session"
  const session = path.join(home, "session-state", sessionId)
  await mkdir(session, { recursive: true })
  await writeFile(path.join(session, "workspace.yaml"), `id: ${sessionId}\ncwd: /repo\n`)
  await writeFile(path.join(root, "outside.jsonl"), "{}\n")
  await symlink(path.join(root, "outside.jsonl"), path.join(session, "events.jsonl"))
  for (const scenario of [
    { name: "invalid session with no root", home: path.join(root, "absent"), id: "invalid/id", processes: [] },
    { name: "conflicting process sessions with no root", home: path.join(root, "absent"), id: "session-1", processes: [
      { name: "copilot", argv: ["copilot", "--session-id", "session-1"] },
      { name: "copilot", argv: ["copilot", "--session-id", "session-2"] },
    ] },
    { name: "unsafe exact transcript", home, id: sessionId, processes: [] },
  ]) {
    await t.test(scenario.name, async () => {
      let visibleReads = 0
      const captured = await captureContextMenuRequest({
        context: parseInvocationContext(contextJson()),
        env: { HOME: path.join(root, "absent-home"), COPILOT_HOME: scenario.home },
        agentReader: async () => agentInfo({
          agent_session: { agent: "copilot", kind: "id", value: scenario.id },
        }),
        processReader: async () => ({ pane_id: "pane-1", foreground_processes: scenario.processes }),
        visibleReader: async () => {
          visibleReads += 1
          return visible("● This fallback must not be used")
        },
      })
      assert.equal(captured.kind, "context-menu-error")
      assert.ok(captured.error?.message)
      assert.equal(visibleReads, 0)
    })
  }
})

test("falls back to strict visible selection only when exact capture is unavailable", async () => {
  const context = parseInvocationContext(contextJson())
  let visibleReads = 0
  const captured = await captureContextMenuRequest({
    context,
    agentReader: async () => agentInfo(),
    processReader: async () => ({ pane_id: "pane-1", foreground_processes: [] }),
    exactCapture: async () => {
      throw new ExactCaptureUnavailableError("no exact transcript")
    },
    visibleReader: async () => {
      visibleReads += 1
      return visible("● Exact fallback")
    },
  })
  assert.equal(visibleReads, 1)
  assert.equal(captured.kind, "rewrite-output")
  assert.equal(captured.message?.source, "visible")
  assert.equal(captured.message?.text, "Exact fallback")
})

test("still attempts exact capture when process metadata is temporarily unavailable", async () => {
  const context = parseInvocationContext(contextJson())
  const sessionId = "session-from-agent"
  const agent = agentInfo({ agent_session: { agent: "copilot", kind: "id", value: sessionId } })
  let processReads = 0
  let exactCalled = false
  const captured = await captureContextMenuRequest({
    context,
    agentReader: async () => agent,
    processReader: async () => {
      processReads += 1
      throw new Error("process info temporarily unavailable")
    },
    exactCapture: async (options) => {
      exactCalled = options.processInfo === undefined
      return { answer: "agent session answer", source: "transcript", confidence: "exact", agent: "copilot", sessionId }
    },
    visibleReader: async () => {
      throw new Error("viewport should not be used")
    },
  })
  assert.equal(exactCalled, true)
  assert.equal(processReads, 2)
  assert.equal(captured.kind, "rewrite-output")
  assert.equal(captured.message?.source, "transcript")
})

test("rejects a process session that disappears while exact capture is in flight", async () => {
  const context = parseInvocationContext(contextJson())
  const processBefore = {
    pane_id: "pane-1",
    foreground_processes: [{ name: "copilot", argv: ["copilot", "--session-id", "session-1"] }],
  }
  const processAfter = { pane_id: "pane-1", foreground_processes: [] }
  let processReads = 0
  let visibleCalled = false
  const captured = await captureContextMenuRequest({
    context,
    agentReader: async () => agentInfo(),
    processReader: async () => {
      processReads += 1
      return processReads === 1 ? processBefore : processAfter
    },
    exactCapture: async () => ({ answer: "stale", source: "transcript", confidence: "exact", agent: "copilot", sessionId: "session-1" }),
    visibleReader: async () => {
      visibleCalled = true
      return visible("● stale fallback")
    },
  })
  assert.equal(captured.kind, "context-menu-error")
  assert.match(captured.error?.message ?? "", /agent session changed/u)
  assert.equal(visibleCalled, false)
})

test("rejects a changed session after exact capture instead of using stale output", async () => {
  const context = parseInvocationContext(contextJson())
  const before = agentInfo({
    state_change_seq: 7,
    agent_session: { agent: "copilot", kind: "id", value: "session-before" },
  })
  const after = agentInfo({
    state_change_seq: 8,
    agent_session: { agent: "copilot", kind: "id", value: "session-after" },
  })
  let visibleCalled = false
  let agentReads = 0
  const captured = await captureContextMenuRequest({
    context,
    agentReader: async () => {
      agentReads += 1
      return agentReads === 1 ? before : after
    },
    processReader: async () => ({ pane_id: "pane-1", foreground_processes: [] }),
    exactCapture: async () => ({ answer: "stale", source: "transcript", confidence: "exact", agent: "copilot", sessionId: "session-before" }),
    visibleReader: async () => {
      visibleCalled = true
      return visible("● stale fallback")
    },
  })
  assert.equal(captured.kind, "context-menu-error")
  assert.match(captured.error?.message ?? "", /agent changed/u)
  assert.equal(visibleCalled, false)
})

test("captures configurable rewrite styles and frozen SDK options", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "trx-context-menu-style-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const custom = { ...style, skillPath: "/repo/style/SKILL.md" }
  const { result } = await runAction(stateDir, {
    capture: async () => captureContextMenuRequest({
      context: parseInvocationContext(contextJson()),
      env: {
        TRELLAGE_GUIDE_REWRITE_CONFIG_JSON: JSON.stringify({
          model: "fixture-model",
          effort: "high",
          timeoutMs: 12_345,
          styles: [custom],
        }),
      },
      visibleReader: async () => visible("● Answer"),
      agentReader: async () => agentInfo(),
    }),
  })
  assert.deepEqual(result.request.styles, [custom])
  assert.equal(result.request.model, "fixture-model")
  assert.equal(result.request.effort, "high")
  assert.equal(result.request.timeoutMs, 12_345)
})

test("captures the latest answer for direct actions with ordinary terminal text selected", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "trx-context-menu-selection-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const captured = request()
  const { result, launches, requests } = await runAction(stateDir, {
    context: contextJson("copilot", { invocation_source: "pane", selected_text: "ordinary terminal text" }),
    capture: async () => captured,
    choiceConsumer: async () => { throw new Error("Terminal selection is not a picker token") },
  })
  assert.deepEqual(result.request, captured)
  assert.equal(launches.length, 1)
  assert.deepEqual(requests, [])
})

test("offers Rewrite output first and captures its source once when the picker opens", () => {
  const source = contextMenuSourceChoice(request())
  assert.equal(source.label, "Rewrite output")
  assert.equal(source.disabled, false)
  assert.equal(orderedSourceChoices([], undefined, { entries: [] }, source)[0], source)
  const unavailable = contextMenuSourceChoice({ ...request(), kind: "context-menu-error", message: undefined, error: { code: "missing", message: "No visible message" } })
  assert.equal(unavailable.disabled, true)
  assert.match(unavailable.detail, /No visible message/u)
})

test("routes a frozen picker choice through an opaque one-use token and private popup request", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "trx-context-menu-choice-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const picked = request({ message: { ...request().message!, text: "Captured before pane changed" } })
  let actionContext: Record<string, unknown> | undefined
  const token = await invokeContextMenuChoice({
    request: picked,
    context: parseInvocationContext(contextJson()),
    stateDir,
    herdr: async (_method, params) => {
      actionContext = params.context as Record<string, unknown>
      return {}
    },
  })
  assert.equal(typeof token, "string")
  assert.equal(actionContext?.selected_text, token)
  assert.equal(actionContext?.focused_pane_agent, "copilot")
  const { result, launches } = await runAction(stateDir, { context: JSON.stringify(actionContext) })
  assert.equal(result.request.message?.text, "Captured before pane changed")
  assert.equal(launches[0]?.args.at(-1), "--focus")
  await removeInvocation(result.requestPath)
})

test("rejects a staged choice when the active pane identity changed", async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "trx-context-menu-changed-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const token = await writeChoice(stateDir, { schemaVersion: 1, kind: "context-menu", request: request() })
  await assert.rejects(
    runAction(stateDir, { context: contextJson("copilot", { focused_pane_id: "pane-2", invocation_source: panelInvocationSource, selected_text: token }) }),
    /source changed/u,
  )
})

test("surfaces missing pane, missing message, truncation, and ambiguous viewport failures", async () => {
  const context = parseInvocationContext(contextJson())
  const capture = (read: Record<string, unknown>) => captureContextMenuRequest({
    context,
    visibleReader: async () => read,
    agentReader: async () => agentInfo(),
  })
  const missing = await capture(visible("› only a user prompt"))
  assert.equal(missing.kind, "context-menu-error")
  assert.match(missing.error?.message ?? "", /No visible harness/u)
  const truncated = await capture(visible("● Answer", { truncated: true }))
  assert.equal(truncated.kind, "context-menu-error")
  assert.match(truncated.error?.message ?? "", /truncated/u)
  const ambiguous = await capture(visible("A message without a turn marker"))
  assert.equal(ambiguous.kind, "context-menu-error")
  assert.match(ambiguous.error?.message ?? "", /viewport starts/u)
  const changed = await capture(visible("● Answer", { paneId: "pane-2" }))
  assert.equal(changed.kind, "context-menu-error")
  assert.match(changed.error?.message ?? "", /different pane/u)
})

test("validates the request and binds its message to the exact pane", () => {
  assert.equal(contextMenuSourceMatches(request(), parseInvocationContext(contextJson())), true)
  assert.equal(contextMenuSourceMatches(request(), parseInvocationContext(contextJson("copilot", { focused_pane_cwd: "/other" }))), false)
  assert.deepEqual(contextMenuRequestFromChoice({ schemaVersion: 1, kind: "context-menu", request: request() }), request())
  assert.throws(() => parseContextMenuRequest({ ...request(), message: { ...request().message!, paneId: "other" } }), /different pane/u)
})

test("reads Herdr's visible source and preserves its pane metadata", async () => {
  const result = await readVisibleAgent("pane-1", {
    socketPath: await (async () => {
      const net = await import("node:net")
      const directory = await mkdtemp(path.join(tmpdir(), "trx-context-menu-herdr-"))
      const socketPath = path.join(directory, "api.sock")
      const server = net.createServer((socket) => {
        let source = ""
        socket.setEncoding("utf8")
        socket.on("data", (chunk) => {
          source += chunk
          const newline = source.indexOf("\n")
          if (newline < 0) return
          const request = JSON.parse(source.slice(0, newline)) as Record<string, unknown>
          socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_read", read: { pane_id: "pane-1", workspace_id: "workspace-1", tab_id: "tab-1", source: "visible", format: "text", text: "● Visible answer", captured_at: "2026-09-10T12:00:00.000Z" } } })}\n`)
        })
      })
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve) })
      test.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
      return socketPath
    })(),
  })
  assert.equal(result.text, "● Visible answer")
  assert.equal(result.source, "visible")
})

test("selects complete latest output and preserves Markdown code indentation", () => {
  const selected = selectLatestVisibleMessage({
    paneId: "pane-1",
    agent: "codex",
    text: [
      "• Earlier answer",
      "",
      "• Latest answer",
      "",
      "  First paragraph.",
      "",
      "    ```python",
      "    if ready:",
      "        run()",
      "    ```",
      "",
      "› Ask Codex to do anything",
    ].join("\n"),
  })
  assert.equal(selected.text, ["Latest answer", "", "First paragraph.", "", "```python", "if ready:", "    run()", "```"].join("\n"))
})

test("reports missing, ambiguous, and truncated visible selections", () => {
  assert.throws(
    () => selectLatestVisibleMessage({ paneId: "pane-1", agent: "copilot", text: "› only a user prompt" }),
    (error: unknown) => error instanceof VisibleMessageSelectionError && error.code === "missing",
  )
  assert.throws(
    () => selectLatestVisibleMessage({ paneId: "pane-1", agent: "copilot", text: "A message without a turn marker" }),
    (error: unknown) => error instanceof VisibleMessageSelectionError && error.code === "ambiguous",
  )
  assert.throws(
    () => selectLatestVisibleMessage({ paneId: "pane-1", agent: "copilot", text: "● Answer", truncated: true }),
    (error: unknown) => error instanceof VisibleMessageSelectionError && error.code === "truncated",
  )
})
