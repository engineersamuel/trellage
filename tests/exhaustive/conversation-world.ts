import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {
  captureFocusedConversation,
  writeConversationRequest,
} from "../../packages/trellage-conversation-source/src/index.ts"
import { MockAudit } from "./mock-audit.ts"

/** A private metadata socket and real synthetic transcript, with no connection to the user's Herdr. */
export async function conversationWorld(cwd: string, baseEnvironment: NodeJS.ProcessEnv) {
  if (baseEnvironment.TRELLAGE_TEST_OFFLINE !== "1") throw Error("Conversation fixtures require offline execution")
  const root = await mkdtemp(path.join(os.homedir(), ".trx-gc-"))
  const socketPath = path.join(root, "h")
  const stateRoot = path.join(root, "state")
  const sessionId = randomUUID()
  const context = { schemaVersion: 1, surface: "popup", workspaceId: "matrix-workspace", paneId: "matrix-pane", cwd }
  const audit = new MockAudit()
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.setEncoding("utf8")
    let buffered = ""
    let replied = false
    socket.on("data", (chunk: string) => {
      try {
        audit.run("metadata.request", () => {
          assert.equal(replied, false, "Only one request is allowed per connection")
          buffered += chunk
          assert.ok(buffered.length < 65536, "Metadata request exceeds fixture limit")
          if (!buffered.includes("\n")) return
          const request = JSON.parse(buffered)
          assert.equal(typeof request.id, "string")
          let result: object
          if (request.method === "agent.get") {
            assert.deepEqual(request.params, { target: context.paneId })
            result = {
              type: "agent_info",
              agent: {
                workspace_id: context.workspaceId,
                tab_id: "matrix-tab",
                pane_id: context.paneId,
                cwd,
                agent: "copilot",
                agent_status: "working",
                state_change_seq: 1,
                agent_session: { agent: "copilot", kind: "id", value: sessionId },
              },
            }
          } else {
            assert.equal(request.method, "pane.process_info")
            assert.deepEqual(request.params, { pane_id: context.paneId })
            result = {
              type: "pane_process_info",
              process_info: {
                pane_id: context.paneId,
                foreground_process_group_id: 12345,
                foreground_processes: [{ name: "copilot", argv: ["copilot", "--session-id", sessionId] }],
              },
            }
          }
          replied = true
          socket.end(JSON.stringify({ id: request.id, result }) + "\n")
        })
      } catch {
        socket.destroy()
      }
    })
    socket.on("error", () => {
      /* A failed request remains visible through the audit. */
    })
  })
  const dispose = async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    await rm(root, { recursive: true, force: true })
  }
  try {
    await mkdir(stateRoot, { mode: 0o700 })
    const transcriptRoot = path.join(root, ".copilot/session-state", sessionId)
    await mkdir(transcriptRoot, { recursive: true, mode: 0o700 })
    await writeFile(path.join(transcriptRoot, "workspace.yaml"), `id: ${sessionId}\ncwd: ${cwd}\n`, { mode: 0o600 })
    await writeFile(
      path.join(transcriptRoot, "events.jsonl"),
      [
        { type: "session.start", data: { sessionId } },
        { type: "user.message", id: "matrix-user", data: { content: "Fix the parser." } },
        {
          type: "assistant.message",
          id: "matrix-answer",
          data: { phase: "final_answer", content: "The correction needs verification." },
        },
      ]
        .map((value) => JSON.stringify(value))
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
    const environment = {
      ...baseEnvironment,
      HOME: root,
      COPILOT_HOME: path.join(root, ".copilot"),
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PLUGIN_STATE_DIR: stateRoot,
      TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify(context),
    }
    const snapshot = await captureFocusedConversation(context, { env: environment })
    audit.assertClean()
    assert.deepEqual(
      snapshot.messages.map((message) => message.text),
      ["Fix the parser.", "The correction needs verification."],
    )
    const requestPath = await writeConversationRequest(stateRoot, snapshot)
    return { environment: { ...environment, TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE: requestPath }, audit, dispose }
  } catch (error) {
    await dispose()
    audit.assertClean()
    throw error
  }
}
