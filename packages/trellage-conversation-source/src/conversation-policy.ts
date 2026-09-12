import { readFileSync } from "node:fs"

export interface ConversationCapturePolicy {
  readonly schemaVersion: 1
  readonly maximumTranscriptBytes: number
  readonly maximumRecordBytes: number
  readonly maximumRecords: number
  readonly maximumMessages: number
  readonly maximumMessageBytes: number
  readonly maximumTextBytes: number
  readonly maximumRequestBytes: number
  readonly readChunkBytes: number
}

export const validateConversationCapturePolicy = (value: unknown): ConversationCapturePolicy => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Conversation capture policy is invalid.")
  }
  const fields = [
    "maximumTranscriptBytes", "maximumRecordBytes", "maximumRecords",
    "maximumMessages", "maximumMessageBytes", "maximumTextBytes", "maximumRequestBytes", "readChunkBytes",
  ]
  const policy = value as Record<string, unknown>
  if (policy.schemaVersion !== 1 ||
    Object.keys(policy).some((key) => key !== "schemaVersion" && !fields.includes(key)) ||
    fields.some((key) => !Number.isSafeInteger(policy[key]) || Number(policy[key]) <= 0)) {
    throw new Error("Conversation capture policy is invalid.")
  }
  const positiveInteger = (key: string): number => {
    const entry = policy[key]
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      throw new Error("Conversation capture policy is invalid.")
    }
    return entry
  }
  const result: ConversationCapturePolicy = {
    schemaVersion: 1,
    maximumTranscriptBytes: positiveInteger("maximumTranscriptBytes"),
    maximumRecordBytes: positiveInteger("maximumRecordBytes"),
    maximumRecords: positiveInteger("maximumRecords"),
    maximumMessages: positiveInteger("maximumMessages"),
    maximumMessageBytes: positiveInteger("maximumMessageBytes"),
    maximumTextBytes: positiveInteger("maximumTextBytes"),
    maximumRequestBytes: positiveInteger("maximumRequestBytes"),
    readChunkBytes: positiveInteger("readChunkBytes"),
  }
  if (result.maximumTranscriptBytes > 256 * 1024 * 1024 ||
    result.maximumRecordBytes > result.maximumTranscriptBytes ||
    result.maximumTextBytes > result.maximumTranscriptBytes ||
    result.maximumMessageBytes > result.maximumTextBytes ||
    result.maximumRequestBytes > 256 * 1024 * 1024 ||
    result.maximumMessages > result.maximumRecords ||
    result.maximumRecords > 1_000_000 ||
    result.readChunkBytes > result.maximumRecordBytes) {
    throw new Error("Conversation capture policy bounds are invalid.")
  }
  return Object.freeze({ ...result })
}

export const conversationCapturePolicy = validateConversationCapturePolicy(
  JSON.parse(readFileSync(new URL("./conversation-policy.json", import.meta.url), "utf8")),
)
