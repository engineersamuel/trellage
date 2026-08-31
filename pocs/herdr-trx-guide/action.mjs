#!/usr/bin/env node
import { captureFinalAnswer, captureProvenance } from "./lib/capture.mjs"
import {
  panelInvocationSource,
  parseInvocationContext,
  parsePanelChoice,
  sourceWorkingDirectory,
} from "./lib/context.mjs"
import {
  getProcessInfo,
  HerdrRequestError,
  notify,
  requestHerdr,
  runHerdr,
} from "./lib/herdr.mjs"
import { resolveSourceAgent } from "./lib/source-agent.mjs"
import {
  appendCaptureQueue,
  captureQueueIntent,
  consumeChoice,
  readCaptureQueue,
  readCompletionMarker,
  removeCaptureQueueEntries,
  removeInvocation,
  writeInvocation,
} from "./lib/state.mjs"

const pluginId = "trellage.guide-handoff"

const markerMatchesAgent = (marker, agentInfo) =>
  marker?.schemaVersion === 1 &&
  marker.paneId === agentInfo.pane_id &&
  marker.agent === (typeof agentInfo.agent === "string" ? agentInfo.agent : "") &&
  marker.stateChangeSeq === agentInfo.state_change_seq

const completionMarker = async (stateDir, paneId, agentInfo, expectedStateChangeSeq) => {
  const status = agentInfo.agent_status
  if (status === "idle" && agentInfo.state_change_seq === expectedStateChangeSeq) {
    return {
      schemaVersion: 1,
      paneId,
      agent: typeof agentInfo.agent === "string" ? agentInfo.agent : "",
      stateChangeSeq: agentInfo.state_change_seq,
    }
  }
  const attempts = status === "idle" ? 5 : 1
  let marker = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    marker = await readCompletionMarker(stateDir, paneId)
    if (status !== "idle" || markerMatchesAgent(marker, agentInfo)) return marker
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return marker
}

const processInfoFor = async (paneId) => {
  try {
    return await getProcessInfo(paneId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Structured session discovery cannot inspect processes: ${message}`)
    return undefined
  }
}

const captureLatestAnswer = async (context, stateDir) => {
  const agentInfo = await resolveSourceAgent(context)
  const agentContext = { ...context, paneId: agentInfo.pane_id }
  const captured = await captureFinalAnswer({
    context: agentContext,
    agentInfo,
    marker: await completionMarker(
      stateDir,
      agentInfo.pane_id,
      agentInfo,
      context.expectedStateChangeSeq,
    ),
    processInfo: await processInfoFor(agentInfo.pane_id),
    mode: context.captureMode ?? "exact",
    onDiagnostic: (message) => console.error(`Structured transcript fallback: ${message}`),
  })
  return {
    captured,
    cwd: sourceWorkingDirectory(agentContext, agentInfo),
    paneId: agentInfo.pane_id,
  }
}

const captureInvocation = async (context, stateDir) => {
  if (context.selectedText === undefined) return captureLatestAnswer(context, stateDir)
  return {
    captured: await captureFinalAnswer({ context }),
    cwd: context.cwd,
    paneId: context.paneId,
  }
}

const resolvePanelChoice = async (context, stateDir) => {
  if (context.invocationSource !== panelInvocationSource) return context
  if (context.selectedText === undefined) throw new Error("The source picker choice token is missing")
  const choice = parsePanelChoice(await consumeChoice(stateDir, context.selectedText))
  const { selectedText: _choiceToken, ...base } = context
  if (choice.kind === "queue") return { ...base, captureQueue: true }
  if (choice.kind === "selection") return { ...base, operation: choice.operation, selectedText: choice.selectedText }
  return {
    ...base,
    operation: choice.operation,
    sourcePaneId: choice.sourcePaneId,
    captureMode: choice.captureMode,
    expectedSessionId: choice.expectedSessionId,
    expectedStateChangeSeq: choice.expectedStateChangeSeq,
  }
}

const closeSourcePicker = async (invocationSource) => {
  if (invocationSource !== panelInvocationSource) return
  try {
    await requestHerdr("popup.close", {})
  } catch (error) {
    if (!(error instanceof HerdrRequestError && error.code === "popup_not_open")) throw error
  }
}

const main = async () => {
  const contextSource = process.env.HERDR_PLUGIN_CONTEXT_JSON
  if (contextSource === undefined) throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not set")
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  if (stateDir === undefined) throw new Error("HERDR_PLUGIN_STATE_DIR is not set")

  const context = await resolvePanelChoice(parseInvocationContext(contextSource), stateDir)
  if (context.captureQueue) {
    const queue = await readCaptureQueue(stateDir)
    const invocationPath = await writeInvocation(stateDir, {
      schemaVersion: 1,
      answer: captureQueueIntent(queue),
      capture: { source: "capture-queue", confidence: "user-curated" },
      source: {
        workspaceId: context.workspaceId,
        paneId: context.paneId,
        cwd: context.cwd,
      },
    })
    try {
      await closeSourcePicker(context.invocationSource)
      await runHerdr([
        "plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "guide",
        "--env", `TRELLAGE_GUIDE_INVOCATION_PATH=${invocationPath}`, "--focus",
      ])
      await removeCaptureQueueEntries(stateDir, queue.entries.map((entry) => entry.id))
      return
    } catch (error) {
      await removeInvocation(invocationPath)
      throw error
    }
  }
  const { captured, cwd, paneId } = await captureInvocation(context, stateDir)
  if (context.operation === "enqueue") {
    const queue = await appendCaptureQueue(stateDir, {
      answer: captured.answer,
      capture: captureProvenance(captured),
      addedAt: new Date().toISOString(),
    })
    await notify("Added to Trellage capture queue", `${queue.entries.length} item${queue.entries.length === 1 ? "" : "s"} queued`)
    return
  }
  const invocationPath = await writeInvocation(stateDir, {
    schemaVersion: 1,
    answer: captured.answer,
    capture: captureProvenance(captured),
    source: {
      workspaceId: context.workspaceId,
      paneId,
      cwd,
    },
  })
  try {
    await closeSourcePicker(context.invocationSource)
    await runHerdr([
      "plugin",
      "pane",
      "open",
      "--plugin",
      pluginId,
      "--entrypoint",
      "guide",
      "--env",
      `TRELLAGE_GUIDE_INVOCATION_PATH=${invocationPath}`,
      "--focus",
    ])
  } catch (error) {
    await removeInvocation(invocationPath)
    throw error
  }
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  await notify("Trellage guide handoff failed", message)
  process.exitCode = 1
}
