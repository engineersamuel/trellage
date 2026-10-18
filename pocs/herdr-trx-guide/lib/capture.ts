import { assertCompletedAgent, sourceWorkingDirectory, validateAnswer } from "./context.ts"
import { readAgent } from "./herdr.ts"
import { formatConversationIntent } from "./conversation.ts"
import { trellageSessionIdentity } from "./trellage-session.ts"
import {
  captureStructuredFinalMessage,
  captureStructuredConversation,
  sessionIdFromAgentSession,
  sessionIdFromProcessInfo,
} from "./transcripts.ts"

const diagnostic = (callback, error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (callback === undefined) console.error(message)
  else callback(message)
}

export class ExactCaptureUnavailableError extends Error {
  constructor(message = "No exact completed agent result is available") {
    super(message)
    this.name = "ExactCaptureUnavailableError"
  }
}

export const captureProvenance = (captured) => ({
  source: captured.source,
  confidence: captured.confidence,
  ...(captured.agent === undefined ? {} : { agent: captured.agent }),
  ...(captured.sessionId === undefined ? {} : { sessionId: captured.sessionId }),
  ...(captured.identitySource === undefined ? {} : { identitySource: captured.identitySource }),
  ...(captured.profile === undefined ? {} : { profile: captured.profile }),
})

const selectedCapture = (text) => ({
  answer: validateAnswer(text, "Selected text"),
  source: "selection",
  confidence: "user-selected",
})

const assertExpectedAgentState = (context, agentInfo) => {
  if (
    context.expectedStateChangeSeq !== undefined &&
    agentInfo.state_change_seq !== context.expectedStateChangeSeq
  ) {
    throw new Error("The selected agent changed after the source picker opened")
  }
}

const currentTrellageIdentity = ({
  agent,
  agentInfo,
  processInfo,
  directIdentityReported,
  onDiagnostic,
}) => {
  try {
    return trellageSessionIdentity({
      agent,
      tokens: agentInfo.tokens,
      processInfo,
    })
  } catch (error) {
    if (!directIdentityReported) throw error
    diagnostic(onDiagnostic, error)
    return undefined
  }
}


const captureStructuredAnswer = async ({
  mode,
  identity,
  agent,
  cwd,
  agentInfo,
  processInfo,
  env,
  structuredLookup,
  conversationLookup,
}) => {
  const options = {
    agent,
    cwd,
    agentSession: agentInfo.agent_session,
    processInfo,
    tokens: identity === undefined ? {} : agentInfo.tokens,
    env,
  }
  return mode === "conversation" ? conversationLookup(options) : structuredLookup(options)
}


const formattedCapturedConversation = ({ mode, agent, cwd, structured }) =>
  mode === "conversation"
    ? formatConversationIntent(
        {
          agent,
          cwd,
          sessionId: structured.sessionId,
          ...(structured.profile === undefined ? {} : { profile: structured.profile }),
        },
        structured.messages,
      )
    : undefined

const captureExactAnswer = async ({
  mode,
  context,
  agentInfo,
  processInfo,
  env,
  structuredLookup,
  conversationLookup,
  onDiagnostic,
}) => {
  const cwd = sourceWorkingDirectory(context, agentInfo)
  const agent = typeof agentInfo.agent === "string" ? agentInfo.agent.toLowerCase() : ""
  const agentSessionId = sessionIdFromAgentSession(agent, agentInfo.agent_session)
  const processSessionId = sessionIdFromProcessInfo(agent, processInfo)
  const directIdentityReported =
    agentInfo.agent_session !== undefined || processSessionId !== undefined
  let structured
  try {
    const identity = currentTrellageIdentity({
      agent,
      agentInfo,
      processInfo,
      directIdentityReported,
      onDiagnostic,
    })
    structured = await captureStructuredAnswer({
      mode,
      identity,
      agent,
      cwd,
      agentInfo,
      processInfo,
      env,
      structuredLookup,
      conversationLookup,
    })
  } catch (error) {
    diagnostic(onDiagnostic, error)
    throw error
  }
  if (structured === undefined) {
    throw new ExactCaptureUnavailableError(
      mode === "conversation"
        ? "No exact conversation is available."
        : "No exact session identity is available. Choose a highlighted selection or review the terminal snapshot.",
    )
  }
  if (context.expectedSessionId !== undefined && structured.sessionId !== context.expectedSessionId) {
    throw new Error("The selected agent session changed after the source picker opened")
  }
  const formatted = formattedCapturedConversation({ mode, agent, cwd, structured })
  return {
    answer: validateAnswer(formatted?.text ?? structured.text, `${agent} transcript`),
    source: mode === "conversation" ? "conversation-transcript" : structured.source ?? "transcript",
    confidence: "exact",
    agent,
    sessionId: structured.sessionId,
    identitySource: structured.identitySource,
    ...(structured.profile === undefined ? {} : { profile: structured.profile }),
    ...(formatted === undefined
      ? {}
      : {
          messageCount: formatted.messageCount,
          omittedMessageCount: formatted.omittedMessageCount,
        }),
  }
}

const captureTerminalAnswer = async ({ context, agentInfo, terminalReader }) => {
  const agent = typeof agentInfo.agent === "string" ? agentInfo.agent.toLowerCase() : ""
  const snapshot = await terminalReader(context.paneId)
  if (snapshot.truncated !== false) {
    throw new Error(
      "Herdr reports that the terminal result is truncated. Select the final response in the pane and try again.",
    )
  }
  return {
    answer: validateAnswer(snapshot.text, "Herdr terminal output"),
    source: "terminal",
    confidence: "snapshot",
    ...(agent.length === 0 ? {} : { agent }),
  }
}

export const captureAgentContent = async ({
  context,
  agentInfo,
  marker,
  processInfo,
  env = process.env,
  structuredLookup = captureStructuredFinalMessage,
  conversationLookup = captureStructuredConversation,
  terminalReader = (paneId) => readAgent(paneId),
  onDiagnostic,
  mode = context.captureMode ?? "exact",
}) => {
  if (context.selectedText !== undefined) return selectedCapture(context.selectedText)
  assertCompletedAgent(agentInfo, marker)
  assertExpectedAgentState(context, agentInfo)
  if (mode === "exact" || mode === "conversation") {
    return captureExactAnswer({
      mode,
      context,
      agentInfo,
      processInfo,
      env,
      structuredLookup,
      conversationLookup,
      onDiagnostic,
    })
  }
  if (mode === "terminal") return captureTerminalAnswer({ context, agentInfo, terminalReader })
  throw new Error("Unsupported capture mode")
}
