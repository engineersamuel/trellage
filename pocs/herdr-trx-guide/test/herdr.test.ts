import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { requestHerdr } from "../lib/herdr.ts"
import { readCompletionMarker, writeCompletionMarker } from "../lib/state.ts"

const execFileAsync = promisify(execFile)
const eventEntrypoint = fileURLToPath(new URL("../event.ts", import.meta.url))

const socketServer = async (t, responseFor) => {
  const directory = await mkdtemp(path.join(tmpdir(), "herdr-guide-socket-"))
  const socketPath = path.join(directory, "api.sock")
  const server = net.createServer((socket) => {
    let source = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      source += chunk
      const newline = source.indexOf("\n")
      if (newline < 0) return
      const request = JSON.parse(source.slice(0, newline))
      socket.end(`${JSON.stringify(responseFor(request))}\n`)
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

test("sends one framed Herdr request and validates its response id", async (t) => {
  const socketPath = await socketServer(t, (request) => {
    assert.equal(request.method, "agent.get")
    assert.deepEqual(request.params, { target: "w1:p1" })
    return { id: request.id, result: { type: "agent_info", agent: { pane_id: "w1:p1" } } }
  })
  const result = await requestHerdr("agent.get", { target: "w1:p1" }, { socketPath })
  assert.equal(result.type, "agent_info")
})

test("surfaces Herdr socket error responses", async (t) => {
  const socketPath = await socketServer(t, (request) => ({
    id: request.id,
    error: { code: "agent_not_found", message: "missing" },
  }))
  await assert.rejects(
    requestHerdr("agent.get", { target: "w1:p9" }, { socketPath }),
    /agent_not_found.*missing/,
  )
})

test("records a done transition that Herdr now reports as focused idle", async (t) => {
  let working = false
  let metadataRequest
  const socketPath = await socketServer(t, (request) => {
    if (request.method === "pane.report_metadata") {
      metadataRequest = request
      return { id: request.id, result: { type: "ok" } }
    }
    if (request.method === "pane.process_info") {
      return {
        id: request.id,
        result: {
          type: "pane_process_info",
          process_info: {
            pane_id: "w1:p1",
            foreground_process_group_id: 9002,
          },
        },
      }
    }
    return {
      id: request.id,
      result: {
        type: "agent_info",
        agent: {
          pane_id: "w1:p1",
          agent: "copilot",
          agent_status: working ? "working" : "idle",
          state_change_seq: working ? 43 : 42,
        },
      },
    }
  })
  const stateDir = await mkdtemp(path.join(tmpdir(), "herdr-guide-event-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  const baseEnv = {
    ...process.env,
    HERDR_SOCKET_PATH: socketPath,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    HERDR_PANE_ID: "w1:p1",
  }
  await execFileAsync(process.execPath, [eventEntrypoint], {
    env: {
      ...baseEnv,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p1", agent_status: "done" },
      }),
    },
  })
  assert.equal((await readCompletionMarker(stateDir, "w1:p1"))?.stateChangeSeq, 42)

  working = true
  await execFileAsync(process.execPath, [eventEntrypoint], {
    env: {
      ...baseEnv,
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p1", agent_status: "working" },
      }),
    },
  })
  assert.equal(await readCompletionMarker(stateDir, "w1:p1"), null)
  assert.equal(metadataRequest?.params?.source, "trellage.guide-handoff")
  assert.equal(metadataRequest?.params?.seq, 86)
  assert.deepEqual(metadataRequest?.params?.tokens, {
    trellage_surface: null,
    trellage_agent: null,
    trellage_profile: null,
    trellage_session_id: null,
    trellage_container_id: null,
    trellage_invocation_id: null,
    trellage_state_seq: null,
    trellage_pgrp: null,
  })
})

test("preserves Trellage metadata for another prompt in the same process", async (t) => {
  const requests = []
  const socketPath = await socketServer(t, (request) => {
    requests.push(request)
    if (request.method === "agent.get") {
      return {
        id: request.id,
        result: {
          type: "agent_info",
          agent: {
            pane_id: "w1:p1",
            agent: "copilot",
            agent_status: "working",
            state_change_seq: 51,
            tokens: { trellage_pgrp: "777" },
          },
        },
      }
    }
    return {
      id: request.id,
      result: {
        type: "pane_process_info",
        process_info: {
          pane_id: "w1:p1",
          foreground_process_group_id: 777,
        },
      },
    }
  })
  const stateDir = await mkdtemp(path.join(tmpdir(), "herdr-guide-same-process-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))

  await execFileAsync(process.execPath, [eventEntrypoint], {
    env: {
      ...process.env,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p1", agent_status: "working" },
      }),
    },
  })

  assert.deepEqual(
    requests.map((request) => request.method),
    ["agent.get", "pane.process_info"],
  )
})

test("cleans a stale marker when a delayed status event no longer has an agent", async (t) => {
  const socketPath = await socketServer(t, (request) => ({
    id: request.id,
    error: { code: "agent_not_found", message: "missing" },
  }))
  const stateDir = await mkdtemp(path.join(tmpdir(), "herdr-guide-missing-agent-"))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  await writeCompletionMarker(stateDir, {
    schemaVersion: 1,
    paneId: "w1:p1",
    agent: "copilot",
    stateChangeSeq: 41,
    completedAt: "2026-01-01T00:00:00.000Z",
  })

  await execFileAsync(process.execPath, [eventEntrypoint], {
    env: {
      ...process.env,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
      HERDR_PANE_ID: "w1:p1",
      HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p1", agent_status: "idle" },
      }),
    },
  })
  assert.equal(await readCompletionMarker(stateDir, "w1:p1"), null)
})
