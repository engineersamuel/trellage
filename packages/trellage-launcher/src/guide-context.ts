import {
  GUIDE_MAX_ORIGINAL_INTENT,
  GUIDE_MAX_GENERATED_SPEC,
  type ProfileGuideV1,
  type ProfileGuideWorkflow,
} from "@trellage/guide-core"
import { GuideValidationError, text } from "./guide-text.ts"
import {
  parseApprovedCustomerContext, renderCustomerContext, type ApprovedGuideCustomerContext,
} from "./guide-customer-context.ts"
import type { GuideGenerateCandidate } from "./guide-provider.ts"
import {
  renderWorkflowBodyCandidate,
  validateFinalGuideCandidate,
  workflowBodyCandidate,
  workflowPromptFrame,
  workflowUsesFixedFrame,
} from "./guide-workflow-prompt.ts"

export const guidePromptRendererVersion = 7

export interface GuideTaskContext {
  readonly profileRef?: string
  readonly originalIntent?: string
  readonly customerContext?: ApprovedGuideCustomerContext
}

export const validateGuideOriginalIntent = (value: unknown): string =>
  text(value, "originalIntent", GUIDE_MAX_ORIGINAL_INTENT, { multiline: true, preserve: true, utf16: true })

export const assertGuidePromptDeliveryContext = (context: GuideTaskContext): void => {
  if (context.originalIntent !== undefined && validateGuideOriginalIntent(context.originalIntent).length > GUIDE_MAX_GENERATED_SPEC) {
    throw new GuideValidationError("single-prompt delivery", "cannot carry the complete original intent within 8000 UTF-16 code units; explicitly shorten the intent")
  }
}

const singlePromptOriginalAppendix = (context: GuideTaskContext): string =>
  [
    ...(context.originalIntent === undefined ? [] : [`\n\n## Original human intent (unchanged)\n\n${validateGuideOriginalIntent(context.originalIntent)}`]),
    ...(context.customerContext === undefined ? [] : [`\n\n${renderCustomerContext(context.customerContext)}`]),
  ].join("")

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
  if (context.originalIntent === undefined && context.customerContext === undefined) {
    return validateFinalGuideCandidate(candidate)
  }
  const body = workflowBodyCandidate(workflow, candidate)
  const appendix = singlePromptOriginalAppendix(context)
  const includesOriginal = context.customerContext === undefined && context.originalIntent !== undefined &&
    body.prompt.includes(validateGuideOriginalIntent(context.originalIntent))
  if (body.prompt.endsWith(appendix) || includesOriginal) {
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

export const guideTaskContext = (input: GuideTaskContext = {}): GuideTaskContext => ({
  ...(input.profileRef === undefined ? {} : { profileRef: text(input.profileRef, "profileRef", 256) }),
  ...(input.originalIntent === undefined ? {} : { originalIntent: validateGuideOriginalIntent(input.originalIntent) }),
  ...(input.customerContext === undefined ? {} : { customerContext: parseApprovedCustomerContext(input.customerContext) }),
})

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
  input: GuideTaskContext = {},
): PreparedGuidePrompt => {
  const workflow = guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new Error(`Unknown workflow reference: ${workflowId}`)
  const context = guideTaskContext({ ...input, profileRef })
  return { guide, workflow, context, bodyBudget: guidePromptBodyBudget(workflow, context) }
}
