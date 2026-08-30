#!/usr/bin/env node
import {
  getAgent,
  getProcessInfo,
  HerdrRequestError,
  requestHerdr,
} from "./lib/herdr.mjs"
import { removeCompletionMarker, writeCompletionMarker } from "./lib/state.mjs"

const trellageTokenNames = [
  "trellage_surface",
  "trellage_agent",
  "trellage_profile",
  "trellage_session_id",
  "trellage_container_id",
  "trellage_invocation_id",
  "trellage_state_seq",
  "trellage_pgrp",
]

const parseEventJson = () => {
  const source = process.env.HERDR_PLUGIN_EVENT_JSON
  if (!source) return undefined
  try {
    return JSON.parse(source)
  } catch {
    throw new Error("HERDR_PLUGIN_EVENT_JSON is not valid JSON")
  }
}

const firstText = (values) => values.find((value) => typeof value === "string" && value.length > 0)

const eventContext = () => {
  const value = parseEventJson()
  return {
    paneId:
      process.env.HERDR_PANE_ID ??
      firstText([value?.pane_id, value?.data?.pane_id, value?.pane?.pane_id, value?.agent?.pane_id, value?.payload?.pane_id]),
    status: firstText([value?.agent_status, value?.data?.agent_status]),
  }
}

const validStateChangeSeq = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 2) {
    throw new Error("Herdr agent state_change_seq is invalid")
  }
  return value
}

const clearWorkingState = async (stateDir, paneId) => {
  await removeCompletionMarker(stateDir, paneId)
  const agentInfo = await getAgent(paneId)
  if (agentInfo.agent_status !== "working") return
  const processInfo = await getProcessInfo(paneId)
  const currentProcessGroup = processInfo.foreground_process_group_id
  if (!Number.isSafeInteger(currentProcessGroup) || currentProcessGroup <= 0) {
    throw new Error("Herdr foreground_process_group_id is invalid")
  }
  const reportedProcessGroup = Number.parseInt(agentInfo.tokens?.trellage_pgrp ?? "", 10)
  if (reportedProcessGroup === currentProcessGroup) return
  const stateChangeSeq = validStateChangeSeq(agentInfo.state_change_seq)
  await requestHerdr("pane.report_metadata", {
    pane_id: paneId,
    source: "trellage.guide-handoff",
    tokens: Object.fromEntries(trellageTokenNames.map((name) => [name, null])),
    seq: stateChangeSeq * 2,
  })
}

const handleStatusEvent = async (stateDir, paneId, eventStatus) => {
  if (eventStatus === "working") return clearWorkingState(stateDir, paneId)
  let agentInfo
  try {
    agentInfo = await getAgent(paneId)
  } catch (error) {
    if (error instanceof HerdrRequestError && error.code === "agent_not_found") {
      await removeCompletionMarker(stateDir, paneId)
      return
    }
    throw error
  }
  if (agentInfo.agent_status === "working") {
    await removeCompletionMarker(stateDir, paneId)
    return
  }
  if (agentInfo.agent_status !== "done" && agentInfo.agent_status !== "idle") return
  const completedTransition = eventStatus === "done" || (eventStatus === undefined && agentInfo.agent_status === "done")
  if (!completedTransition) return
  validStateChangeSeq(agentInfo.state_change_seq)
  await writeCompletionMarker(stateDir, {
    schemaVersion: 1,
    paneId,
    agent: typeof agentInfo.agent === "string" ? agentInfo.agent : "",
    stateChangeSeq: agentInfo.state_change_seq,
    completedAt: new Date().toISOString(),
  })
}

const main = async () => {
  const event = process.env.HERDR_PLUGIN_EVENT
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  if (!stateDir) throw new Error("HERDR_PLUGIN_STATE_DIR is not set")
  const { paneId, status: eventStatus } = eventContext()
  if (!paneId) throw new Error(`Herdr ${event ?? "plugin event"} did not identify a pane`)
  if (event === "pane.closed") {
    await removeCompletionMarker(stateDir, paneId)
    return
  }
  if (event !== "pane.agent_status_changed") return
  await handleStatusEvent(stateDir, paneId, eventStatus)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
