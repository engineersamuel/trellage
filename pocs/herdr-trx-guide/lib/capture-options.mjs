import { captureFinalAnswer, ExactCaptureUnavailableError } from "./capture.mjs"
import { getProcessInfo } from "./herdr.mjs"
import { sourceAgentCandidates } from "./source-agent.mjs"

const completedStatus = (agent) =>
  agent.agent_status === "done" || agent.agent_status === "idle"

const completionMarkerFor = (agent) =>
  agent.agent_status === "idle"
    ? {
        schemaVersion: 1,
        paneId: agent.pane_id,
        agent: typeof agent.agent === "string" ? agent.agent : "",
        stateChangeSeq: agent.state_change_seq,
      }
    : undefined

const agentLabel = (agent) => {
  const name = typeof agent.agent === "string" && agent.agent.length > 0 ? agent.agent : "agent"
  return `${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`
}

const shortSessionId = (sessionId) =>
  typeof sessionId === "string" && sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId

const exactChoice = (agent, captured) => ({
  id: `exact:${agent.pane_id}`,
  kind: "exact",
  label: `Open exact ${agentLabel(agent)} result`,
  detail: `Exact session ${shortSessionId(captured.sessionId)} from pane ${agent.pane_id}.`,
  preview: captured.answer,
  paneId: agent.pane_id,
  stateChangeSeq: agent.state_change_seq,
  sessionId: captured.sessionId,
})

const terminalChoice = (agent, captured) => ({
  id: `terminal:${agent.pane_id}`,
  kind: "terminal",
  label: `Open ${agentLabel(agent)} terminal snapshot`,
  detail: `Not exact. This can include prompts, status rows, or earlier output from pane ${agent.pane_id}.`,
  preview: captured.answer,
  paneId: agent.pane_id,
  stateChangeSeq: agent.state_change_seq,
})

const processInfoFor = async (paneId, processReader) => {
  try {
    return await processReader(paneId)
  } catch {
    return undefined
  }
}

const exactCaptureFor = async (agent, context, processInfo, capture) => {
  try {
    return await capture({
      context: { ...context, paneId: agent.pane_id },
      agentInfo: agent,
      marker: completionMarkerFor(agent),
      processInfo,
      mode: "exact",
    })
  } catch (error) {
    if (error instanceof ExactCaptureUnavailableError) return undefined
    throw error
  }
}

const choicesForAgent = async (agent, context, dependencies) => {
  if (!completedStatus(agent)) {
    return {
      choices: [],
      notes: [`${agentLabel(agent)} in pane ${agent.pane_id} is still ${agent.agent_status ?? "active"}.`],
    }
  }
  const processInfo = await processInfoFor(agent.pane_id, dependencies.processReader)
  const choices = []
  const notes = []
  try {
    const exact = await exactCaptureFor(agent, context, processInfo, dependencies.capture)
    if (exact === undefined) {
      notes.push(`${agentLabel(agent)} pane ${agent.pane_id} has no exact session identity.`)
    } else {
      choices.push(exactChoice(agent, exact))
    }
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const terminal = await dependencies.capture({
      context: { ...context, paneId: agent.pane_id },
      agentInfo: agent,
      marker: completionMarkerFor(agent),
      processInfo,
      mode: "terminal",
    })
    choices.push(terminalChoice(agent, terminal))
  } catch (error) {
    notes.push(error instanceof Error ? error.message : String(error))
  }
  return { choices, notes }
}

export const inspectCaptureOptions = async (
  context,
  {
    candidateResolver = sourceAgentCandidates,
    capture = captureFinalAnswer,
    processReader = getProcessInfo,
  } = {},
) => {
  const agents = await candidateResolver(context)
  const results = await Promise.all(
    agents.map((agent) => choicesForAgent(agent, context, { capture, processReader })),
  )
  return {
    choices: results.flatMap((result) => result.choices),
    notes: results.flatMap((result) => result.notes),
  }
}

export const selectedTextChoice = (selection) => ({
  id: "selection",
  kind: "selection",
  label: "Open highlighted text",
  detail: "Uses the clipboard selection exactly as shown.",
  preview: selection,
})
