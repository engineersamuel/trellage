// @ts-nocheck -- Existing Herdr response adapter; exact capture is revalidated downstream.
import { getAgent, HerdrRequestError, listAgents } from "./herdr.ts"

const completed = (agent) =>
  agent.agent_status === "done" || agent.agent_status === "idle"

const sequence = (agent) =>
  Number.isSafeInteger(agent.state_change_seq) ? agent.state_change_seq : -1

const revision = (agent) =>
  Number.isSafeInteger(agent.revision) ? agent.revision : -1

const newestFirst = (left, right) =>
  sequence(right) - sequence(left) ||
  revision(right) - revision(left) ||
  String(right.pane_id).localeCompare(String(left.pane_id))

const fallbackAgent = (agents, context) => {
  const workspaceAgents = agents.filter(
    (agent) =>
      agent.workspace_id === context.workspaceId &&
      typeof agent.pane_id === "string" &&
      agent.pane_id.length > 0,
  )
  const tabAgents =
    context.tabId === undefined
      ? []
      : workspaceAgents.filter((agent) => agent.tab_id === context.tabId)
  const localAgents = tabAgents.length > 0 ? tabAgents : workspaceAgents
  const completedAgents = localAgents.filter(completed)
  return [...(completedAgents.length > 0 ? completedAgents : localAgents)].sort(newestFirst)
}

const checkedAgent = (agent, context, paneId) => {
  if (agent.workspace_id !== context.workspaceId || agent.pane_id !== paneId) {
    throw new Error("The selected Herdr agent changed before capture")
  }
  return agent
}

export const sourceAgentCandidates = async (
  context,
  {
    getAgentForPane = getAgent,
    listAvailableAgents = listAgents,
  } = {},
) => {
  const requestedPaneId = context.sourcePaneId ?? context.paneId
  try {
    return [checkedAgent(await getAgentForPane(requestedPaneId), context, requestedPaneId)]
  } catch (error) {
    if (!(error instanceof HerdrRequestError && error.code === "agent_not_found")) throw error
    if (context.sourcePaneId !== undefined) {
      throw new Error("The selected source agent is no longer available")
    }
  }

  const agents = fallbackAgent(await listAvailableAgents(), context)
  if (agents.length === 0) {
    throw new Error("No agent was found in the active Herdr workspace")
  }
  return agents
}

export const resolveSourceAgent = async (context, dependencies) => {
  const candidates = await sourceAgentCandidates(context, dependencies)
  if (candidates.length > 1) {
    throw new Error("More than one completed agent is available. Choose the source agent first.")
  }
  return candidates[0]
}
