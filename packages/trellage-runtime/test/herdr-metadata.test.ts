import { expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { bunArguments, bunExecutable, sourceWorkspaceRoot } from "../src/index.ts"

const entrypoint = path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/src/herdr-metadata.ts")

test("reports the current Sandbox attachment through the existing Herdr protocol", async () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-herdr.")))
  const socketPath = path.join(directory, "s")
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      const request: { id: string; method: string; params: Record<string, unknown> } = JSON.parse(data.toString())
      requests.push(request)
      let result: unknown = {}
      if (request.method === "agent.get") {
        result = { agent: { pane_id: "pane", agent: "codex", agent_status: "working", state_change_seq: 9 } }
      } else if (request.method === "pane.process_info") {
        result = { process_info: { pane_id: "pane", foreground_process_group_id: 123 } }
      }
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`)
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    const child = Bun.spawn(
      [
        bunExecutable(),
        ...bunArguments(entrypoint, [socketPath, "pane", "codex", "profile", "container", "invocation"]),
      ],
      { env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
    expect(requests.map((request) => request.method)).toEqual([
      "agent.get",
      "pane.process_info",
      "pane.report_metadata",
    ])
    expect(requests[2]).toEqual({
      id: "trellage.guide-handoff:report:invocation",
      method: "pane.report_metadata",
      params: {
        pane_id: "pane",
        source: "trellage.guide-handoff",
        agent: "codex",
        seq: 19,
        tokens: {
          trellage_surface: "sandbox",
          trellage_agent: "codex",
          trellage_profile: "profile",
          trellage_container_id: "container",
          trellage_invocation_id: "invocation",
          trellage_state_seq: "9",
          trellage_pgrp: "123",
        },
      },
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true })
  }
})

test("fails explicitly when the Herdr socket is absent", async () => {
  const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), "trellage-herdr.")))
  try {
    const child = Bun.spawn(
      [
        bunExecutable(),
        ...bunArguments(entrypoint, [path.join(directory, "s"), "pane", "codex", "profile", "container", "invocation"]),
      ],
      { env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" },
    )
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain("ENOENT")
  } finally {
    rmSync(directory, { recursive: true })
  }
})
