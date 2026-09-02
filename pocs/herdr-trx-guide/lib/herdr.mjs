import net from "node:net"
import { spawn } from "node:child_process"

const responseMaximumBytes = 16 * 1024 * 1024

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

export class HerdrRequestError extends Error {
  constructor(method, code, message) {
    super(`Herdr ${method} failed (${code}): ${message}`)
    this.name = "HerdrRequestError"
    this.code = code
  }
}

export const requestHerdr = (
  method,
  params,
  { socketPath = process.env.HERDR_SOCKET_PATH, timeoutMs = 5000 } = {},
) =>
  new Promise((resolve, reject) => {
    if (typeof socketPath !== "string" || socketPath.length === 0) {
      reject(new Error("HERDR_SOCKET_PATH is not set"))
      return
    }
    const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const socket = net.createConnection(socketPath)
    let buffer = ""
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error(`Herdr ${method} timed out`)), timeoutMs)
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`)
    })
    socket.on("data", (chunk) => {
      buffer += chunk
      if (Buffer.byteLength(buffer, "utf8") > responseMaximumBytes) {
        finish(new Error(`Herdr ${method} response is too large`))
        return
      }
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      let response
      try {
        response = JSON.parse(buffer.slice(0, newline))
      } catch {
        finish(new Error(`Herdr ${method} returned invalid JSON`))
        return
      }
      if (!isRecord(response) || response.id !== requestId) {
        finish(new Error(`Herdr ${method} returned an invalid response envelope`))
        return
      }
      if (isRecord(response.error)) {
        const code = typeof response.error.code === "string" ? response.error.code : "unknown"
        const message = typeof response.error.message === "string" ? response.error.message : "request failed"
        finish(new HerdrRequestError(method, code, message))
        return
      }
      if (!isRecord(response.result)) {
        finish(new Error(`Herdr ${method} did not return a result`))
        return
      }
      finish(undefined, response.result)
    })
    socket.once("error", (error) => finish(error))
    socket.once("close", () => {
      if (!settled) finish(new Error(`Herdr ${method} closed without a response`))
    })
  })

export const getAgent = async (paneId, options) => {
  const result = await requestHerdr("agent.get", { target: paneId }, options)
  if (result.type !== "agent_info" || !isRecord(result.agent)) {
    throw new Error("Herdr agent.get returned an invalid result")
  }
  return result.agent
}

export const listAgents = async (options) => {
  const result = await requestHerdr("agent.list", {}, options)
  if (
    result.type !== "agent_list" ||
    !Array.isArray(result.agents) ||
    !result.agents.every(isRecord)
  ) {
    throw new Error("Herdr agent.list returned an invalid result")
  }
  return result.agents
}

export const readAgent = async (paneId, options) => {
  const result = await requestHerdr(
    "agent.read",
    { target: paneId, source: "recent_unwrapped", format: "text", strip_ansi: true },
    options,
  )
  if (result.type !== "pane_read" || !isRecord(result.read)) {
    throw new Error("Herdr agent.read returned an invalid result")
  }
  return result.read
}

export const getProcessInfo = async (paneId, options) => {
  const result = await requestHerdr("pane.process_info", { pane_id: paneId }, options)
  if (result.type !== "pane_process_info" || !isRecord(result.process_info)) {
    throw new Error("Herdr pane.process_info returned an invalid result")
  }
  return result.process_info
}

export const runHerdr = (
  args,
  { binary = process.env.HERDR_BIN_PATH ?? "herdr", timeoutMs } = {},
) => {
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    return Promise.reject(new Error("Herdr command timeout must be a positive integer"))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    let settled = false
    let timedOut = false
    let timeout
    let forceKillTimeout
    const clearTimers = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      if (forceKillTimeout !== undefined) clearTimeout(forceKillTimeout)
    }
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += chunk
    })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimers()
      reject(error)
    })
    child.once("close", (status) => {
      if (settled) return
      settled = true
      clearTimers()
      if (timedOut) reject(new Error(`Herdr command timed out after ${timeoutMs}ms`))
      else if (status === 0) resolve()
      else reject(new Error(stderr.trim() || `Herdr exited with status ${status ?? "unknown"}`))
    })
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (settled) return
        timedOut = true
        child.kill("SIGTERM")
        forceKillTimeout = setTimeout(() => {
          if (!settled) child.kill("SIGKILL")
        }, 1000)
      }, timeoutMs)
    }
  })
}

export const notify = async (title, body) => {
  try {
    await runHerdr(["notification", "show", title, "--body", body])
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
  }
}
