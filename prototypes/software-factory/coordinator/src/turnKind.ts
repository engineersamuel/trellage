// Kinds of turns that code starts in the Chief of Staff conversation (ADR 0008 events). The human's chat hides them
// unless the human shows them (GET /api/threads/get/<id>?view=human&show=...).

export const EVENT_KINDS = ["reports", "rules", "checks", "answers"] as const
export type EventKind = (typeof EVENT_KINDS)[number]

const EVENT_TEXT: [EventKind, RegExp][] = [
  ["reports", /^\[report from /],
  ["rules", /^\[Chief of Staff · /],
  ["checks", /^\[(supervisor\]|cron: )/],
  ["answers", /^\[((question|approval|decision) \S+ answered|goal \S+ |conversation \S+ deleted)/],
]

/** The event kind of a message text, or null for the human's own text. */
export const eventKind = (c: unknown): EventKind | null =>
  typeof c === "string" ? (EVENT_TEXT.find(([, re]) => re.test(c))?.[0] ?? null) : null
