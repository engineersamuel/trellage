import path from "node:path"
import type { FirstmateInstanceControlContextV1 } from "@trellage/guide-core"
import { sourceWorkingDirectory } from "./context.ts"
import { getAgent, getProcessInfo, HerdrRequestError } from "./herdr.ts"
import { exactSessionIdentity, exactSessionIdFromProcessInfo, sessionIdFromAgentSession } from "./transcripts.ts"
import { hasFirstmateSessionTokens, trellageSessionIdentity } from "./trellage-session.ts"

interface FirstmateOriginSource {
  readonly workspaceId: string
  readonly paneId: string
  readonly cwd: string
}

interface FirstmateOriginOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly expectedSessionId?: string
  readonly signal?: AbortSignal
  readonly getAgentForPane?: typeof getAgent
  readonly processReader?: typeof getProcessInfo
}

const readOptionalSourceAgent = async (
  paneId: string,
  options: Parameters<typeof getAgent>[1],
  reader: typeof getAgent,
): Promise<Awaited<ReturnType<typeof getAgent>> | undefined> => {
  try {
    return await reader(paneId, options)
  } catch (error) {
    if (error instanceof HerdrRequestError && error.code === "agent_not_found") return undefined
    throw error
  }
}

const assertOriginPane = (source: FirstmateOriginSource, agentInfo: Awaited<ReturnType<typeof getAgent>>): void => {
  if (agentInfo.workspace_id !== source.workspaceId || agentInfo.pane_id !== source.paneId ||
      path.resolve(sourceWorkingDirectory(source, agentInfo)) !== path.resolve(source.cwd)) {
    throw new Error("The Firstmate source pane changed. No replacement origin was selected.")
  }
}

/** Pane metadata supplies a private hint; Guide still verifies the owned registry before selection. */
export const readFirstmateLaunchOrigin = async (
  source: FirstmateOriginSource,
  options: FirstmateOriginOptions = {},
): Promise<FirstmateInstanceControlContextV1 | undefined> => {
  const env = options.env ?? process.env
  const requestOptions = { socketPath: env.HERDR_SOCKET_PATH, signal: options.signal }
  const agentInfo = await readOptionalSourceAgent(source.paneId, requestOptions, options.getAgentForPane ?? getAgent)
  if (agentInfo === undefined || !hasFirstmateSessionTokens(agentInfo.tokens)) return undefined
  assertOriginPane(source, agentInfo)
  const processInfo = await (options.processReader ?? getProcessInfo)(source.paneId, requestOptions)
  if (processInfo.pane_id !== undefined && processInfo.pane_id !== source.paneId) {
    throw new Error("Firstmate process information belongs to another source pane.")
  }
  const identity = trellageSessionIdentity({ agent: agentInfo.agent, tokens: agentInfo.tokens, processInfo })
  if (typeof agentInfo.agent !== "string" || identity?.surface !== "native") {
    throw new Error("Firstmate origin requires a verified Native supervisor session.")
  }
  exactSessionIdentity({
    agentSessionId: sessionIdFromAgentSession(agentInfo.agent, agentInfo.agent_session),
    processSessionId: exactSessionIdFromProcessInfo(agentInfo.agent, processInfo),
    nativeSessionId: identity.sessionId,
  })
  if (options.expectedSessionId !== undefined && identity.sessionId !== options.expectedSessionId) {
    throw new Error("The captured Firstmate session changed. No replacement origin was selected.")
  }
  options.signal?.throwIfAborted()
  return identity.launchOrigin
}
