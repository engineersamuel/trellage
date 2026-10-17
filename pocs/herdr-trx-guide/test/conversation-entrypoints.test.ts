import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { bindFocusedConversation, captureFocusedConversation } from "../lib/conversation-capture.ts"
import { readConversationRequest, writeConversationChoice, writeConversationRequest } from "../lib/conversation-state.ts"
import { captureFixture, humanRecord, jsonl, repositoryRoot } from "./helpers/conversation-fixtures.ts"

const execFileAsync = promisify(execFile)
const pluginRoot = path.join(repositoryRoot, "pocs", "herdr-trx-guide")
const entrypoint = (name) => path.join(pluginRoot, name)

const socketServer = async (t, fixture) => {
  const socketPath = path.join(fixture.root, "h.sock")
  const calls = []
  const server = net.createServer((socket) => {
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline === -1) return
      const request = JSON.parse(buffer.slice(0, newline))
      calls.push(request)
      let result
      if (request.method === "agent.get") {
        result = { type: "agent_info", agent: { ...fixture.agentInfo, state_change_seq: ++fixture.agentInfo.state_change_seq } }
      } else if (request.method === "pane.process_info") {
        result = { type: "pane_process_info", process_info: fixture.processInfo }
      } else if (request.method === "popup.close") result = { type: "popup_closed" }
      else throw new Error(`Unexpected fake Herdr method ${request.method}`)
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`)
    })
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { socketPath, calls }
}

const fakeCommand = async (root, name) => {
  const binary = path.join(root, name)
  const outputPath = path.join(root, `${name}-call.json`)
  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  requestPath: process.env.TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE,
  helperRoot: process.env.TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT,
  stateDir: process.env.HERDR_PLUGIN_STATE_DIR,
  context: process.env.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON,
  paneId: process.env.HERDR_PANE_ID,
  pluginContext: process.env.HERDR_PLUGIN_CONTEXT_JSON,
  legacyIntent: process.env.TRELLAGE_GUIDE_HERDR_INTENT_FILE
}))
`, { mode: 0o755 })
  return { binary, outputPath }
}

const executableFixture = async (t) => {
  const fixture = await captureFixture(t)
  const server = await socketServer(t, fixture)
  const herdr = await fakeCommand(fixture.root, "herdr")
  const env = {
    ...process.env, ...fixture.env,
    HERDR_SOCKET_PATH: server.socketPath,
    HERDR_BIN_PATH: herdr.binary,
    HERDR_PLUGIN_ROOT: pluginRoot,
    PATH: `${fixture.root}${path.delimiter}${process.env.PATH}`,
  }
  return { ...fixture, server, herdr, env }
}

test("action captures on explicit selection and stages only a private snapshot path for the conversation popup", async (t) => {
  const fixture = await executableFixture(t)
  const binding = await bindFocusedConversation(fixture.context, { env: fixture.env })
  const token = await writeConversationChoice(fixture.root, binding)
  const queuePath = path.join(fixture.root, "capture-queue.json")
  const queue = '{"schemaVersion":1,"entries":[{"id":"keep","answer":"Keep queued text"}]}\n'
  await writeFile(queuePath, queue, { mode: 0o600 })
  const result = await execFileAsync(process.execPath, [entrypoint("conversation-action.ts")], {
    env: {
      ...fixture.env,
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        workspace_id: fixture.context.workspaceId, tab_id: fixture.context.tabId,
        focused_pane_id: fixture.context.paneId, focused_pane_cwd: fixture.context.cwd,
        invocation_source: "trellage-guide-panel", selected_text: token,
      }),
    },
  })
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  const call = JSON.parse(await readFile(fixture.herdr.outputPath, "utf8"))
  assert.deepEqual(call.argv.slice(0, 7), [
    "plugin", "pane", "open", "--plugin", "trellage.guide-handoff", "--entrypoint", "conversation",
  ])
  const envArg = call.argv.find((argument) => argument.startsWith("TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE="))
  assert.ok(envArg)
  assert.doesNotMatch(JSON.stringify(call), /Original human goal|Completed visible answer|Pending human/u)
  const requestPath = envArg.slice("TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE=".length)
  const snapshot = await readConversationRequest(fixture.root, requestPath)
  assert.equal(snapshot.messages[0].text, "Original human goal")
  assert.equal(snapshot.source.paneId, fixture.context.paneId)
  assert.equal(await readFile(queuePath, "utf8"), queue)
  assert.ok(fixture.server.calls.some((call) => call.method === "popup.close"))
  assert.ok(fixture.server.calls.every((call) => !["agent.list", "agent.read"].includes(call.method)))
})

test("conversation popup starts the guide with a trusted helper checkout and minimal context", async (t) => {
  const fixture = await executableFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, { env: fixture.env })
  const requestPath = await writeConversationRequest(fixture.root, snapshot)
  const mise = await fakeCommand(fixture.root, "mise")
  await execFileAsync(process.execPath, [entrypoint("conversation-popup.ts")], {
    env: {
      ...fixture.env,
      TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE: requestPath,
      TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT: fixture.cwd,
      HERDR_PANE_ID: "popup-pane",
      HERDR_PLUGIN_CONTEXT_JSON: '{"selected_text":"DO NOT FORWARD THIS TEXT"}',
      TRELLAGE_GUIDE_HERDR_INTENT_FILE: "/unused-legacy-intent",
    },
  })
  const call = JSON.parse(await readFile(mise.outputPath, "utf8"))
  assert.deepEqual(call.argv, ["run", "--raw", "trx", "--", "guide", "--next-steps"])
  assert.equal(call.cwd, repositoryRoot)
  assert.equal(call.requestPath, requestPath)
  assert.equal(call.helperRoot, repositoryRoot)
  assert.notEqual(call.helperRoot, snapshot.source.cwd)
  assert.equal(call.stateDir, fixture.root)
  assert.deepEqual(JSON.parse(call.context), {
    schemaVersion: 1,
    surface: "popup",
    workspaceId: snapshot.source.workspaceId,
    paneId: snapshot.source.paneId,
    cwd: snapshot.source.cwd,
  })
  assert.equal(call.paneId, undefined)
  assert.equal(call.pluginContext, undefined)
  assert.equal(call.legacyIntent, undefined)
  assert.doesNotMatch(JSON.stringify(call), /Original human goal|Completed visible answer|DO NOT FORWARD/u)
  assert.deepEqual(await readConversationRequest(fixture.root, requestPath), snapshot)
})

test("source freshness CLI checks the original exact pane and prints no captured text", async (t) => {
  const fixture = await executableFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, { env: fixture.env })
  const requestPath = await writeConversationRequest(fixture.root, snapshot)
  const runCheck = async (target = requestPath) => {
    const result = await execFileAsync(process.execPath, [entrypoint("conversation-source.ts"), "--check", target], {
      env: fixture.env,
    })
    assert.equal(result.stderr, "")
    assert.doesNotMatch(result.stdout, /Original human goal|Completed visible answer|Pending human follow-up|New follow-up/u)
    const value = JSON.parse(result.stdout)
    assert.ok(Object.keys(value).every((key) => ["sameSource", "revision", "advanced", "message"].includes(key)))
    return value
  }
  const before = await runCheck()
  assert.deepEqual(before, { sameSource: true, revision: snapshot.revision, advanced: false })
  await appendFile(fixture.transcriptPath, jsonl([humanRecord("copilot", "new-human", "New follow-up")]))
  const after = await runCheck()
  assert.equal(after.sameSource, true)
  assert.equal(after.advanced, true)
  assert.notEqual(after.revision, snapshot.revision)
  fixture.agentInfo.agent_session.value = "22222222-2222-4222-8222-222222222222"
  fixture.processInfo.foreground_processes = []
  assert.equal((await runCheck()).sameSource, false)
  assert.equal((await runCheck(path.join(fixture.root, "outside.json"))).sameSource, false)
})

test("source refresh returns only a new private request and leaves the saved snapshot intact", async (t) => {
  const fixture = await executableFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, { env: fixture.env })
  const requestPath = await writeConversationRequest(fixture.root, snapshot)
  await appendFile(fixture.transcriptPath, jsonl([humanRecord("copilot", "new-human", "New follow-up")]))
  const result = await execFileAsync(process.execPath, [entrypoint("conversation-source.ts"), "--refresh", requestPath], {
    env: fixture.env,
  })
  const value = JSON.parse(result.stdout)
  assert.deepEqual(Object.keys(value), ["requestPath"])
  assert.notEqual(value.requestPath, requestPath)
  const current = await readConversationRequest(fixture.root, value.requestPath)
  assert.notEqual(current.revision, snapshot.revision)
  assert.deepEqual(await readConversationRequest(fixture.root, requestPath), snapshot)
})

test("source CLI rejects standalone snapshots, draft paths, and non-UUID request filenames before capture", async (t) => {
  const fixture = await executableFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, { env: fixture.env })
  const requestPath = await writeConversationRequest(fixture.root, snapshot)
  const original = JSON.stringify(snapshot)
  const metadataCalls = fixture.server.calls.length
  for (const target of [
    path.join(fixture.root, "continuations", "snapshots", `${snapshot.id}.json`),
    path.join(fixture.root, "continuations", "snapshots", snapshot.id, "snapshot.json"),
    path.join(fixture.root, "continuations", "drafts", `${snapshot.id}.json`),
    path.join(path.dirname(requestPath), `${"a".repeat(64)}.json`),
  ]) {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, original, { mode: 0o600 })
    const checked = await execFileAsync(process.execPath, [entrypoint("conversation-source.ts"), "--check", target], {
      env: fixture.env,
    })
    assert.equal(JSON.parse(checked.stdout).sameSource, false)
    assert.equal(checked.stderr, "")
    assert.doesNotMatch(checked.stdout, /Original human goal|Completed visible answer/u)
    await assert.rejects(execFileAsync(process.execPath, [entrypoint("conversation-source.ts"), "--refresh", target], {
      env: fixture.env,
    }), (error) => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, "")
      assert.doesNotMatch(error.stderr, /Original human goal|Completed visible answer/u)
      return true
    })
    assert.equal(fixture.server.calls.length, metadataCalls)
    assert.equal(await readFile(target, "utf8"), original)
  }
  assert.deepEqual(await readConversationRequest(fixture.root, requestPath), snapshot)
})

test("plugin manifest keeps the guide actions without a separate conversation action or pane", async () => {
  const source = await readFile(path.join(pluginRoot, "herdr-plugin.toml"), "utf8")
  assert.doesNotMatch(source, /analyze-conversation|conversation-popup\.ts/iu)
  assert.match(source, /command = \["env", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "bun", "--no-install", "--no-env-file", "--config=\/dev\/null", "action\.ts", "--"\]/u)
  assert.match(source, /command = \["env", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "bun", "--no-install", "--no-env-file", "--config=\/dev\/null", "popup\.ts", "--"\]/u)
  assert.match(source, /command = \["env", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "bun", "--no-install", "--no-env-file", "--config=\/dev\/null", "overlay-action\.ts", "--"\]/u)
})
