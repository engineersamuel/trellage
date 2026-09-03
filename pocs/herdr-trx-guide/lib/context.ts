import path from "node:path"

export const guideIntentMaximumLength = 60_000

const multilineControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u
const identifierControls = /[\u0000-\u001f\u007f-\u009f]/u
const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const captureModes = new Set(["conversation", "exact", "terminal"])
const captureSources = new Set([
  "selection",
  "conversation-transcript",
  "transcript",
  "sandbox-transcript",
  "terminal",
  "capture-queue",
])
const captureConfidences = new Set(["user-selected", "exact", "snapshot", "user-curated"])

export const panelInvocationSource = "trellage-guide-panel"

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const requiredString = (record, key, label, maximum = 4096) => {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`)
  if (value.length > maximum || identifierControls.test(value)) throw new Error(`${label} is invalid`)
  return value
}

const optionalString = (record, key, maximum = 4096) => {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > maximum || identifierControls.test(value)) {
    throw new Error(`${key} is invalid`)
  }
  return value
}

const optionalSafeInteger = (record, key) => {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} is invalid`)
  return value
}

const optionalMultilineString = (record, key, maximum) => {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length > maximum) throw new Error(`${key} is invalid`)
  return value
}

const nonemptyFields = (entries) =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined && value.length > 0))

const selectionInvocationFields = (value) => {
  const selectedText = optionalMultilineString(value, "selected_text", 1024 * 1024)
  return {
    ...(selectedText === undefined || selectedText.trim().length === 0 ? {} : { selectedText }),
  }
}

const optionalInvocationFields = (value) => {
  const tabId = optionalString(value, "tab_id", 256)
  const agent = optionalString(value, "focused_pane_agent", 256)
  const invocationSource = optionalString(value, "invocation_source", 256)
  return {
    ...nonemptyFields([
      ["tabId", tabId],
      ["agent", agent],
      ["invocationSource", invocationSource],
    ]),
    ...selectionInvocationFields(value),
  }
}

export const parseInvocationContext = (source) => {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not valid JSON")
  }
  if (!isRecord(value)) throw new Error("HERDR_PLUGIN_CONTEXT_JSON must be an object")
  const workspaceId = requiredString(value, "workspace_id", "focused workspace id", 256)
  const paneId = requiredString(value, "focused_pane_id", "focused pane id", 256)
  const cwd = requiredString(value, "focused_pane_cwd", "focused pane working directory")
  if (!path.isAbsolute(cwd)) throw new Error("focused pane working directory must be absolute")
  return {
    workspaceId,
    paneId,
    cwd,
    ...optionalInvocationFields(value),
  }
}

export const parsePanelChoice = (value) => {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("The source picker choice is invalid")
  }
  const kind = requiredString(value, "kind", "source picker choice", 32)
  const operation = value.operation === "enqueue" ? "enqueue" : undefined
  if (kind === "queue") return { kind }
  if (kind === "selection") {
    return {
      kind,
      ...(operation === undefined ? {} : { operation }),
      selectedText: validateAnswer(value.selectedText, "Selected text"),
    }
  }
  if (!captureModes.has(kind)) throw new Error("The source picker choice is invalid")
  const sourcePaneId = requiredString(value, "paneId", "source pane id", 256)
  const expectedStateChangeSeq = optionalSafeInteger(value, "stateChangeSeq")
  if (expectedStateChangeSeq === undefined) {
    throw new Error("The source picker choice state is missing")
  }
  if (kind === "terminal") {
    return {
      kind,
      ...(operation === undefined ? {} : { operation }),
      sourcePaneId,
      captureMode: kind,
      expectedStateChangeSeq,
    }
  }
  const expectedSessionId = requiredString(value, "sessionId", "source session id", 128)
  if (!safeSessionId.test(expectedSessionId)) {
    throw new Error("The source picker choice session is invalid")
  }
  return {
    kind,
    ...(operation === undefined ? {} : { operation }),
    sourcePaneId,
    captureMode: kind,
    expectedSessionId,
    expectedStateChangeSeq,
  }
}

export const parseCustomPopupContext = (env = process.env) => {
  const workspaceId = env.HERDR_ACTIVE_WORKSPACE_ID
  const tabId = env.HERDR_ACTIVE_TAB_ID
  const paneId = env.HERDR_ACTIVE_PANE_ID
  const cwd = env.HERDR_ACTIVE_PANE_CWD
  const record = {
    workspace_id: workspaceId,
    tab_id: tabId,
    focused_pane_id: paneId,
    focused_pane_cwd: cwd,
  }
  return parseInvocationContext(JSON.stringify(record))
}

export const sourceWorkingDirectory = (context, agentInfo) => {
  for (const value of [agentInfo.foreground_cwd, agentInfo.cwd, context.cwd]) {
    if (typeof value === "string" && value.length > 0 && value.length <= 4096 && !identifierControls.test(value)) {
      if (!path.isAbsolute(value)) continue
      return value
    }
  }
  throw new Error("The focused agent does not have an absolute working directory")
}

export const validateAnswer = (value, source) => {
  if (typeof value !== "string") throw new Error(`${source} did not provide text`)
  const answer = value.trim()
  if (answer.length === 0) throw new Error(`${source} did not provide a nonempty final answer`)
  const characterCount = [...answer].length
  if (characterCount > guideIntentMaximumLength) {
    throw new Error(
      `${source} contains ${characterCount} characters; trx guide accepts at most ${guideIntentMaximumLength}. Select a narrower result and try again.`,
    )
  }
  if (multilineControls.test(answer)) throw new Error(`${source} contains unsupported control characters`)
  return answer
}

export const assertCompletedAgent = (agentInfo, marker) => {
  if (!isRecord(agentInfo)) throw new Error("Herdr did not return focused agent information")
  const status = agentInfo.agent_status
  if (status === "done") return
  const agent = typeof agentInfo.agent === "string" ? agentInfo.agent : ""
  const sequence = agentInfo.state_change_seq
  if (
    status === "idle" &&
    isRecord(marker) &&
    marker.schemaVersion === 1 &&
    marker.paneId === agentInfo.pane_id &&
    marker.agent === agent &&
    marker.stateChangeSeq === sequence
  ) {
    return
  }
  throw new Error(
    status === "working"
      ? "The focused agent is still working"
      : "The focused pane does not have a recorded completed agent result",
  )
}

const captureOptionalString = (record, key, maximum = 4096) => {
  const value = optionalString(record, key, maximum)
  return value === undefined || value.length === 0 ? undefined : value
}

const expectedCaptureConfidence = (source) => {
  if (source === "selection") return "user-selected"
  if (source === "terminal") return "snapshot"
  if (source === "capture-queue") return "user-curated"
  return "exact"
}

export const parseCaptureProvenance = (value) => {
  if (!isRecord(value)) throw new Error("The guide invocation capture is invalid")
  const source = requiredString(value, "source", "capture source", 64)
  const confidence = requiredString(value, "confidence", "capture confidence", 64)
  if (!captureSources.has(source) || !captureConfidences.has(confidence)) {
    throw new Error("The guide invocation capture is invalid")
  }
  const expectedConfidence = expectedCaptureConfidence(source)
  if (confidence !== expectedConfidence) throw new Error("The guide invocation capture is invalid")
  const agent = captureOptionalString(value, "agent", 128)
  const sessionId = captureOptionalString(value, "sessionId", 128)
  const identitySource = captureOptionalString(value, "identitySource", 128)
  const profile = captureOptionalString(value, "profile", 128)
  if (sessionId !== undefined && !safeSessionId.test(sessionId)) {
    throw new Error("capture session id is invalid")
  }
  return {
    source,
    confidence,
    ...(agent === undefined ? {} : { agent }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(identitySource === undefined ? {} : { identitySource }),
    ...(profile === undefined ? {} : { profile }),
  }
}

export const parsePopupInvocation = (value) => {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("The guide invocation file is invalid")
  const answer = validateAnswer(value.answer, "Captured answer")
  const capture = parseCaptureProvenance(value.capture)
  if (!isRecord(value.source)) throw new Error("The guide invocation source is invalid")
  const workspaceId = requiredString(value.source, "workspaceId", "source workspace id", 256)
  const paneId = requiredString(value.source, "paneId", "source pane id", 256)
  const cwd = requiredString(value.source, "cwd", "source working directory")
  if (!path.isAbsolute(cwd)) throw new Error("source working directory must be absolute")
  return { answer, capture, source: { workspaceId, paneId, cwd } }
}
