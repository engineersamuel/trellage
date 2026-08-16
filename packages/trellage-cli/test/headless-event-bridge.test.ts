import { access, rm } from "node:fs/promises"
import path from "node:path"
import { Writable } from "node:stream"

import { afterEach, describe, expect, it } from "vitest"

import {
  claudeStreamJsonV1,
  parseHeadlessEventBridgeArgs,
  runHeadlessEventBridge,
  type HeadlessEventBridgeRun,
  type TrellageResultEventV1,
  type TrellageSessionEventV1,
} from "../src/headless-event-bridge.js"

const rejectedMarker = path.join(process.cwd(), `.headless-event-bridge-rejected-${process.pid}`)
const bridgeIdentity = {
  profile: "claude-social-media",
  harness: "claude",
  runtime: "claude",
} as const

afterEach(async () => {
  await rm(rejectedMarker, { force: true })
})

const nativeInit = (sessionId = "session-123", model = "claude-opus-4-1"): Record<string, unknown> => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  model,
})

const nativeResult = (sessionId = "session-123"): Record<string, unknown> => ({
  type: "result",
  subtype: "success",
  session_id: sessionId,
  is_error: false,
  result: "RED",
  usage: { input_tokens: 11, output_tokens: 3 },
  total_cost_usd: 0.0125,
})

const jsonLine = (value: unknown, ending = "\n"): Buffer => Buffer.from(`${JSON.stringify(value)}${ending}`, "utf8")

const runNative = async (
  chunks: ReadonlyArray<Buffer>,
  options: { readonly exitCode?: number; readonly expectedSessionId?: string } = {},
): Promise<{ readonly output: Buffer; readonly run: HeadlessEventBridgeRun }> => {
  const outputChunks: Array<Buffer> = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(Buffer.from(chunk))
      callback()
    },
  })
  const script = [
    "const chunks = JSON.parse(process.argv[1]);",
    'for (const chunk of chunks) process.stdout.write(Buffer.from(chunk, "base64"));',
    "process.exitCode = Number(process.argv[2]);",
  ].join("")
  const run = await runHeadlessEventBridge(
    {
      eventContract: claudeStreamJsonV1,
      gitRoot: process.cwd(),
      ...bridgeIdentity,
      ...(options.expectedSessionId === undefined ? {} : { expectedSessionId: options.expectedSessionId }),
      command: [
        process.execPath,
        "-e",
        script,
        JSON.stringify(chunks.map((chunk) => chunk.toString("base64"))),
        String(options.exitCode ?? 0),
      ],
    },
    {
      output,
      captureGitSnapshot: async () => null,
      forwardSignals: false,
    },
  )
  return { output: Buffer.concat(outputChunks), run }
}

const metadataEvents = (output: Buffer): ReadonlyArray<TrellageSessionEventV1 | TrellageResultEventV1> =>
  output
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.length === 0) return []
      try {
        const value = JSON.parse(line) as { readonly type?: string }
        return value.type === "trellage.session" || value.type === "trellage.result"
          ? [value as unknown as TrellageSessionEventV1 | TrellageResultEventV1]
          : []
      } catch {
        return []
      }
    })

describe("headless event bridge", () => {
  it("emits one session event and one evidence-based successful result", async () => {
    const { output, run } = await runNative([
      jsonLine({ type: "system", subtype: "init", session_id: "session-123" }),
      jsonLine({
        type: "assistant",
        message: { model: "claude-opus-4-1", content: [{ type: "text", text: "RED" }] },
      }),
      jsonLine(nativeResult()),
    ])
    const events = metadataEvents(output)

    expect(events.map((event) => event.type)).toEqual(["trellage.session", "trellage.result"])
    expect(events[0]).toEqual({
      type: "trellage.session",
      schemaVersion: 1,
      ...bridgeIdentity,
      eventContract: claudeStreamJsonV1,
      sessionId: "session-123",
      expectedSessionId: null,
      expectedSessionIdMatches: null,
    })
    expect(run.termination).toEqual({ exitCode: 0, signal: null, spawnError: null })
    expect(run.result).toMatchObject({
      ...bridgeIdentity,
      outcome: "success",
      sessionId: "session-123",
      sessionIdConsistent: true,
      finalText: "RED",
      model: "claude-opus-4-1",
      usage: { input_tokens: 11, output_tokens: 3 },
      costUsd: 0.0125,
      changedFiles: null,
      changedFilesSource: null,
      exitCode: 0,
      signal: null,
      nativeResultSubtype: "success",
      nativeIsError: false,
      nativeMalformedLineCount: 0,
    })
  })

  it("returns unknown for malformed native output without a result", async () => {
    const { run } = await runNative([Buffer.from("not-json\n"), jsonLine(nativeInit())])

    expect(run.result).toMatchObject({
      outcome: "unknown",
      sessionId: "session-123",
      finalText: null,
      usage: null,
      costUsd: null,
      nativeResultSubtype: null,
      nativeMalformedLineCount: 1,
    })
  })

  it("returns failure and preserves a nonzero child exit status", async () => {
    const { run } = await runNative([jsonLine(nativeInit()), jsonLine(nativeResult())], { exitCode: 9 })

    expect(run.termination).toEqual({ exitCode: 9, signal: null, spawnError: null })
    expect(run.result).toMatchObject({
      outcome: "failure",
      finalText: "RED",
      exitCode: 9,
      signal: null,
    })
  })

  it("preserves child signal termination in the terminal event", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    const run = await runHeadlessEventBridge(
      {
        eventContract: claudeStreamJsonV1,
        gitRoot: process.cwd(),
        ...bridgeIdentity,
        command: [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'],
      },
      {
        output,
        captureGitSnapshot: async () => null,
        forwardSignals: false,
      },
    )

    expect(run.termination).toEqual({ exitCode: null, signal: "SIGTERM", spawnError: null })
    expect(run.result).toMatchObject({
      outcome: "failure",
      exitCode: null,
      signal: "SIGTERM",
    })
  })

  it("returns failure for a documented native Claude error result", async () => {
    const errorResult = {
      type: "result",
      subtype: "error_during_execution",
      session_id: "session-123",
      is_error: true,
      errors: ["native failure"],
      usage: { input_tokens: 7, output_tokens: 0 },
      total_cost_usd: 0.004,
    }
    const { run } = await runNative([jsonLine(nativeInit()), jsonLine(errorResult)])

    expect(run.result).toMatchObject({
      outcome: "failure",
      finalText: null,
      usage: { input_tokens: 7, output_tokens: 0 },
      costUsd: 0.004,
      nativeResultSubtype: "error_during_execution",
      nativeIsError: true,
      nativeError: "native failure",
      exitCode: 0,
    })
  })

  it("uses null for unavailable fields and unknown for a missing or malformed result", async () => {
    const sparseResult = {
      type: "result",
      subtype: "success",
      session_id: "session-123",
      is_error: false,
      result: "DONE",
    }
    const sparse = await runNative([
      jsonLine({ type: "system", subtype: "init", session_id: "session-123" }),
      jsonLine(sparseResult),
    ])
    expect(sparse.run.result).toMatchObject({
      outcome: "success",
      finalText: "DONE",
      model: null,
      usage: null,
      costUsd: null,
      nativeIsError: false,
    })

    const missing = await runNative([jsonLine(nativeInit())])
    expect(missing.run.result).toMatchObject({
      outcome: "unknown",
      finalText: null,
      usage: null,
      costUsd: null,
    })

    const malformed = await runNative([
      jsonLine(nativeInit()),
      jsonLine({ type: "result", subtype: "success", session_id: "session-123", is_error: false, result: 42 }),
    ])
    expect(malformed.run.result).toMatchObject({
      outcome: "unknown",
      finalText: null,
      nativeResultSubtype: "success",
    })
  })

  it("reports expected resume session matches and mismatches", async () => {
    const matched = await runNative([jsonLine(nativeInit()), jsonLine(nativeResult())], {
      expectedSessionId: "session-123",
    })
    const mismatched = await runNative([jsonLine(nativeInit()), jsonLine(nativeResult())], {
      expectedSessionId: "different-session",
    })

    expect(metadataEvents(matched.output)[0]).toMatchObject({
      expectedSessionId: "session-123",
      expectedSessionIdMatches: true,
    })
    expect(matched.run.result).toMatchObject({
      outcome: "success",
      expectedSessionIdMatches: true,
    })
    expect(metadataEvents(mismatched.output)[0]).toMatchObject({
      expectedSessionId: "different-session",
      expectedSessionIdMatches: false,
    })
    expect(mismatched.run.result).toMatchObject({
      outcome: "failure",
      expectedSessionIdMatches: false,
    })
  })

  it("fails when authoritative native events disagree on the session ID", async () => {
    const { run } = await runNative([jsonLine(nativeInit("session-a")), jsonLine(nativeResult("session-b"))], {
      expectedSessionId: "session-a",
    })

    expect(run.result).toMatchObject({
      outcome: "failure",
      sessionId: "session-a",
      expectedSessionIdMatches: true,
      sessionIdConsistent: false,
    })
  })

  it("writes every native line with its exact bytes before metadata", async () => {
    const binaryLine = Buffer.from([0xff, 0xfe, 0x0a])
    const initLine = Buffer.from(
      '{ "type": "system", "subtype": "init", "session_id": "raw-session", "model": "raw-model" }\r\n',
      "utf8",
    )
    const resultLine = Buffer.from(
      '{"type":"result","subtype":"success","session_id":"raw-session","is_error":false,"result":"OK","usage":{},"total_cost_usd":0}\n',
      "utf8",
    )
    const { output, run } = await runNative([binaryLine, initLine, resultLine])
    const sessionEvent: TrellageSessionEventV1 = {
      type: "trellage.session",
      schemaVersion: 1,
      ...bridgeIdentity,
      eventContract: claudeStreamJsonV1,
      sessionId: "raw-session",
      expectedSessionId: null,
      expectedSessionIdMatches: null,
    }

    expect(output).toEqual(
      Buffer.concat([binaryLine, initLine, jsonLine(sessionEvent), resultLine, jsonLine(run.result)]),
    )
    expect(run.result.outcome).toBe("failure")
    expect(run.result.nativeMalformedLineCount).toBe(1)
  })

  it("rejects unknown contracts before the child can spawn", async () => {
    const script = `require("node:fs").writeFileSync(${JSON.stringify(rejectedMarker)}, "spawned")`

    await expect(
      runHeadlessEventBridge({
        eventContract: "unknown-v1" as typeof claudeStreamJsonV1,
        gitRoot: process.cwd(),
        ...bridgeIdentity,
        command: [process.execPath, "-e", script],
      }),
    ).rejects.toThrow(/unsupported event contract/)
    await expect(access(rejectedMarker)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("requires non-empty host identity options", () => {
    const arguments_ = [
      "--event-contract",
      claudeStreamJsonV1,
      "--git-root",
      process.cwd(),
      "--profile",
      bridgeIdentity.profile,
      "--harness",
      bridgeIdentity.harness,
      "--runtime",
      bridgeIdentity.runtime,
      "--",
      process.execPath,
      "-e",
      "",
    ]

    expect(parseHeadlessEventBridgeArgs(arguments_)).toMatchObject(bridgeIdentity)
    const profileIndex = arguments_.indexOf("--profile")
    const withoutProfile = arguments_.filter((_, index) => index !== profileIndex && index !== profileIndex + 1)
    expect(() => parseHeadlessEventBridgeArgs(withoutProfile)).toThrow(/--profile is required/)

    const blankRuntime = [...arguments_]
    blankRuntime[blankRuntime.indexOf("--runtime") + 1] = " "
    expect(() => parseHeadlessEventBridgeArgs(blankRuntime)).toThrow(/--runtime requires a non-empty identifier/)
  })
})
