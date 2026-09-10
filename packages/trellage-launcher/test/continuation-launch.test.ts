import { chmod, mkdtemp, rm, symlink } from "node:fs/promises"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createPrivateContinuationJob,
  launchPrivateContinuation,
  submitContinuationPrompt,
} from "../src/continuation-launch.js"
import type { CommandRunner } from "../src/guide-launch.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const socketFixture = async (respond: (socket: Socket, input: string) => void) => {
  const root = await mkdtemp(path.join(tmpdir(), "trx-socket-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = path.join(root, "s")
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    let input = ""
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8")
      if (!input.includes("\n")) return
      requests.push(input)
      respond(socket, input)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  )
  return { socketPath, requests, root }
}

const acknowledge = (socket: Socket, input: string): void => {
  const request = JSON.parse(input)
  socket.end(
    `${JSON.stringify({
      id: request.id,
      result: { type: "agent_prompted", agent: { pane_id: request.params.target } },
    })}\n`,
  )
}

describe("private continuation launch", () => {
  it("keeps the prompt out of commands, argv, and the launch receipt", async () => {
    const fixture = await socketFixture(acknowledge)
    const secretText = "Synthetic conversation text; never put this in command arguments."
    const job = createPrivateContinuationJob(
      1,
      {
        surface: "native",
        launcher: "cpx",
        commandPath: "/profiles/cpx",
        profile: "default",
        headlessPrompt: true,
      },
      secretText,
      { kind: "new-tab" },
    )
    const calls: Array<{ executable: string; args: ReadonlyArray<string> }> = []
    const runner: CommandRunner = {
      async run(executable, args) {
        calls.push({ executable, args })
        return {
          stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }),
          stderr: "",
          exitCode: 0,
        }
      },
    }
    const result = await launchPrivateContinuation(fixture.socketPath, runner, {
      paneId: "w1:p2",
      cwd: "/repo",
      command: job.command,
      prompt: job.prompt,
      promptDelivery: job.promptDelivery,
      promptTimeoutMs: 1000,
    })
    expect(job.command.args).toEqual(["default"])
    expect(JSON.stringify(calls)).not.toContain(secretText)
    expect(JSON.stringify(result)).not.toContain(secretText)
    expect(JSON.parse(fixture.requests[0] ?? "").params).toEqual({
      target: "w1:p2",
      text: secretText,
    })
    expect(result.paneId).toBe("w1:p2")
  })

  it("does not treat another pane's acknowledgment as delivery", async () => {
    const fixture = await socketFixture((socket, input) => {
      const request = JSON.parse(input)
      socket.end(
        `${JSON.stringify({ id: request.id, result: { type: "agent_prompted", agent: { pane_id: "different" } } })}\n`,
      )
    })
    await expect(submitContinuationPrompt(fixture.socketPath, "w1:p2", "Synthetic task")).rejects.toThrow(
      "did not confirm",
    )
    expect(fixture.requests).toHaveLength(1)
  })

  it("bounds missing acknowledgments without retrying a possibly submitted prompt", async () => {
    const fixture = await socketFixture(() => undefined)
    await expect(submitContinuationPrompt(fixture.socketPath, "w1:p2", "Synthetic task", 50)).rejects.toThrow(
      "Delivery is unknown",
    )
    expect(fixture.requests).toHaveLength(1)
  })

  it("rejects symlink and writable-by-others sockets before sending", async () => {
    const fixture = await socketFixture(acknowledge)
    const link = path.join(fixture.root, "link")
    await symlink(fixture.socketPath, link)
    await expect(submitContinuationPrompt(link, "w1:p2", "Synthetic task")).rejects.toThrow("owned Herdr socket")
    await chmod(fixture.socketPath, 0o666)
    await expect(submitContinuationPrompt(fixture.socketPath, "w1:p2", "Synthetic task")).rejects.toThrow(
      "owned Herdr socket",
    )
    expect(fixture.requests).toEqual([])
  })
})
