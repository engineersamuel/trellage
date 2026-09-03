#!/usr/bin/env node
// @ts-nocheck -- Legacy terminal UI adapter; capture modules are type-checked.
import { fileURLToPath } from "node:url"

import { captureAgentContent, captureProvenance } from "./lib/capture.ts"
import { parseCustomPopupContext, sourceWorkingDirectory } from "./lib/context.ts"
import { getProcessInfo } from "./lib/herdr.ts"
import { resolveSourceAgent } from "./lib/source-agent.ts"
import { findTrellageRoot, runGuide, waitForDismissal } from "./popup.ts"

const completionMarkerFor = (agentInfo) =>
  agentInfo.agent_status === "idle"
    ? {
        schemaVersion: 1,
        paneId: agentInfo.pane_id,
        agent: typeof agentInfo.agent === "string" ? agentInfo.agent : "",
        stateChangeSeq: agentInfo.state_change_seq,
      }
    : undefined

const directInvocation = async (context) => {
  const agentInfo = await resolveSourceAgent(context)
  const agentContext = { ...context, paneId: agentInfo.pane_id }

  let processInfo
  try {
    processInfo = await getProcessInfo(agentInfo.pane_id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Structured session discovery cannot inspect processes: ${message}`)
  }

  const captured = await captureAgentContent({
    context: agentContext,
    agentInfo,
    marker: completionMarkerFor(agentInfo),
    processInfo,
    mode: "exact",
    onDiagnostic: (message) => console.error(`Structured transcript fallback: ${message}`),
  })
  return {
    answer: captured.answer,
    capture: captureProvenance(captured),
    source: {
      workspaceId: context.workspaceId,
      paneId: agentInfo.pane_id,
      cwd: sourceWorkingDirectory(agentContext, agentInfo),
    },
  }
}

const main = async () => {
  const context = parseCustomPopupContext()
  let invocation
  try {
    invocation = await directInvocation(context)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await waitForDismissal(`Cannot open the latest agent result: ${message}`)
    return 1
  }
  const pluginRoot = fileURLToPath(new URL(".", import.meta.url))
  const root = await findTrellageRoot(pluginRoot)
  const status = await runGuide(root, invocation)
  if (status !== 0 && status !== 130) {
    await waitForDismissal(`trx guide exited with status ${status}`)
  }
  return status
}

try {
  process.exitCode = await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  await waitForDismissal(`Trellage guide handoff failed: ${message}`)
  process.exitCode = 1
}
