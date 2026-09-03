import type { ConversationMessage } from "./transcript-format.ts"

const defaultMaximumCharacters = 60_000

export interface ConversationSource {
  readonly agent: string
  readonly cwd: string
  readonly sessionId: string
  readonly profile?: string
}

export interface FormattedConversation {
  readonly text: string
  readonly messageCount: number
  readonly omittedMessageCount: number
}

const messageSection = (message: ConversationMessage): string =>
  `### ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text.trim()}`

const header = (source: ConversationSource): string =>
  [
    "# Continue this Herdr conversation",
    "",
    `Repository: ${source.cwd}`,
    `Harness: ${source.agent}`,
    ...(source.profile === undefined ? [] : [`Profile: ${source.profile}`]),
    `Session: ${source.sessionId}`,
    "",
    "The transcript contains human messages and completed assistant responses only.",
    "",
    "## Conversation",
  ].join("\n")

const footer = [
  "",
  "## Guide request",
  "",
  "Recommend the best Trellage profile and workflow for continuing this work from its current state.",
].join("\n")

export const formatConversationIntent = (
  source: ConversationSource,
  messages: ReadonlyArray<ConversationMessage>,
  maximumCharacters = defaultMaximumCharacters,
): FormattedConversation => {
  if (messages.length === 0) throw new Error("The exact transcript does not contain conversation messages")
  const selected: Array<string> = []
  let firstIncluded = messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const section = messageSection(messages[index])
    const candidate = [section, ...selected]
    const omission = index === 0
      ? ""
      : `_Older history omitted: ${index} message${index === 1 ? "" : "s"}._\n\n`
    const text = `${header(source)}\n\n${omission}${candidate.join("\n\n")}\n${footer}`
    if ([...text].length > maximumCharacters) break
    selected.unshift(section)
    firstIncluded = index
  }
  if (selected.length === 0) {
    throw new Error(`The latest conversation message exceeds trx guide's ${maximumCharacters}-character limit`)
  }
  const omittedMessageCount = firstIncluded
  const omission = omittedMessageCount === 0
    ? ""
    : `_Older history omitted: ${omittedMessageCount} message${omittedMessageCount === 1 ? "" : "s"}._\n\n`
  const text = `${header(source)}\n\n${omission}${selected.join("\n\n")}\n${footer}`
  if ([...text].length > maximumCharacters) {
    throw new Error(`The conversation excerpt exceeds trx guide's ${maximumCharacters}-character limit`)
  }
  return { text, messageCount: selected.length, omittedMessageCount }
}
