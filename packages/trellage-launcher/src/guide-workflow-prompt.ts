import type { ProfileGuideV1, ProfileGuideWorkflow } from "../../trellage-guide-core/dist/index.js"
import type { GuideGenerateCandidate, GuideOptimizeFixedFrame } from "./guide-provider.js"

const intentPlaceholder = "{{intent}}"
const authoredCommandToken = /^[/\$][a-z0-9][a-z0-9._:/-]*$/iu
const whitespaceSegment = /^\s+$/u
const unicodeLetterOrDigit = /[\p{L}\p{N}]/u
const maximumSuffixComparisonTokens = 32
const maximumSuffixSlidingWindowTokens = 12
const minimumSuffixFragmentTokenCount = 2
const minimumSuffixFragmentCharacterCount = 12
const minimumMiddleSuffixFragmentTokenCount = 5
const minimumMiddleSuffixFragmentCharacterCount = 24
const minimumFixedProsePrefixTokenCount = 3
const maximumProsePrefixNormalizationPasses = 32

const escapeRegularExpression = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
const flexibleWhitespacePattern = (value: string): string =>
  value
    .split(/(\s+)/u)
    .map((segment) => (whitespaceSegment.test(segment) ? "\\s+" : escapeRegularExpression(segment)))
    .join("")

type GuideWorkflowModelStage = "generation" | "refinement" | "optimization"

export class GuideWorkflowBodyError extends Error {
  readonly stage: GuideWorkflowModelStage
  readonly workflowId: string

  constructor(stage: GuideWorkflowModelStage, workflowId: string, reason: string) {
    const recovery =
      stage === "generation"
        ? "Retry generation or use the authored template fallback."
        : stage === "refinement"
          ? "Retry refinement or keep the current candidate."
          : "Keep the current authorized candidate."
    super(`Model ${stage} for workflow "${workflowId}" ${reason}. ${recovery}`)
    this.name = "GuideWorkflowBodyError"
    this.stage = stage
    this.workflowId = workflowId
  }
}

export enum GuideCandidatePromptStage {
  GeneratedBodyNormalization = "generated-body normalization",
  FinalRendering = "optimization resolution and exact rendering",
}

export class GuideCandidatePromptCollisionError extends Error {
  readonly stage: GuideCandidatePromptStage

  constructor(stage: GuideCandidatePromptStage) {
    super(
      `Candidate prompts are no longer distinct after ${stage}. ` +
        "Retry generation or use the authored template fallback.",
    )
    this.name = "GuideCandidatePromptCollisionError"
    this.stage = stage
  }
}

type PromptCandidate = { readonly prompt: string }

export type GuideCandidatePromptTriple<Candidate extends PromptCandidate> = readonly [
  Candidate,
  Candidate,
  Candidate,
]

/** Requires all three prompt strings to remain distinct at a generation pipeline boundary. */
export const requireDistinctGuideCandidatePrompts = <Candidate extends PromptCandidate>(
  candidates: GuideCandidatePromptTriple<Candidate>,
  stage: GuideCandidatePromptStage,
): GuideCandidatePromptTriple<Candidate> => {
  if (new Set(candidates.map(({ prompt }) => prompt)).size !== candidates.length) {
    throw new GuideCandidatePromptCollisionError(stage)
  }
  return candidates
}

/** Splits the one authored intent slot into the exact text before and after the body. */
export const workflowPromptFrame = (workflow: ProfileGuideWorkflow): GuideOptimizeFixedFrame => {
  const placeholderIndex = workflow.promptTemplate.indexOf(intentPlaceholder)
  if (placeholderIndex < 0 || placeholderIndex !== workflow.promptTemplate.lastIndexOf(intentPlaceholder)) {
    throw new Error(`Workflow ${workflow.id} must contain exactly one ${intentPlaceholder} placeholder`)
  }
  return {
    beforeBody: workflow.promptTemplate.slice(0, placeholderIndex),
    afterBody: workflow.promptTemplate.slice(placeholderIndex + intentPlaceholder.length),
  }
}

const exactFramedBody = (frame: GuideOptimizeFixedFrame, prompt: string): string | undefined => {
  if (!prompt.startsWith(frame.beforeBody) || !prompt.endsWith(frame.afterBody)) return undefined
  const bodyEnd = prompt.length - frame.afterBody.length
  if (bodyEnd < frame.beforeBody.length) return undefined
  return prompt.slice(frame.beforeBody.length, bodyEnd)
}

const flexiblePrefixLength = (prompt: string, prefix: string): number | undefined => {
  if (prefix.length === 0) return 0
  return new RegExp(`^${flexibleWhitespacePattern(prefix)}`, "u").exec(prompt)?.[0].length
}

const flexibleSuffixIndex = (prompt: string, suffix: string): number | undefined => {
  if (suffix.length === 0) return prompt.length
  return new RegExp(`${flexibleWhitespacePattern(suffix)}$`, "u").exec(prompt)?.index
}

const stripExactOptionalAuthoredSuffix = (authoredSuffix: string, proposedBody: string): string => {
  if (authoredSuffix.length === 0) return proposedBody
  const bodyWithoutTrailingWhitespace = proposedBody.trimEnd()
  const suffixIndex = flexibleSuffixIndex(bodyWithoutTrailingWhitespace, authoredSuffix)
  return suffixIndex === undefined
    ? proposedBody
    : bodyWithoutTrailingWhitespace.slice(0, suffixIndex)
}

const flexibleFramedBody = (frame: GuideOptimizeFixedFrame, prompt: string): string | undefined => {
  const prefixLength = flexiblePrefixLength(prompt, frame.beforeBody)
  if (prefixLength === undefined) return undefined
  const remainder = prompt.slice(prefixLength)
  const suffixIndex = flexibleSuffixIndex(remainder, frame.afterBody)
  if (suffixIndex === undefined) return undefined
  return remainder.slice(0, suffixIndex)
}

const exactWorkflowBodyCandidate = (
  workflow: ProfileGuideWorkflow,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate | undefined => {
  const body = exactFramedBody(workflowPromptFrame(workflow), candidate.prompt)
  return body === undefined ? undefined : { ...candidate, prompt: body }
}

const workflowBodyText = (workflow: ProfileGuideWorkflow, prompt: string): string =>
  exactFramedBody(workflowPromptFrame(workflow), prompt) ?? prompt

/**
 * Returns the body carried by a skill-workflow candidate. An exact authored
 * frame is removed. Any other text is a direct body edit and stays intact.
 */
export const workflowBodyCandidate = (
  workflow: ProfileGuideWorkflow,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => {
  if (workflow.skill === undefined) return candidate
  return exactWorkflowBodyCandidate(workflow, candidate) ?? candidate
}

/** Renders a skill workflow's exact authored frame once around a body candidate. */
export const renderWorkflowBodyCandidate = (
  workflow: ProfileGuideWorkflow,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => {
  if (workflow.skill === undefined) return candidate
  const bodyCandidate = workflowBodyCandidate(workflow, candidate)
  const frame = workflowPromptFrame(workflow)
  const renderedBody =
    frame.afterBody.length > 0 && !unicodeLetterOrDigit.test(frame.afterBody)
      ? stripExactOptionalAuthoredSuffix(frame.afterBody, bodyCandidate.prompt.trimEnd())
      : bodyCandidate.prompt
  return {
    ...bodyCandidate,
    prompt: `${frame.beforeBody}${renderedBody}${frame.afterBody}`,
  }
}

/** Restores the selected skill frame after a direct edit without partial-frame heuristics. */
export const restoreWorkflowCandidateFrame = (
  workflow: ProfileGuideWorkflow,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => renderWorkflowBodyCandidate(workflow, candidate)

const authoredCommandTokenForLine = (line: string): string | undefined => {
  const [token] = line.trimStart().split(/\s/u, 1)
  return token !== undefined && authoredCommandToken.test(token) ? token : undefined
}

const authoredCommandTokens = (text: string): ReadonlyArray<string> =>
  text.split(/\r?\n/u).flatMap((line) => {
    const token = authoredCommandTokenForLine(line)
    return token === undefined ? [] : [token]
  })

const authoredWorkflowCommandTokens = (workflow: ProfileGuideWorkflow): ReadonlyArray<string> =>
  authoredCommandTokens(workflow.promptTemplate)

/** True only when a post-body authored line starts with a workflow command. */
export const workflowHasAuthoredCommandSuffix = (workflow: ProfileGuideWorkflow): boolean =>
  workflowPromptFrame(workflow)
    .afterBody.split(/\r?\n/u)
    .slice(1)
    .some((line) => authoredCommandTokenForLine(line) !== undefined)

/**
 * Derives the closed command-token set only from command-led lines in the
 * selected guide's authored templates.
 */
export const guideWorkflowCommandTokens = (guide: ProfileGuideV1): ReadonlyArray<string> => {
  const tokens = new Set<string>()
  for (const workflow of guide.workflows) {
    for (const token of authoredWorkflowCommandTokens(workflow)) tokens.add(token)
  }
  return [...tokens]
}

interface SelectedWorkflowInvocation {
  readonly token: string
  readonly fixedPrefix: string
  readonly fixedTextAfterInvocation: string
}

const selectedWorkflowInvocation = (workflow: ProfileGuideWorkflow): SelectedWorkflowInvocation | undefined => {
  const placeholderIndex = workflow.promptTemplate.indexOf(intentPlaceholder)
  if (placeholderIndex < 0) return undefined
  const lineStart = workflow.promptTemplate.lastIndexOf("\n", placeholderIndex - 1) + 1
  const textBeforePlaceholder = workflow.promptTemplate.slice(lineStart, placeholderIndex)
  const commandLine = /^[\t ]*([/$][a-z0-9][a-z0-9._:/-]*)(?=[\t ]|$)/iu.exec(textBeforePlaceholder)
  if (commandLine === null) return undefined
  const token = commandLine[1]
  if (token === undefined || !authoredCommandToken.test(token)) return undefined
  const tokenIndex = commandLine[0].lastIndexOf(token)
  const fixedPrefix = textBeforePlaceholder.slice(tokenIndex)
  return {
    token,
    fixedPrefix,
    fixedTextAfterInvocation: fixedPrefix.slice(token.length),
  }
}

const bodyAfterFlexibleInvocationPrefix = (prompt: string, prefix: string): string | undefined => {
  const prefixLength = flexiblePrefixLength(prompt, prefix)
  if (prefixLength === undefined) return undefined
  return prompt.slice(prefixLength)
}

const fixedTextTokens = (fixedText: string): ReadonlyArray<string> =>
  fixedText.trim().length === 0 ? [] : fixedText.trim().split(/\s+/u)

interface NormalizedProseToken {
  readonly value: string
  readonly end: number
}

const normalizedProseTokens = (value: string): ReadonlyArray<NormalizedProseToken> =>
  [...value.matchAll(/[\p{L}\p{N}]+/gu)].flatMap((match) => {
    if (match.index === undefined) return []
    return [
      {
        value: match[0].normalize("NFKC").toLowerCase(),
        end: match.index + match[0].length,
      },
    ]
  })

const selectedFixedProsePrefix = (invocation: SelectedWorkflowInvocation): string | undefined =>
  fixedTextTokens(invocation.fixedTextAfterInvocation).length >= minimumFixedProsePrefixTokenCount
    ? invocation.fixedTextAfterInvocation.trimStart()
    : undefined

const normalizedProseTokenValues = (value: string): ReadonlyArray<string> =>
  normalizedProseTokens(value).map(({ value: token }) => token)

const bodyAfterNormalizedProsePrefix = (prompt: string, prefix: string): string | undefined => {
  const prefixTokens = normalizedProseTokenValues(prefix)
  const promptTokens = normalizedProseTokens(prompt)
  if (
    prefixTokens.length < minimumFixedProsePrefixTokenCount ||
    promptTokens.length < prefixTokens.length ||
    !prefixTokens.every((token, index) => token === promptTokens[index]?.value)
  ) {
    return undefined
  }
  const lastPrefixToken = promptTokens[prefixTokens.length - 1]
  if (lastPrefixToken === undefined) return undefined
  return prompt.slice(lastPrefixToken.end).replace(/^[\s\p{Pd}:;,.]+/u, "")
}

const isSubstantiveProseSignal = (tokens: ReadonlyArray<string>): boolean =>
  tokens.length >= minimumFixedProsePrefixTokenCount &&
  tokens.join("").length >= minimumSuffixFragmentCharacterCount

const workflowProsePrefixes = (
  frame: GuideOptimizeFixedFrame,
  invocation: SelectedWorkflowInvocation | undefined,
): ReadonlyArray<string> => {
  const candidates = invocation === undefined ? [frame.beforeBody] : [selectedFixedProsePrefix(invocation)]
  const prefixes = new Map<string, string>()
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const tokens = normalizedProseTokenValues(candidate).slice(0, maximumSuffixComparisonTokens)
    if (!isSubstantiveProseSignal(tokens)) continue
    const key = JSON.stringify(tokens)
    if (!prefixes.has(key)) prefixes.set(key, candidate)
  }
  return [...prefixes.values()].sort(
    (left, right) => normalizedProseTokenValues(right).length - normalizedProseTokenValues(left).length,
  )
}

const tokenSequenceOccurrenceCount = (
  tokens: ReadonlyArray<string>,
  sequence: ReadonlyArray<string>,
): number => {
  if (sequence.length === 0 || tokens.length < sequence.length) return 0
  let count = 0
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => token === tokens[index + offset])) count += 1
  }
  return count
}

const prosePrefixOccurrenceCount = (prefix: string, body: string): number =>
  tokenSequenceOccurrenceCount(
    normalizedProseTokenValues(body),
    normalizedProseTokenValues(prefix).slice(0, maximumSuffixComparisonTokens),
  )

interface ProsePrefixSignal {
  readonly key: string
  readonly tokens: ReadonlyArray<string>
}

const prosePrefixSignals = (prefixes: ReadonlyArray<string>): ReadonlyArray<ProsePrefixSignal> => {
  const signals = new Map<string, ReadonlyArray<string>>()
  for (const prefix of prefixes) {
    const tokens = normalizedProseTokenValues(prefix).slice(0, maximumSuffixComparisonTokens)
    for (let length = minimumFixedProsePrefixTokenCount; length <= tokens.length; length += 1) {
      const signal = tokens.slice(0, length)
      if (!isSubstantiveProseSignal(signal)) continue
      const key = JSON.stringify(signal)
      if (!signals.has(key)) signals.set(key, signal)
    }
  }
  return [...signals].map(([key, tokens]) => ({ key, tokens }))
}

const introducesProsePrefixSignal = (
  prefixes: ReadonlyArray<string>,
  authorizedBody: string,
  proposedBody: string,
): boolean => {
  const authorizedTokens = normalizedProseTokenValues(authorizedBody)
  const proposedTokens = normalizedProseTokenValues(proposedBody)
  return prosePrefixSignals(prefixes).some(
    ({ tokens }) =>
      tokenSequenceOccurrenceCount(proposedTokens, tokens) >
      tokenSequenceOccurrenceCount(authorizedTokens, tokens),
  )
}

const stripNewLeadingProsePrefixes = (
  prefixes: ReadonlyArray<string>,
  authorizedBody: string,
  proposedBody: string,
): string => {
  let body = proposedBody
  for (let pass = 0; pass < maximumProsePrefixNormalizationPasses; pass += 1) {
    const prefix = prefixes.find((candidate) => {
      if (bodyAfterNormalizedProsePrefix(body, candidate) === undefined) return false
      return prosePrefixOccurrenceCount(candidate, body) > prosePrefixOccurrenceCount(candidate, authorizedBody)
    })
    if (prefix === undefined) return body
    body = bodyAfterNormalizedProsePrefix(body, prefix) ?? body
  }
  return body
}

const optionNeutralToken = (token: string): string => token.replace(/^-+/u, "")

const fixedArgumentName = (token: string): string | undefined => {
  const neutralToken = optionNeutralToken(token)
  const separatorIndex = neutralToken.search(/[:=]/u)
  return separatorIndex <= 0 ? undefined : neutralToken.slice(0, separatorIndex)
}

const fixedArgumentValue = (token: string): string | undefined => {
  const neutralToken = optionNeutralToken(token)
  const separatorIndex = neutralToken.search(/[:=]/u)
  return separatorIndex < 0 || separatorIndex === neutralToken.length - 1
    ? undefined
    : neutralToken.slice(separatorIndex + 1)
}

const startsWithFixedTextEcho = (fixedText: string, proposedBody: string): boolean => {
  const [proposedToken] = proposedBody.trimStart().split(/\s/u, 1)
  if (proposedToken === undefined || proposedToken.length === 0) return false
  const neutralProposedToken = optionNeutralToken(proposedToken)
  return fixedTextTokens(fixedText).some((authoredToken) => {
    const neutralAuthoredToken = optionNeutralToken(authoredToken)
    if (
      authoredToken === proposedToken ||
      authoredToken.startsWith(proposedToken) ||
      proposedToken.startsWith(authoredToken) ||
      neutralAuthoredToken === neutralProposedToken ||
      neutralAuthoredToken.startsWith(neutralProposedToken) ||
      neutralProposedToken.startsWith(neutralAuthoredToken)
    ) {
      return true
    }
    const argumentName = fixedArgumentName(authoredToken)
    if (argumentName === undefined) return false
    return (
      neutralProposedToken === argumentName ||
      neutralProposedToken === fixedArgumentValue(authoredToken) ||
      fixedArgumentName(proposedToken) === argumentName
    )
  })
}

const startsWithCommandToken = (prompt: string, token: string): RegExpExecArray | null =>
  new RegExp(`^${escapeRegularExpression(token)}(?=\\s|$)`, "u").exec(prompt)

/** Reduces authored or command-prefixed user intent to the selected workflow body without model safety checks. */
export const workflowAuthorizationBody = (workflow: ProfileGuideWorkflow, intent: string): string => {
  const frame = workflowPromptFrame(workflow)
  const invocation = selectedWorkflowInvocation(workflow)
  const prosePrefixes = workflowProsePrefixes(frame, invocation)
  const normalizeBody = (body: string): string =>
    stripExactOptionalAuthoredSuffix(
      frame.afterBody,
      stripNewLeadingProsePrefixes(prosePrefixes, "", body),
    )
  const framedBody = exactFramedBody(frame, intent) ?? flexibleFramedBody(frame, intent)
  if (framedBody !== undefined) return normalizeBody(framedBody)

  if (invocation === undefined) return normalizeBody(intent)
  const selectedPrefixBody = bodyAfterFlexibleInvocationPrefix(intent, invocation.fixedPrefix)
  if (selectedPrefixBody !== undefined) return normalizeBody(selectedPrefixBody)

  const leadingInvocation = startsWithCommandToken(intent, invocation.token)
  return leadingInvocation === null
    ? normalizeBody(intent)
    : normalizeBody(intent.slice(leadingInvocation[0].length).trimStart())
}

const unsupportedWorkflowAliases = (
  workflow: ProfileGuideWorkflow,
  invocation: SelectedWorkflowInvocation | undefined,
): ReadonlyArray<string> => {
  if (workflow.skill === undefined) return []
  return [`/${workflow.skill}`, `$${workflow.skill}`].filter((alias) => alias !== invocation?.token)
}

const staticFrameSignal = (staticText: string, edge: "prefix" | "suffix"): string | undefined => {
  const segments = staticText.trim().split(/\s+/u).filter(Boolean)
  if (segments.length === 0) return undefined
  const selected = edge === "prefix" ? segments.slice(0, 3) : segments.slice(Math.max(0, segments.length - 3))
  const signal = selected.join(" ")
  return unicodeLetterOrDigit.test(signal) ? signal : undefined
}

const matchesStaticFrameSignal = (staticText: string, edge: "prefix" | "suffix", prompt: string): boolean => {
  const signal = staticFrameSignal(staticText, edge)
  if (signal === undefined) return false
  const pattern =
    edge === "prefix"
      ? `^\\s*${flexibleWhitespacePattern(signal)}(?=\\s|$)`
      : `${flexibleWhitespacePattern(signal)}\\s*$`
  return new RegExp(pattern, "u").test(prompt)
}

const introducesStaticFrameSignal = (
  staticText: string,
  edge: "prefix" | "suffix",
  authorizedBody: string,
  proposedBody: string,
): boolean =>
  matchesStaticFrameSignal(staticText, edge, proposedBody) &&
  !matchesStaticFrameSignal(staticText, edge, authorizedBody)

const normalizedFrameTokens = (value: string): ReadonlyArray<string> =>
  value
    .normalize("NFKC")
    .trim()
    .split(/\s+/u)
    .map((token) => token.toLowerCase().replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, ""))
    .filter((token) => unicodeLetterOrDigit.test(token))

const equalTokens = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((token, index) => token === right[index])

const isSubstantiveSuffixFragment = (tokens: ReadonlyArray<string>): boolean =>
  tokens.length >= minimumSuffixFragmentTokenCount &&
  tokens.join("").replace(/[^\p{L}\p{N}]/gu, "").length >= minimumSuffixFragmentCharacterCount

const tokenEditDistance = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): number => {
  let previous = right.map((_, index) => index + 1)
  previous.unshift(0)
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1]
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const insertion = (current[rightIndex] ?? 0) + 1
      const deletion = (previous[rightIndex + 1] ?? 0) + 1
      const substitution =
        (previous[rightIndex] ?? 0) + (left[leftIndex] === right[rightIndex] ? 0 : 1)
      current.push(Math.min(insertion, deletion, substitution))
    }
    previous = current
  }
  return previous[right.length] ?? left.length
}

const exactAuthoredSuffixSignals = (body: string, authoredSuffix: string): ReadonlyArray<string> =>
  [...body.matchAll(new RegExp(flexibleWhitespacePattern(authoredSuffix), "gu"))].map(() => "exact")

const repeatedSignals = (signal: string, count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, () => signal)

const boundaryAuthoredSuffixSignals = (
  bodyTokens: ReadonlyArray<string>,
  suffixTokens: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const signals: string[] = []
  const maximumPartialLength = Math.min(
    bodyTokens.length,
    suffixTokens.length,
    maximumSuffixComparisonTokens,
  )
  for (let length = minimumSuffixFragmentTokenCount; length <= maximumPartialLength; length += 1) {
    const suffixHead = suffixTokens.slice(0, length)
    const suffixTail = suffixTokens.slice(suffixTokens.length - length)
    if (isSubstantiveSuffixFragment(suffixHead)) {
      signals.push(
        ...repeatedSignals(
          `head:${JSON.stringify(suffixHead)}`,
          tokenSequenceOccurrenceCount(bodyTokens, suffixHead),
        ),
      )
    }
    if (isSubstantiveSuffixFragment(suffixTail)) {
      signals.push(
        ...repeatedSignals(
          `tail:${JSON.stringify(suffixTail)}`,
          tokenSequenceOccurrenceCount(bodyTokens, suffixTail),
        ),
      )
    }
  }
  return signals
}

const tokenWindowKey = (
  tokens: ReadonlyArray<string>,
  start: number,
  length: number,
): string => JSON.stringify(tokens.slice(start, start + length))

const isSubstantiveMiddleSuffixFragment = (tokens: ReadonlyArray<string>): boolean =>
  tokens.length >= minimumMiddleSuffixFragmentTokenCount &&
  tokens.join("").replace(/[^\p{L}\p{N}]/gu, "").length >=
    minimumMiddleSuffixFragmentCharacterCount

const slidingAuthoredSuffixSignals = (
  bodyTokens: ReadonlyArray<string>,
  suffixTokens: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const maximumWindowLength = Math.min(
    bodyTokens.length,
    suffixTokens.length,
    maximumSuffixSlidingWindowTokens,
  )
  const suffixSignalsByLength = new Map<number, Set<string>>()
  for (
    let length = minimumMiddleSuffixFragmentTokenCount;
    length <= maximumWindowLength;
    length += 1
  ) {
    const signals = new Set<string>()
    for (let start = 0; start <= suffixTokens.length - length; start += 1) {
      const fragment = suffixTokens.slice(start, start + length)
      if (isSubstantiveMiddleSuffixFragment(fragment)) {
        signals.add(tokenWindowKey(suffixTokens, start, length))
      }
    }
    if (signals.size > 0) suffixSignalsByLength.set(length, signals)
  }

  const matches: string[] = []
  for (const [length, suffixSignals] of suffixSignalsByLength) {
    for (let start = 0; start <= bodyTokens.length - length; start += 1) {
      const signal = tokenWindowKey(bodyTokens, start, length)
      if (suffixSignals.has(signal)) matches.push(`window:${signal}`)
    }
  }
  return matches
}

const nearAuthoredSuffixSignals = (
  bodyTokens: ReadonlyArray<string>,
  suffixTokens: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const signals: string[] = []
  const comparableSuffixTokens = suffixTokens.slice(-maximumSuffixComparisonTokens)
  const maximumDistance = Math.max(1, Math.floor(comparableSuffixTokens.length / 4))
  const minimumTailLength = Math.max(1, comparableSuffixTokens.length - maximumDistance)
  const maximumTailLength = Math.min(
    bodyTokens.length,
    comparableSuffixTokens.length + maximumDistance,
  )
  for (let length = minimumTailLength; length <= maximumTailLength; length += 1) {
    if (
      tokenEditDistance(comparableSuffixTokens, bodyTokens.slice(bodyTokens.length - length)) <=
      maximumDistance
    ) {
      signals.push(`near:${JSON.stringify(bodyTokens.slice(bodyTokens.length - length))}`)
    }
  }
  return signals
}

const authoredSuffixSignals = (body: string, authoredSuffix: string): ReadonlyArray<string> => {
  const bodyTokens = normalizedFrameTokens(body)
  const suffixTokens = normalizedFrameTokens(authoredSuffix)
  if (bodyTokens.length === 0 || suffixTokens.length === 0) return []
  return [
    ...exactAuthoredSuffixSignals(body, authoredSuffix),
    ...boundaryAuthoredSuffixSignals(bodyTokens, suffixTokens),
    ...slidingAuthoredSuffixSignals(bodyTokens, suffixTokens),
    ...nearAuthoredSuffixSignals(bodyTokens, suffixTokens),
  ]
}

const introducesAuthoredSuffixSignal = (
  authorizedBody: string,
  proposedBody: string,
  authoredSuffix: string,
): boolean => {
  const authorizedSignalCounts = new Map<string, number>()
  for (const signal of authoredSuffixSignals(authorizedBody, authoredSuffix)) {
    authorizedSignalCounts.set(signal, (authorizedSignalCounts.get(signal) ?? 0) + 1)
  }
  for (const signal of authoredSuffixSignals(proposedBody, authoredSuffix)) {
    const remaining = authorizedSignalCounts.get(signal) ?? 0
    if (remaining === 0) return true
    authorizedSignalCounts.set(signal, remaining - 1)
  }
  return false
}

const normalizeOptionalAuthoredSuffix = (
  workflow: ProfileGuideWorkflow,
  stage: GuideWorkflowModelStage,
  authoredSuffix: string,
  authorizedBody: string,
  proposedBody: string,
): string => {
  if (authoredSuffix.length === 0) return proposedBody
  const strippedBody = stripExactOptionalAuthoredSuffix(authoredSuffix, proposedBody)
  if (strippedBody !== proposedBody) return strippedBody
  if (
    unicodeLetterOrDigit.test(authoredSuffix) &&
    introducesAuthoredSuffixSignal(authorizedBody, proposedBody, authoredSuffix)
  ) {
    throw new GuideWorkflowBodyError(
      stage,
      workflow.id,
      "returned a partial, materially altered, or suffix-shaped authored frame that could not be normalized",
    )
  }
  return proposedBody
}

const normalizeModelBodyRemainder = (
  workflow: ProfileGuideWorkflow,
  stage: GuideWorkflowModelStage,
  frame: GuideOptimizeFixedFrame,
  invocation: SelectedWorkflowInvocation | undefined,
  authorizedBody: string,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => {
  const prosePrefixes = workflowProsePrefixes(frame, invocation)
  const bodyWithoutNewPrefixes = stripNewLeadingProsePrefixes(
    prosePrefixes,
    authorizedBody,
    candidate.prompt,
  )
  const normalizedPrompt = normalizeOptionalAuthoredSuffix(
    workflow,
    stage,
    frame.afterBody,
    authorizedBody,
    bodyWithoutNewPrefixes,
  )
  if (
    introducesProsePrefixSignal(prosePrefixes, authorizedBody, normalizedPrompt) ||
    introducesStaticFrameSignal(frame.afterBody, "suffix", authorizedBody, normalizedPrompt)
  ) {
    throw new GuideWorkflowBodyError(
      stage,
      workflow.id,
      "returned a materially altered authored prose frame that could not be normalized",
    )
  }
  return normalizedPrompt === candidate.prompt ? candidate : { ...candidate, prompt: normalizedPrompt }
}

const normalizeSelectedInvocationEcho = (
  workflow: ProfileGuideWorkflow,
  stage: GuideWorkflowModelStage,
  invocation: SelectedWorkflowInvocation,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate | undefined => {
  const selectedPrefixBody = bodyAfterFlexibleInvocationPrefix(candidate.prompt, invocation.fixedPrefix)
  if (selectedPrefixBody !== undefined) {
    return { ...candidate, prompt: selectedPrefixBody }
  }

  const leadingInvocation = startsWithCommandToken(candidate.prompt, invocation.token)
  if (leadingInvocation !== null) {
    const proposedBody = candidate.prompt.slice(leadingInvocation[0].length).trimStart()
    if (
      fixedTextTokens(invocation.fixedTextAfterInvocation).length > 0 &&
      startsWithFixedTextEcho(invocation.fixedTextAfterInvocation, proposedBody)
    ) {
      throw new GuideWorkflowBodyError(
        stage,
        workflow.id,
        "partially or incorrectly echoed the selected workflow's fixed arguments",
      )
    }
    return { ...candidate, prompt: proposedBody }
  }

  return undefined
}

const modelWorkflowBodyCandidate = (
  workflow: ProfileGuideWorkflow,
  stage: GuideWorkflowModelStage,
  authorizedBody: string,
  candidate: GuideGenerateCandidate,
): GuideGenerateCandidate => {
  if (workflow.skill === undefined) return candidate
  const frame = workflowPromptFrame(workflow)
  const invocation = selectedWorkflowInvocation(workflow)
  const normalizeRemainder = (bodyCandidate: GuideGenerateCandidate): GuideGenerateCandidate =>
    normalizeModelBodyRemainder(
      workflow,
      stage,
      frame,
      invocation,
      authorizedBody,
      bodyCandidate,
    )
  const bodyCandidate = workflowBodyCandidate(workflow, candidate)
  if (bodyCandidate !== candidate) return normalizeRemainder(bodyCandidate)

  const fullFrameBody = flexibleFramedBody(frame, candidate.prompt)
  if (fullFrameBody !== undefined) return normalizeRemainder({ ...candidate, prompt: fullFrameBody })

  if (invocation !== undefined) {
    const normalizedInvocation = normalizeSelectedInvocationEcho(
      workflow,
      stage,
      invocation,
      candidate,
    )
    if (normalizedInvocation !== undefined) return normalizeRemainder(normalizedInvocation)
  }

  const unsupportedAlias = unsupportedWorkflowAliases(workflow, invocation).find(
    (alias) => startsWithCommandToken(candidate.prompt, alias) !== null,
  )
  if (unsupportedAlias !== undefined) {
    throw new GuideWorkflowBodyError(
      stage,
      workflow.id,
      `returned unsupported workflow alias "${unsupportedAlias}" instead of the authored selected invocation`,
    )
  }

  return normalizeRemainder(candidate)
}

interface CommandOccurrence {
  readonly index: number
  readonly token: string
}

interface MarkdownFence {
  readonly character: "`" | "~"
  readonly length: number
}

interface MarkdownFenceBoundary extends MarkdownFence {
  readonly trailingText: string
}

const inlineCodeSpan = /(`+).*?\1/gu
const fencedCodeBoundary = /^ {0,3}(`{3,}|~{3,})(.*)$/u
const indentedCodeLine = /^(?: {4}|\t)/u
const quotedMarkdownLine = /^\s*>/u
const slashCommandOccurrence =
  /^([^\S\r\n]*)\/([A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*)(?![A-Za-z0-9_$-]|[.:][A-Za-z0-9]|[/?])/gmu
const dollarCommandOccurrence =
  /(^|[^A-Za-z0-9_:#/$'"`])\$([A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*)(?![A-Za-z0-9_$-]|[.:][A-Za-z0-9]|[/?])/gu
const pathFileExtensions = new Set([
  "c",
  "cc",
  "conf",
  "cpp",
  "css",
  "csv",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsonc",
  "jsx",
  "lock",
  "log",
  "md",
  "mjs",
  "png",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
])

const blankText = (text: string): string => " ".repeat(text.length)

const markdownFenceBoundary = (line: string): MarkdownFenceBoundary | undefined => {
  const boundary = fencedCodeBoundary.exec(line)
  const delimiter = boundary?.[1]
  if (delimiter === undefined) return undefined
  const character = delimiter.startsWith("`") ? "`" : "~"
  const trailingText = boundary?.[2] ?? ""
  if (character === "`" && trailingText.includes("`")) return undefined
  return {
    character,
    length: delimiter.length,
    trailingText,
  }
}

const closesMarkdownFence = (
  openFence: MarkdownFence,
  boundary: MarkdownFenceBoundary,
): boolean =>
  boundary.character === openFence.character &&
  boundary.length >= openFence.length &&
  boundary.trailingText.trim().length === 0

const maskMarkdownCode = (body: string): string => {
  let openFence: MarkdownFence | undefined
  return body
    .split("\n")
    .map((line) => {
      const boundary = markdownFenceBoundary(line)
      if (openFence !== undefined) {
        if (boundary !== undefined && closesMarkdownFence(openFence, boundary)) openFence = undefined
        return blankText(line)
      }
      if (boundary !== undefined) {
        openFence = boundary
        return blankText(line)
      }
      if (indentedCodeLine.test(line) || quotedMarkdownLine.test(line)) {
        return blankText(line)
      }
      return line.replace(inlineCodeSpan, blankText)
    })
    .join("\n")
}

const dottedSlashTokenLooksLikePath = (name: string): boolean => {
  const extensionIndex = name.lastIndexOf(".")
  if (extensionIndex < 1) return false
  const extension = name.slice(extensionIndex + 1).toLocaleLowerCase("en-US")
  return pathFileExtensions.has(extension)
}

const sameLineRemainder = (body: string, match: RegExpMatchArray): string => {
  const tokenEnd = (match.index ?? 0) + match[0].length
  const nextLineIndex = body.indexOf("\n", tokenEnd)
  return body.slice(tokenEnd, nextLineIndex < 0 ? body.length : nextLineIndex).trim()
}

const bareSlashTokenLooksLikePath = (
  body: string,
  match: RegExpMatchArray,
  name: string,
): boolean =>
  /^[A-Za-z][A-Za-z0-9]*$/u.test(name) &&
  sameLineRemainder(body, match).length === 0

const slashCommandOccurrences = (
  body: string,
  knownTokens: ReadonlySet<string>,
): ReadonlyArray<CommandOccurrence> => {
  const occurrences: CommandOccurrence[] = []
  for (const match of body.matchAll(slashCommandOccurrence)) {
    const prefix = match[1] ?? ""
    const name = match[2]
    if (name === undefined) continue
    const token = `/${name.toLocaleLowerCase("en-US")}`
    const looksLikePath =
      !knownTokens.has(token) &&
      (dottedSlashTokenLooksLikePath(name) ||
        bareSlashTokenLooksLikePath(body, match, name))
    if (looksLikePath) continue
    occurrences.push({
      index: (match.index ?? 0) + prefix.length,
      token,
    })
  }
  return occurrences
}

const dollarCommandOccurrences = (
  body: string,
  knownTokens: ReadonlySet<string>,
): ReadonlyArray<CommandOccurrence> => {
  const occurrences: CommandOccurrence[] = []
  for (const match of body.matchAll(dollarCommandOccurrence)) {
    const prefix = match[1] ?? ""
    const name = match[2]
    if (name === undefined) continue
    const token = `$${name.toLocaleLowerCase("en-US")}`
    if (!knownTokens.has(token) && !/[.:-]/u.test(name)) continue
    occurrences.push({
      index: (match.index ?? 0) + prefix.length,
      token,
    })
  }
  return occurrences
}

const commandOccurrences = (
  guide: ProfileGuideV1,
  body: string,
): ReadonlyArray<CommandOccurrence> => {
  const maskedBody = maskMarkdownCode(body)
  const knownCommandTokens = guideWorkflowCommandTokens(guide).map((token) =>
    token.toLocaleLowerCase("en-US"),
  )
  const knownSlashTokens = new Set(knownCommandTokens.filter((token) => token.startsWith("/")))
  const knownDollarTokens = new Set(knownCommandTokens.filter((token) => token.startsWith("$")))
  return [
    ...slashCommandOccurrences(maskedBody, knownSlashTokens),
    ...dollarCommandOccurrences(maskedBody, knownDollarTokens),
  ].sort((left, right) => left.index - right.index)
}

const hasSameCommandSequence = (guide: ProfileGuideV1, authorizedBody: string, proposedBody: string): boolean => {
  const authorized = commandOccurrences(guide, authorizedBody)
  const proposed = commandOccurrences(guide, proposedBody)
  return (
    authorized.length === proposed.length &&
    authorized.every((occurrence, index) => occurrence.token === proposed[index]?.token)
  )
}

/** Normalizes untrusted optimizer output and retains the coherent authorized fallback. */
export const resolveWorkflowBodyCandidate = (
  guide: ProfileGuideV1,
  workflow: ProfileGuideWorkflow,
  authorizedCandidate: GuideGenerateCandidate,
  proposedCandidate: GuideGenerateCandidate,
): GuideGenerateCandidate => {
  const authorizedPromptCandidate =
    workflow.skill === undefined ? authorizedCandidate : workflowBodyCandidate(workflow, authorizedCandidate)
  try {
    return resolveModelWorkflowBodyCandidate(
      guide,
      workflow,
      "optimization",
      authorizedPromptCandidate.prompt,
      proposedCandidate,
    )
  } catch (cause) {
    if (cause instanceof GuideWorkflowBodyError) return authorizedPromptCandidate
    throw cause
  }
}

function resolveModelWorkflowBodyCandidate(
  guide: ProfileGuideV1,
  workflow: ProfileGuideWorkflow,
  stage: GuideWorkflowModelStage,
  authorizedPrompt: string,
  proposedCandidate: GuideGenerateCandidate,
): GuideGenerateCandidate {
  const bodyOnly = workflow.skill !== undefined
  const authorizedComparisonPrompt = bodyOnly
    ? workflowBodyText(workflow, authorizedPrompt)
    : authorizedPrompt
  const proposedPromptCandidate = bodyOnly
    ? modelWorkflowBodyCandidate(workflow, stage, authorizedComparisonPrompt, proposedCandidate)
    : proposedCandidate
  if (bodyOnly && proposedPromptCandidate.prompt.trim().length === 0) {
    throw new GuideWorkflowBodyError(stage, workflow.id, "returned no body text after frame normalization")
  }
  if (!hasSameCommandSequence(guide, authorizedComparisonPrompt, proposedPromptCandidate.prompt)) {
    throw new GuideWorkflowBodyError(
      stage,
      workflow.id,
      "changed executable workflow commands during prompt normalization",
    )
  }
  return proposedPromptCandidate
}

const workflowAuthorizationPrompt = (workflow: ProfileGuideWorkflow, intent: string): string => {
  const frame = workflowPromptFrame(workflow)
  return `${frame.beforeBody}${intent}${frame.afterBody}`
}

/** Normalizes and validates one model-generated body or complete prompt without intent fallback. */
export const resolveGeneratedWorkflowBodyCandidate = (
  guide: ProfileGuideV1,
  workflow: ProfileGuideWorkflow,
  intent: string,
  generatedCandidate: GuideGenerateCandidate,
): GuideGenerateCandidate =>
  resolveModelWorkflowBodyCandidate(
    guide,
    workflow,
    "generation",
    workflow.skill === undefined
      ? workflowAuthorizationPrompt(workflow, intent)
      : workflowAuthorizationBody(workflow, intent),
    generatedCandidate,
  )

/** Normalizes and validates one model-refined body or complete prompt before optimization. */
export const resolveRefinedWorkflowBodyCandidate = (
  guide: ProfileGuideV1,
  workflow: ProfileGuideWorkflow,
  authorizedCandidate: GuideGenerateCandidate,
  refinedCandidate: GuideGenerateCandidate,
): GuideGenerateCandidate =>
  resolveModelWorkflowBodyCandidate(
    guide,
    workflow,
    "refinement",
    workflowBodyCandidate(workflow, authorizedCandidate).prompt,
    refinedCandidate,
  )

/** Supplies Prompt Master with the fixed destination frame for skill bodies only. */
export const workflowOptimizeFixedFrame = (workflow: ProfileGuideWorkflow): GuideOptimizeFixedFrame | undefined =>
  workflow.skill === undefined ? undefined : workflowPromptFrame(workflow)
