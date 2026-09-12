import net from "node:net"

interface Request {
  readonly id: string
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

const source = "trellage.guide-handoff"
const permanentErrors = new Set(["EACCES", "ECONNREFUSED", "ENOENT", "ENOTDIR", "ENOTSOCK"])
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

class HerdrConnection {
  permanentFailure: Error | undefined

  constructor(readonly socketPath: string) {}

  request(request: Request): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket()
      let sourceText = ""
      let settled = false
      const finish = (error: Error | undefined, result?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        if (error === undefined) resolve(result)
        else reject(error)
      }
      const timer = setTimeout(() => finish(new Error("Herdr metadata request timed out")), 250)
      socket.setEncoding("utf8")
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`))
      socket.on("data", (chunk: string) => {
        sourceText += chunk
        const newline = sourceText.indexOf("\n")
        if (newline < 0) return
        try {
          finish(undefined, responseResult(sourceText.slice(0, newline), request.id))
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== undefined && permanentErrors.has(error.code)) this.permanentFailure = error
        finish(error)
      })
      socket.once("close", () => {
        if (!sourceText.includes("\n")) finish(new Error("Herdr metadata socket closed without a response"))
      })
      socket.connect(this.socketPath)
    })
  }
}

function responseResult(sourceText: string, id: string): unknown {
  const response: unknown = JSON.parse(sourceText)
  if (!isRecord(response) || response.id !== id) throw new Error("Herdr metadata response ID does not match")
  if (response.error !== undefined) throw new Error(`Herdr metadata error: ${JSON.stringify(response.error)}`)
  return response.result
}

function safeSequence(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= (Number.MAX_SAFE_INTEGER - 1) / 2
  )
}

function attachmentState(agentResult: unknown, processResult: unknown, paneId: string, agent: string) {
  const info = isRecord(agentResult) ? agentResult.agent : undefined
  const processInfo = isRecord(processResult) ? processResult.process_info : undefined
  if (!isRecord(info) || !isRecord(processInfo)) return undefined
  if (info.pane_id !== paneId || info.agent !== agent || processInfo.pane_id !== paneId) return undefined
  if (info.agent_status !== "working" && info.agent_status !== "idle") return undefined
  const sequence = info.state_change_seq
  const group = processInfo.foreground_process_group_id
  if (!safeSequence(sequence)) return undefined
  if (typeof group !== "number" || !Number.isSafeInteger(group) || group <= 0) return undefined
  return { sequence, group }
}

async function report(
  socketPath: string,
  paneId: string,
  agent: string,
  profile: string,
  containerId: string,
  invocationId: string,
) {
  const connection = new HerdrConnection(socketPath)
  let state: ReturnType<typeof attachmentState>
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const agentResult = await connection.request({
        id: `${source}:agent-get:${invocationId}:${attempt}`,
        method: "agent.get",
        params: { target: paneId },
      })
      const processResult = await connection.request({
        id: `${source}:process-info:${invocationId}:${attempt}`,
        method: "pane.process_info",
        params: { pane_id: paneId },
      })
      state = attachmentState(agentResult, processResult, paneId, agent)
      if (state !== undefined) break
    } catch {
      if (connection.permanentFailure !== undefined) throw connection.permanentFailure
      // The tagged attachment can take a moment to become visible to Herdr.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (state === undefined) throw new Error("Herdr did not recognize the current Sandbox attachment")
  await connection.request({
    id: `${source}:report:${invocationId}`,
    method: "pane.report_metadata",
    params: {
      pane_id: paneId,
      source,
      agent,
      tokens: {
        trellage_surface: "sandbox",
        trellage_agent: agent,
        trellage_profile: profile,
        trellage_container_id: containerId,
        trellage_invocation_id: invocationId,
        trellage_state_seq: String(state.sequence),
        trellage_pgrp: String(state.group),
      },
      seq: state.sequence * 2 + 1,
    },
  })
}

const [socketPath, paneId, agent, profile, containerId, invocationId, ...rest] = process.argv.slice(2)
try {
  if (
    socketPath === undefined ||
    paneId === undefined ||
    agent === undefined ||
    profile === undefined ||
    containerId === undefined ||
    invocationId === undefined ||
    rest.length !== 0
  ) {
    throw new Error("Herdr metadata requires socket, pane, agent, profile, container and invocation")
  }
  await report(socketPath, paneId, agent, profile, containerId, invocationId)
} catch (error) {
  process.stderr.write(`trellage: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
