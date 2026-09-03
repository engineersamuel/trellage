import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import {
  appendCaptureQueue,
  consumeChoice,
  consumeInvocation,
  readCaptureQueue,
  writeChoice,
  writeInvocation,
} from "../lib/state.ts"

const execFileAsync = promisify(execFile)
const pluginRoot = fileURLToPath(new URL("..", import.meta.url))
const actionEntrypoint = path.join(pluginRoot, "action.ts")
const latestPopupEntrypoint = path.join(pluginRoot, "latest-popup.ts")
const popupEntrypoint = path.join(pluginRoot, "popup.ts")

const execFileWithInput = (executable, args, options, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(executable, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout, stderr })
    })
    child.stdin.end(input)
  })

const waitForJsonFile = async (target) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(target, "utf8"))
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`Timed out waiting for ${target}`)
}

const socketServer = async (t, responseFor) => {
  const directory = await mkdtemp(path.join(tmpdir(), "herdr-guide-entry-socket-"))
  const socketPath = path.join(directory, "api.sock")
  const server = net.createServer((socket) => {
    let source = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      source += chunk
      const newline = source.indexOf("\n")
      if (newline < 0) return
      const request = JSON.parse(source.slice(0, newline))
      const response = responseFor(request)
      const envelope =
        response?.error === undefined
          ? { id: request.id, result: response }
          : { id: request.id, error: response.error }
      socket.end(`${JSON.stringify(envelope)}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return socketPath
}

const writeCaptureExecutable = async (directory, name, capturePath) => {
  const executable = path.join(directory, name)
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs")
let stdin = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => { stdin += chunk })
process.stdin.on("end", () => {
  const intentPath = process.env.TRELLAGE_GUIDE_HERDR_INTENT_FILE
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    context: process.env.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON,
    intentPath,
    intent: intentPath ? fs.readFileSync(intentPath, "utf8") : undefined,
    stdin,
  }))
})
`,
    "utf8",
  )
  await chmod(executable, 0o755)
  return executable
}

test("action stages selected text and opens the guide popup without answer text in popup env", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-action-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const capturePath = path.join(root, "herdr-call.json")
  const fakeHerdr = await writeCaptureExecutable(root, "herdr", capturePath)
  const socketPath = await socketServer(t, (request) => {
    if (request.method === "agent.get") {
      return {
        type: "agent_info",
        agent: {
          workspace_id: "w1",
          pane_id: "w1:p1",
          agent: "copilot",
          agent_status: "done",
          state_change_seq: 3,
          cwd: "/repo",
        },
      }
    }
    assert.equal(request.method, "pane.process_info")
    return { type: "pane_process_info", process_info: { pane_id: "w1:p1", foreground_processes: [] } }
  })
  await execFileAsync(process.execPath, [actionEntrypoint], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: root,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: "w1",
        focused_pane_id: "w1:p1",
        focused_pane_cwd: "/repo",
        focused_pane_agent: "copilot",
        selected_text: "Selected\nanswer",
      }),
    },
  })

  const call = JSON.parse(await readFile(capturePath, "utf8"))
  assert.deepEqual(call.argv.slice(0, 6), [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "trellage.guide-handoff",
    "--entrypoint",
  ])
  assert.equal(call.argv[6], "guide")
  const envArgument = call.argv.find((argument) => argument.startsWith("TRELLAGE_GUIDE_INVOCATION_PATH="))
  assert.ok(envArgument)
  assert.equal(call.argv.some((argument) => argument.includes("Selected\nanswer")), false)
  const invocationPath = envArgument.slice("TRELLAGE_GUIDE_INVOCATION_PATH=".length)
  const invocation = await consumeInvocation(root, invocationPath)
  assert.equal(invocation.answer, "Selected\nanswer")
  assert.deepEqual(invocation.source, { workspaceId: "w1", paneId: "w1:p1", cwd: "/repo" })
})

test("action queues a selected source without opening the full guide", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-action-queue-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const notificationPath = path.join(root, "notification.json")
  const fakeHerdr = await writeCaptureExecutable(root, "herdr", notificationPath)
  const socketPath = await socketServer(t, (request) => {
    assert.equal(request.method, "popup.close")
    return { type: "popup_closed" }
  })
  const token = await writeChoice(root, {
    schemaVersion: 1,
    kind: "selection",
    operation: "enqueue",
    selectedText: "First queued selection",
  })
  await execFileAsync(process.execPath, [actionEntrypoint], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: root,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: "w1",
        focused_pane_id: "w1:p1",
        focused_pane_cwd: "/repo",
        invocation_source: "trellage-guide-panel",
        selected_text: token,
      }),
    },
  })
  assert.deepEqual((await readCaptureQueue(root)).entries.map((entry) => entry.answer), ["First queued selection"])
  const notification = await waitForJsonFile(notificationPath)
  assert.deepEqual(notification.argv.slice(0, 3), ["notification", "show", "Added to Trellage capture queue"])
})

test("action opens and clears the persistent capture queue in insertion order", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-action-open-queue-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const capturePath = path.join(root, "herdr-call.json")
  const fakeHerdr = await writeCaptureExecutable(root, "herdr", capturePath)
  const socketPath = await socketServer(t, (request) => {
    assert.equal(request.method, "popup.close")
    return { type: "popup_closed" }
  })
  await appendCaptureQueue(root, { answer: "First capture" })
  await appendCaptureQueue(root, { answer: "Second capture" })
  const token = await writeChoice(root, { schemaVersion: 1, kind: "queue" })
  await execFileAsync(process.execPath, [actionEntrypoint], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: root,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: "w1",
        focused_pane_id: "w1:p1",
        focused_pane_cwd: "/repo",
        invocation_source: "trellage-guide-panel",
        selected_text: token,
      }),
    },
  })
  const call = await waitForJsonFile(capturePath)
  const envArgument = call.argv.find((argument) => argument.startsWith("TRELLAGE_GUIDE_INVOCATION_PATH="))
  const invocation = await consumeInvocation(root, envArgument.slice("TRELLAGE_GUIDE_INVOCATION_PATH=".length))
  assert.equal(invocation.answer, "## Captured item 1\n\nFirst capture\n\n---\n\n## Captured item 2\n\nSecond capture")
  assert.deepEqual(invocation.capture, { source: "capture-queue", confidence: "user-curated" })
  assert.equal((await readCaptureQueue(root)).entries.length, 0)
})

test("action preserves captures appended after the opened queue snapshot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-action-queue-race-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const capturePath = path.join(root, "herdr-call.json")
  const fakeHerdr = path.join(root, "herdr")
  const stateModuleUrl = new URL("../lib/state.ts", import.meta.url).href
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env node
const fs = require("node:fs")
;(async () => {
  const { appendCaptureQueue } = await import(${JSON.stringify(stateModuleUrl)})
  await appendCaptureQueue(process.env.HERDR_PLUGIN_STATE_DIR, {
    id: "later",
    answer: "Capture appended while the guide opened"
  })
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
    argv: process.argv.slice(2)
  }))
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
`,
    "utf8",
  )
  await chmod(fakeHerdr, 0o755)
  const socketPath = await socketServer(t, (request) => {
    assert.equal(request.method, "popup.close")
    return { type: "popup_closed" }
  })
  await appendCaptureQueue(root, { id: "snapshot-1", answer: "First capture" })
  await appendCaptureQueue(root, { id: "snapshot-2", answer: "Second capture" })
  const token = await writeChoice(root, { schemaVersion: 1, kind: "queue" })

  await execFileAsync(process.execPath, [actionEntrypoint], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: root,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: "w1",
        focused_pane_id: "w1:p1",
        focused_pane_cwd: "/repo",
        invocation_source: "trellage-guide-panel",
        selected_text: token,
      }),
    },
  })

  const call = await waitForJsonFile(capturePath)
  const envArgument = call.argv.find((argument) =>
    argument.startsWith("TRELLAGE_GUIDE_INVOCATION_PATH="),
  )
  const invocation = await consumeInvocation(
    root,
    envArgument.slice("TRELLAGE_GUIDE_INVOCATION_PATH=".length),
  )
  assert.equal(
    invocation.answer,
    "## Captured item 1\n\nFirst capture\n\n---\n\n## Captured item 2\n\nSecond capture",
  )
  assert.deepEqual((await readCaptureQueue(root)).entries.map((entry) => entry.id), ["later"])
})

test("popup keeps stdin attached while staging a multiline intent for interactive raw mode", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-popup-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, "bin")
  const capturePath = path.join(root, "mise-call.json")
  await mkdir(bin)
  await writeCaptureExecutable(bin, "mise", capturePath)
  const invocationPath = await writeInvocation(root, {
    schemaVersion: 1,
    answer: "---\nresult: complete",
    capture: {
      source: "transcript",
      confidence: "exact",
      agent: "copilot",
      sessionId: "session-1",
      identitySource: "herdr-session-id",
    },
    source: { workspaceId: "w1", paneId: "w1:p1", cwd: "/repo" },
  })

  await execFileWithInput(
    process.execPath,
    [popupEntrypoint],
    {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HERDR_BIN_PATH: "",
        HERDR_ENV: "1",
        HERDR_PLUGIN_ROOT: pluginRoot,
        HERDR_PLUGIN_STATE_DIR: root,
        TRELLAGE_GUIDE_INVOCATION_PATH: invocationPath,
      },
    },
    "popup keyboard input",
  )

  const call = JSON.parse(await readFile(capturePath, "utf8"))
  assert.deepEqual(call.argv, ["run", "--raw", "trx", "--", "guide"])
  assert.equal(call.stdin, "popup keyboard input")
  assert.equal(call.intent, "---\nresult: complete")
  assert.equal(path.dirname(call.intentPath), path.join(root, "guide-intents"))
  assert.equal(call.cwd, path.resolve(pluginRoot, "..", ".."))
  assert.deepEqual(JSON.parse(call.context), {
    schemaVersion: 1,
    surface: "popup",
    workspaceId: "w1",
    paneId: "w1:p1",
    cwd: "/repo",
    capture: {
      source: "transcript",
      confidence: "exact",
      agent: "copilot",
      sessionId: "session-1",
      identitySource: "herdr-session-id",
    },
  })
  await assert.rejects(readFile(invocationPath, "utf8"), { code: "ENOENT" })
  await assert.rejects(readFile(call.intentPath, "utf8"), { code: "ENOENT" })
})

test("popup termination removes an intent that the launcher has not consumed", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-popup-signal-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, "bin")
  const capturePath = path.join(root, "mise-waiting.json")
  await mkdir(bin)
  const fakeMise = path.join(bin, "mise")
  await writeFile(
    fakeMise,
    `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  pid: process.pid,
  intentPath: process.env.TRELLAGE_GUIDE_HERDR_INTENT_FILE
}))
setInterval(() => {}, 1000)
`,
    "utf8",
  )
  await chmod(fakeMise, 0o755)
  const invocationPath = await writeInvocation(root, {
    schemaVersion: 1,
    answer: "Unconsumed answer",
    capture: { source: "selection", confidence: "user-selected" },
    source: { workspaceId: "w1", paneId: "w1:p1", cwd: "/repo" },
  })
  const child = spawn(process.execPath, [popupEntrypoint], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      HERDR_BIN_PATH: "",
      HERDR_ENV: "1",
      HERDR_PLUGIN_ROOT: pluginRoot,
      HERDR_PLUGIN_STATE_DIR: root,
      TRELLAGE_GUIDE_INVOCATION_PATH: invocationPath,
    },
    stdio: "ignore",
  })
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (status, signal) => resolve({ status, signal }))
  })
  const waiting = await waitForJsonFile(capturePath)
  t.after(() => {
    try {
      process.kill(waiting.pid, "SIGTERM")
    } catch (error) {
      if (error?.code !== "ESRCH") throw error
    }
  })

  child.kill("SIGTERM")
  assert.deepEqual(await exit, { status: null, signal: "SIGTERM" })
  await assert.rejects(readFile(waiting.intentPath, "utf8"), { code: "ENOENT" })
  process.kill(waiting.pid, "SIGTERM")
})

test("latest popup uses one exact completed agent from a focused shell", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-latest-popup-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, "bin")
  const copilotHome = path.join(root, ".copilot")
  const sessionId = "88888888-8888-4888-8888-888888888888"
  const sessionDirectory = path.join(copilotHome, "session-state", sessionId)
  const capturePath = path.join(root, "mise-call.json")
  await mkdir(bin)
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(path.join(sessionDirectory, "workspace.yaml"), `cwd: /repo\n`, "utf8")
  await writeFile(
    path.join(sessionDirectory, "events.jsonl"),
    `${JSON.stringify({
      type: "assistant.message",
      data: { phase: "final_answer", content: "Latest completed answer" },
    })}\n`,
    "utf8",
  )
  await writeCaptureExecutable(bin, "mise", capturePath)
  const socketPath = await socketServer(t, (request) => {
    if (request.method === "agent.get") {
      assert.deepEqual(request.params, { target: "w1:p1" })
      return {
        error: {
          code: "agent_not_found",
          message: "agent target w1:p1 not found",
        },
      }
    }
    if (request.method === "agent.list") {
      return {
        type: "agent_list",
        agents: [
          {
            workspace_id: "w1",
            tab_id: "w1:t1",
            pane_id: "w1:p2",
            agent: "copilot",
            agent_status: "idle",
            state_change_seq: 7,
            cwd: "/repo",
            agent_session: {
              source: "herdr:copilot",
              agent: "copilot",
              kind: "id",
              value: sessionId,
            },
          },
        ],
      }
    }
    if (request.method === "pane.process_info") {
      assert.deepEqual(request.params, { pane_id: "w1:p2" })
      return {
        type: "pane_process_info",
        process_info: { pane_id: "w1:p2", foreground_processes: [] },
      }
    }
    throw new Error(`unexpected method: ${request.method}`)
  })

  await execFileWithInput(
    process.execPath,
    [latestPopupEntrypoint],
    {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HERDR_BIN_PATH: "",
        HERDR_SOCKET_PATH: socketPath,
        COPILOT_HOME: copilotHome,
        HOME: root,
        HERDR_ACTIVE_WORKSPACE_ID: "w1",
        HERDR_ACTIVE_TAB_ID: "w1:t1",
        HERDR_ACTIVE_PANE_ID: "w1:p1",
        HERDR_ACTIVE_PANE_CWD: "/repo",
      },
    },
    "",
  )

  const call = JSON.parse(await readFile(capturePath, "utf8"))
  assert.deepEqual(call.argv, ["run", "--raw", "trx", "--", "guide"])
  assert.equal(call.stdin, "")
  assert.equal(call.intent, "Latest completed answer")
  assert.equal(
    path.dirname(call.intentPath),
    path.join(root, ".local", "state", "herdr", "plugins", "trellage.guide-handoff", "guide-intents"),
  )
  assert.deepEqual(JSON.parse(call.context), {
    schemaVersion: 1,
    surface: "popup",
    workspaceId: "w1",
    paneId: "w1:p2",
    cwd: "/repo",
    capture: {
      source: "transcript",
      confidence: "exact",
      agent: "copilot",
      sessionId,
      identitySource: "herdr-session-id",
    },
  })
  await assert.rejects(readFile(call.intentPath, "utf8"), { code: "ENOENT" })
})

test("latest popup keeps a visible warning when exact capture is unavailable", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-latest-warning-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const socketPath = await socketServer(t, (request) => {
    if (request.method === "agent.get") {
      return {
        type: "agent_info",
        agent: {
          workspace_id: "w1",
          tab_id: "w1:t1",
          pane_id: "w1:p1",
          agent: "copilot",
          agent_status: "done",
          state_change_seq: 9,
          cwd: "/repo",
        },
      }
    }
    if (request.method === "pane.process_info") {
      return {
        type: "pane_process_info",
        process_info: { pane_id: "w1:p1", foreground_processes: [] },
      }
    }
    throw new Error(`unexpected method: ${request.method}`)
  })

  await assert.rejects(
    execFileAsync(process.execPath, [latestPopupEntrypoint], {
      env: {
        ...process.env,
        HERDR_SOCKET_PATH: socketPath,
        HOME: root,
        HERDR_ACTIVE_WORKSPACE_ID: "w1",
        HERDR_ACTIVE_TAB_ID: "w1:t1",
        HERDR_ACTIVE_PANE_ID: "w1:p1",
        HERDR_ACTIVE_PANE_CWD: "/repo",
      },
    }),
    (error) => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Cannot open the latest agent result/u)
      assert.match(error.stderr, /No exact session identity is available/u)
      return true
    },
  )
})

test("a maximum CJK panel selection uses a short standard context token", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-panel-action-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const capturePath = path.join(root, "herdr-call.json")
  const fakeHerdr = await writeCaptureExecutable(root, "herdr", capturePath)
  const methods = []
  const socketPath = await socketServer(t, (request) => {
    methods.push(request.method)
    assert.equal(request.method, "popup.close")
    return { type: "ok" }
  })
  const selection = "界".repeat(60_000)
  const choiceToken = await writeChoice(root, {
    schemaVersion: 1,
    kind: "selection",
    selectedText: selection,
  })

  await execFileAsync(process.execPath, [actionEntrypoint], {
    env: {
      ...process.env,
      HERDR_BIN_PATH: fakeHerdr,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: root,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: "w1",
        focused_pane_id: "w1:p1",
        focused_pane_cwd: "/repo",
        selected_text: choiceToken,
        invocation_source: "trellage-guide-panel",
      }),
    },
  })

  assert.deepEqual(methods, ["popup.close"])
  const call = JSON.parse(await readFile(capturePath, "utf8"))
  const envArgument = call.argv.find((argument) => argument.startsWith("TRELLAGE_GUIDE_INVOCATION_PATH="))
  assert.ok(envArgument)
  const invocationPath = envArgument.slice("TRELLAGE_GUIDE_INVOCATION_PATH=".length)
  const invocation = await consumeInvocation(root, invocationPath)
  assert.equal(invocation.answer, selection)
  assert.equal(invocation.capture.source, "selection")
  assert.equal(invocation.capture.confidence, "user-selected")
  await assert.rejects(consumeChoice(root, choiceToken), { code: "ENOENT" })
})

test("panel capture choices survive Herdr's supported action context", async (t) => {
  const scenarios = [
    {
      name: "exact result from another pane",
      kind: "exact",
      answer: "Exact result from selected pane",
      sessionId: "77777777-7777-4777-8777-777777777777",
      expectedMethods: ["agent.get", "pane.process_info", "popup.close"],
    },
    {
      name: "terminal snapshot from another pane",
      kind: "terminal",
      answer: "Visible terminal result",
      expectedMethods: ["agent.get", "pane.process_info", "agent.read", "popup.close"],
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-panel-source-"))
      subtest.after(() => rm(root, { recursive: true, force: true }))
      const capturePath = path.join(root, "herdr-call.json")
      const fakeHerdr = await writeCaptureExecutable(root, "herdr", capturePath)
      const copilotHome = path.join(root, ".copilot")
      if (scenario.sessionId !== undefined) {
        const sessionDirectory = path.join(copilotHome, "session-state", scenario.sessionId)
        await mkdir(sessionDirectory, { recursive: true })
        await writeFile(path.join(sessionDirectory, "workspace.yaml"), "cwd: /source\n", "utf8")
        await writeFile(
          path.join(sessionDirectory, "events.jsonl"),
          `${JSON.stringify({
            type: "assistant.message",
            data: { phase: "final_answer", content: scenario.answer },
          })}\n`,
          "utf8",
        )
      }

      const methods = []
      const socketPath = await socketServer(subtest, (request) => {
        methods.push(request.method)
        if (request.method === "agent.get") {
          assert.deepEqual(request.params, { target: "w1:p2" })
          return {
            type: "agent_info",
            agent: {
              workspace_id: "w1",
              pane_id: "w1:p2",
              agent: "copilot",
              agent_status: "done",
              state_change_seq: 11,
              cwd: "/source",
              ...(scenario.sessionId === undefined
                ? {}
                : {
                    agent_session: {
                      source: "herdr:copilot",
                      agent: "copilot",
                      kind: "id",
                      value: scenario.sessionId,
                    },
                  }),
            },
          }
        }
        if (request.method === "pane.process_info") {
          assert.deepEqual(request.params, { pane_id: "w1:p2" })
          return {
            type: "pane_process_info",
            process_info: { pane_id: "w1:p2", foreground_processes: [] },
          }
        }
        if (request.method === "agent.read") {
          assert.deepEqual(request.params, {
            target: "w1:p2",
            source: "recent_unwrapped",
            format: "text",
            strip_ansi: true,
          })
          return {
            type: "pane_read",
            read: { text: scenario.answer, truncated: false },
          }
        }
        assert.equal(request.method, "popup.close")
        return { type: "ok" }
      })
      const choiceToken = await writeChoice(root, {
        schemaVersion: 1,
        kind: scenario.kind,
        paneId: "w1:p2",
        stateChangeSeq: 11,
        ...(scenario.sessionId === undefined ? {} : { sessionId: scenario.sessionId }),
      })
      const supportedContext = {
        workspace_id: "w1",
        focused_pane_id: "w1:p1",
        focused_pane_cwd: "/shell",
        selected_text: choiceToken,
        invocation_source: "trellage-guide-panel",
      }

      await execFileAsync(process.execPath, [actionEntrypoint], {
        env: {
          ...process.env,
          HERDR_BIN_PATH: fakeHerdr,
          HERDR_SOCKET_PATH: socketPath,
          HERDR_PLUGIN_STATE_DIR: root,
          HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(supportedContext),
          COPILOT_HOME: copilotHome,
          HOME: root,
        },
      })

      assert.deepEqual(methods, scenario.expectedMethods)
      const call = JSON.parse(await readFile(capturePath, "utf8"))
      const envArgument = call.argv.find((argument) =>
        argument.startsWith("TRELLAGE_GUIDE_INVOCATION_PATH="),
      )
      assert.ok(envArgument)
      const invocation = await consumeInvocation(
        root,
        envArgument.slice("TRELLAGE_GUIDE_INVOCATION_PATH=".length),
      )
      assert.equal(invocation.answer, scenario.answer)
      assert.equal(invocation.source.paneId, "w1:p2")
      assert.equal(invocation.source.cwd, "/source")
      assert.equal(invocation.capture.source, scenario.kind === "exact" ? "transcript" : "terminal")
      await assert.rejects(consumeChoice(root, choiceToken), { code: "ENOENT" })
    })
  }
})
