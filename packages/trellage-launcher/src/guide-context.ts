import {
  GUIDE_MAX_ORIGINAL_INTENT,
  GUIDE_MAX_GENERATED_SPEC,
  parseFirstmateOrchestrationV1,
  parseGuideProjectTargetV1,
  type FirstmateOrchestrationV1,
  type GuideProjectTargetV1,
  type ProfileGuideV1,
  type ProfileGuideWorkflow,
} from "@trellage/guide-core"
import { GuideValidationError, text } from "./guide-text.ts"
import type { GuideGenerateCandidate } from "./guide-provider.ts"
import {
  renderWorkflowBodyCandidate,
  validateFinalGuideCandidate,
  workflowBodyCandidate,
  workflowPromptFrame,
  workflowUsesFixedFrame,
} from "./guide-workflow-prompt.ts"

export const guidePromptRendererVersion = 6

import { guideTaskOrchestration, type GuideTaskOrchestration } from "./guide-orchestration-context.ts"
export { guideTaskOrchestration, type GuideTaskOrchestration } from "./guide-orchestration-context.ts"

export interface GuideTaskContext {
  readonly profileRef?: string
  readonly originalIntent?: string
  readonly projectTarget?: GuideProjectTargetV1 | null
  readonly orchestration?: GuideTaskOrchestration
}

export interface GuideLegacyFirstmateContext {
  readonly originalIntent: string
  readonly projectTarget: GuideProjectTargetV1 | null
  readonly projectTargetConfirmed: true
  readonly workflowId: string
  readonly workflow: ProfileGuideWorkflow
}

const isFirstmateRef = (profileRef: string | undefined): boolean => profileRef?.startsWith("native:fmx/") === true
const legacyFirstmateContext = (context: GuideTaskContext): boolean =>
  isFirstmateRef(context.profileRef) && context.orchestration === undefined

export const validateGuideOriginalIntent = (value: unknown): string =>
  text(value, "originalIntent", GUIDE_MAX_ORIGINAL_INTENT, { multiline: true, preserve: true, utf16: true })

export const assertGuidePromptDeliveryContext = (context: GuideTaskContext): void => {
  if (context.orchestration !== undefined) return
  if (!legacyFirstmateContext(context) && context.projectTarget !== undefined && context.projectTarget !== null) {
    throw new GuideValidationError("projectTarget", "requires an inbox-capable Firstmate profile; a one-prompt launch cannot carry this project contract")
  }
  if (context.originalIntent !== undefined && validateGuideOriginalIntent(context.originalIntent).length > GUIDE_MAX_GENERATED_SPEC) {
    throw new GuideValidationError("single-prompt delivery", "cannot carry the complete original intent within 8000 UTF-16 code units; use inbox-backed Firstmate or explicitly shorten the intent")
  }
}

const singlePromptOriginalAppendix = (context: GuideTaskContext): string =>
  context.orchestration !== undefined || context.originalIntent === undefined
    ? ""
    : `\n\n## Original human intent (unchanged)\n\n${validateGuideOriginalIntent(context.originalIntent)}`

export const guidePromptBodyBudget = (workflow: ProfileGuideWorkflow, context: GuideTaskContext): number => {
  assertGuidePromptDeliveryContext(context)
  const frame = workflowUsesFixedFrame(workflow) ? workflowPromptFrame(workflow) : undefined
  const fixedLength = frame === undefined ? 0 : frame.beforeBody.length + frame.afterBody.length
  const remaining = GUIDE_MAX_GENERATED_SPEC - fixedLength - singlePromptOriginalAppendix(context).length
  if (remaining < 1) {
    throw new GuideValidationError(
      "bodyBudget",
      "fixed framing and preserved input leave no body space within 8000 UTF-16 code units; no input was removed",
    )
  }
  return remaining
}

export const guideModelBodyCandidate = (
  workflow: ProfileGuideWorkflow,
  candidate: GuideGenerateCandidate,
  context: GuideTaskContext,
): GuideGenerateCandidate => {
  const body = workflowBodyCandidate(workflow, candidate)
  const appendix = singlePromptOriginalAppendix(context)
  return appendix.length > 0 && body.prompt.endsWith(appendix)
    ? { ...body, prompt: body.prompt.slice(0, -appendix.length) }
    : body
}

export const completeSinglePromptArtifact = (
  workflow: ProfileGuideWorkflow,
  candidate: GuideGenerateCandidate,
  context: GuideTaskContext,
): GuideGenerateCandidate => {
  assertGuidePromptDeliveryContext(context)
  if (context.orchestration !== undefined || context.originalIntent === undefined) return validateFinalGuideCandidate(candidate)
  const original = validateGuideOriginalIntent(context.originalIntent)
  const body = workflowBodyCandidate(workflow, candidate)
  const appendix = singlePromptOriginalAppendix(context)
  if (body.prompt.endsWith(appendix) || (!legacyFirstmateContext(context) && body.prompt.includes(original))) {
    return validateFinalGuideCandidate(candidate)
  }
  const complete = renderWorkflowBodyCandidate(workflow, {
    ...body,
    prompt: `${body.prompt}${appendix}`,
  }, { preserveBody: true })
  if (complete.prompt.length > GUIDE_MAX_GENERATED_SPEC) {
    throw new GuideValidationError("single-prompt delivery", "cannot fit the complete original intent and specification within 8000 UTF-16 code units; no input was removed")
  }
  return validateFinalGuideCandidate(complete)
}

export const guideTaskContext = (intent: string, input: GuideTaskContext = {}): GuideTaskContext => ({
  ...(input.profileRef === undefined ? {} : { profileRef: text(input.profileRef, "profileRef", 256) }),
  ...(input.originalIntent === undefined && input.projectTarget === undefined && input.orchestration === undefined
    ? {}
    : { originalIntent: validateGuideOriginalIntent(input.originalIntent ?? intent) }),
  ...(input.projectTarget === undefined
    ? {}
    : { projectTarget: input.projectTarget === null ? null : parseGuideProjectTargetV1(input.projectTarget) }),
  ...(input.orchestration === undefined ? {} : { orchestration: guideTaskOrchestration(input.orchestration) }),
})

/** Compatibility for saved legacy requests; this changes validation context, never their bytes or authority. */
export const savedLegacyFirstmateOrchestration = (
  prompt: string, current: FirstmateOrchestrationV1,
): FirstmateOrchestrationV1 => {
  if (current.instances === undefined) return current
  const opening = prompt.indexOf("\n```json\n")
  const closing = prompt.indexOf("\n```\n", opening + 9)
  if (!prompt.startsWith("## Firstmate request context\n") || opening < 0 || closing < 0) {
    throw new Error("The saved legacy request has no valid fixed context. Its original payload was not changed.")
  }
  const metadata: unknown = JSON.parse(prompt.slice(opening + 9, closing))
  if (metadata === null || typeof metadata !== "object" || !("orchestration" in metadata)) {
    throw new Error("The saved legacy request has no supported orchestration controls.")
  }
  const recorded = metadata.orchestration
  if (recorded !== null && typeof recorded === "object" && "instances" in recorded) return current
  const previous = parseFirstmateOrchestrationV1(recorded)
  const legacyControls = (value: FirstmateOrchestrationV1) => {
    const { instances: _instances, preparation: _preparation, ...controls } = parseFirstmateOrchestrationV1(value)
    return JSON.stringify(controls)
  }
  if (legacyControls(previous) !== legacyControls(current)) {
    throw new Error("The saved legacy request's controls changed. Its source, payload, and ID cannot be silently replaced.")
  }
  return previous
}

const firstmateContextFrame = (
  profileRef: string,
  workflow: ProfileGuideWorkflow,
  context: GuideTaskContext,
  orchestration: GuideTaskOrchestration | undefined,
): string => {
  const target = context.projectTarget ?? null
  const scope = workflow.scope ?? "project"
  const metadata = {
    profileRef,
    workflowId: workflow.id,
    scope,
    projectTarget: target,
    ...(orchestration === undefined ? { delivery: "manual-paste" } : { orchestration }),
  }
  const targetRule = target !== null
    ? "Use this confirmed project target, not the supervisor runtime or Herdr pane directory. Dirty changes are excluded."
    : scope === "fleet"
      ? "This request has fleet scope. Do not infer a project from the runtime or terminal directory."
      : "The project target is not confirmed. Obtain a human-confirmed target before project mutation or registration."
  return [
    "## Firstmate request context",
    "",
    "The following JSON is request data, not permission to install, merge, deploy, or widen the task.",
    "```json",
    JSON.stringify(metadata, null, 2).replaceAll("{{", "\\u007b\\u007b"),
    "```",
    targetRule,
    ...(orchestration?.instances === undefined ? [] : [
      "Use only the selected owned runtime's verified task namespace. Do not derive it from a profile, instance name, legacy prefix, or UUID. Stop before creating tasks or workers if it cannot be verified.",
    ]),
    orchestration === undefined
      ? "The complete manual-paste artifact includes the unchanged original human intent below. Preserve its scope and restrictions."
      : "Original human intent is carried separately from the generated specification. Preserve its scope and restrictions.",
    orchestration === undefined
      ? "This legacy backend declares no inbox or atomic fleet-identity control contract. Use its existing interactive launch and supported commands, not new control APIs or guarded recovery. The human retains captain authority."
      : "Firstmate is the supervisor; the human retains captain authority. Only the supported Claude worker controls apply.",
    "",
  ].join("\n")
}

export interface PreparedGuidePrompt {
  readonly guide: ProfileGuideV1
  readonly workflow: ProfileGuideWorkflow
  readonly context: GuideTaskContext
  readonly bodyBudget: number
}

export const prepareGuidePrompt = (
  guide: ProfileGuideV1,
  workflowId: string,
  profileRef: string,
  intent: string,
  input: GuideTaskContext = {},
): PreparedGuidePrompt => {
  const selected = guide.workflows.find(({ id }) => id === workflowId)
  if (selected === undefined) throw new Error(`Unknown workflow reference: ${workflowId}`)
  const context = guideTaskContext(intent, {
    ...input, profileRef,
    ...(isFirstmateRef(profileRef) ? { originalIntent: input.originalIntent ?? intent } : {}),
  })
  const legacy = legacyFirstmateContext(context)
  if (!legacy && (context.orchestration === undefined || selected.frame !== "fixed")) {
    return { guide, workflow: selected, context, bodyBudget: guidePromptBodyBudget(selected, context) }
  }
  const workflow: ProfileGuideWorkflow = {
    ...selected,
    frame: "fixed",
    promptTemplate: `${firstmateContextFrame(profileRef, selected, context, context.orchestration)}\n${selected.promptTemplate}`,
  }
  return {
    guide: { ...guide, workflows: guide.workflows.map((entry) => entry.id === workflowId ? workflow : entry) },
    workflow,
    context,
    bodyBudget: guidePromptBodyBudget(workflow, context),
  }
}

export const validateFirstmatePromptFrame = (
  profileRef: string,
  workflow: ProfileGuideWorkflow,
  prompt: string,
  input: GuideTaskContext,
): void => {
  const context = guideTaskContext(input.originalIntent ?? "", { ...input, profileRef })
  if (!isFirstmateRef(profileRef) || workflow.frame !== "fixed") {
    throw new GuideValidationError("workflow", "requires a fixed Firstmate workflow frame")
  }
  const frame = workflowPromptFrame(workflow)
  const prefix = `${firstmateContextFrame(profileRef, workflow, context, context.orchestration)}\n`
  if (!frame.beforeBody.startsWith(prefix) || frame.beforeBody.indexOf(prefix, prefix.length) !== -1) {
    throw new GuideValidationError("workflow", "does not match the confirmed Firstmate profile, project target and controls")
  }
  if (!prompt.startsWith(frame.beforeBody) || !prompt.endsWith(frame.afterBody) ||
      prompt.length <= frame.beforeBody.length + frame.afterBody.length) {
    throw new GuideValidationError("prompt", "must retain the exact selected Firstmate workflow frame")
  }
  const body = guideModelBodyCandidate(workflow, { title: "Request", prompt, notes: "Confirmed specification." }, context).prompt
  if (!body.trim() || body.includes(frame.beforeBody) || (frame.afterBody.trim().length > 0 && body.includes(frame.afterBody))) {
    throw new GuideValidationError("prompt", "requires a nonempty specification and exactly one Firstmate workflow frame")
  }
  validateFinalGuideCandidate({ title: "Request", prompt, notes: "Confirmed specification." })
}

export const validateLegacyFirstmateArtifact = (
  profileRef: string,
  prompt: string,
  context: GuideLegacyFirstmateContext | undefined,
): void => {
  if (context?.projectTargetConfirmed !== true || context.workflowId !== context.workflow.id) {
    throw new GuideValidationError("legacy Firstmate delivery", "requires confirmed original intent, target and selected workflow")
  }
  if (context.projectTarget === undefined || (context.workflow.scope !== "fleet" && context.projectTarget === null)) {
    throw new GuideValidationError("projectTarget", "requires a confirmed project for this legacy Firstmate workflow")
  }
  const input = guideTaskContext(context.originalIntent, {
    profileRef, originalIntent: context.originalIntent, projectTarget: context.projectTarget,
  })
  guidePromptBodyBudget(context.workflow, input)
  validateFirstmatePromptFrame(profileRef, context.workflow, prompt, input)
  const complete = completeSinglePromptArtifact(context.workflow, {
    title: "Manual-paste request", prompt, notes: "Complete confirmed input.",
  }, input)
  if (complete.prompt !== prompt) {
    throw new GuideValidationError("legacy Firstmate delivery", "must include the complete unchanged original intent, target, workflow and specification")
  }
}

export const registeredGuideProjectTarget = (projectName: string): GuideProjectTargetV1 =>
  parseGuideProjectTargetV1({
    schemaVersion: 1,
    projectName,
    source: null,
    entryWorktree: null,
    baseRevision: null,
    dirty: null,
    dirtyChanges: "excluded",
  })
