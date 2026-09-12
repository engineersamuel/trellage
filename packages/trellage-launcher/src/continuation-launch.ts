import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"
import { createConnection } from "node:net"
import path from "node:path"
import {
  buildGuideLaunchCommand,
  renderCommandPreview,
  waitForHerdrAgentIdle,
  type LaunchInHerdrPaneOptions,
  type CommandRunner,
  type HerdrPaneLaunchResult,
  type SelectedProfile,
} from "./guide-launch.ts"
import type { JobPlacement, QueuedGuideJob } from "./guide-batch.ts"

enum HerdrResponseType {
  AgentPrompted = "agent_prompted",
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

export const createPrivateContinuationJob = (
  id: number,
  profile: SelectedProfile,
  prompt: string,
  placement: JobPlacement,
): QueuedGuideJob => ({
  id,
  profile,
  prompt,
  placement,
  command: buildGuideLaunchCommand(profile).command,
  promptDelivery: "agent",
  privatePrompt: true,
})

/** The socket carries the prompt; neither the shell command nor argv contains conversation text. */
export const submitContinuationPrompt = async (
  socketPath: string,
  paneId: string,
  prompt: string,
  timeoutMs = 30_000,
): Promise<void> => {
  if (!path.isAbsolute(socketPath)) throw new Error("Private prompt delivery requires an absolute Herdr socket path.")
  const info = await lstat(socketPath)
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
    throw new Error("Private prompt delivery requires an owned Herdr socket.")
  }
  const id = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    let length = 0
    let finished = false
    const finish = (error?: Error): void => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      socket.destroy()
      if (error === undefined) resolve()
      else reject(error)
    }
    const timeout = setTimeout(
      () => finish(new Error("Prompt acknowledgment timed out. Delivery is unknown; do not resend automatically.")),
      timeoutMs,
    )
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method: "agent.prompt", params: { target: paneId, text: prompt } })}\n`)
    })
    socket.on("data", (chunk: Buffer) => {
      length += chunk.length
      if (length > 1024 * 1024) {
        finish(new Error("Herdr returned an oversized prompt acknowledgment. Delivery is unknown."))
        return
      }
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      const newline = buffer.indexOf(10)
      if (newline < 0) return
      let response: unknown
      try {
        response = JSON.parse(buffer.subarray(0, newline).toString("utf8"))
      } catch {
        finish(new Error("Herdr returned an invalid prompt acknowledgment. Delivery is unknown."))
        return
      }
      if (
        !isRecord(response) ||
        response.id !== id ||
        !isRecord(response.result) ||
        response.result.type !== HerdrResponseType.AgentPrompted ||
        !isRecord(response.result.agent) ||
        response.result.agent.pane_id !== paneId
      ) {
        finish(
          new Error("Herdr did not confirm prompt delivery to the allocated pane. Inspect that pane before retrying."),
        )
        return
      }
      finish()
    })
    socket.once("error", () => finish(new Error("Herdr prompt connection failed. Delivery is unknown.")))
    socket.once("end", () => finish(new Error("Herdr closed before confirming prompt delivery. Delivery is unknown.")))
  })
}

export const launchPrivateContinuation = async (
  socketPath: string,
  runner: CommandRunner,
  options: LaunchInHerdrPaneOptions,
): Promise<HerdrPaneLaunchResult> => {
  if (options.promptDelivery !== "agent") throw new Error("Continuation prompts require private socket delivery.")
  const commandPreview = `env TRELLAGE_AUTOMATION=1 ${renderCommandPreview(options.command)}`
  options.onPhase?.("starting")
  await runner.run("herdr", ["pane", "run", options.paneId, commandPreview], { cwd: options.cwd })
  options.onPhase?.("waiting")
  await waitForHerdrAgentIdle(runner, options.paneId, options)
  options.onPhase?.("prompting")
  await submitContinuationPrompt(socketPath, options.paneId, options.prompt, options.promptTimeoutMs)
  return { paneId: options.paneId, commandPreview }
}
