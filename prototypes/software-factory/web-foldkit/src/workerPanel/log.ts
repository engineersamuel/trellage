// The raw-event log of one worker: which events it shows, how each reads, and how batches merge.
import { Array, Match, Order, pipe } from "effect";
import type { StoredEvent } from "../../../shared/schemas";
import type { LogLine } from "./model";

type FeedEvent = typeof StoredEvent.Type;

export const MAX_LOG_LINES = 500;
const MAX_DETAIL_LENGTH = 160;
const AGENT_ID_LENGTH = 8;
const SHOWN_EVENT_TYPES = /^(user\.message|assistant\.message$|tool\.execution_(start|complete)|subagent\.|session\.(error|idle))/;

const describeFeedEvent = (event: FeedEvent): string => {
  const data = event.data ?? {};
  return Match.value(event.type).pipe(
    Match.when(Match.is("assistant.message", "user.message"), () => globalThis.String(data.content ?? "")),
    Match.when("tool.execution_start", () => `${data.toolName} ${JSON.stringify(data.arguments ?? {}).slice(0, MAX_DETAIL_LENGTH)}`),
    Match.when(
      "tool.execution_complete",
      () => `${data.success ? "ok" : "failed"} ${globalThis.String(data.result?.content ?? data.error?.message ?? "").slice(0, MAX_DETAIL_LENGTH)}`,
    ),
    Match.when("session.error", () => globalThis.String(data.message ?? "")),
    Match.orElse(() => ""),
  );
};

export const isShownEvent = (event: FeedEvent): boolean =>
  SHOWN_EVENT_TYPES.test(event.type) && !(event.type === "assistant.message" && !event.data?.content);

export const toLogLine = (event: FeedEvent): LogLine => ({
  seq: event.seq,
  type: event.agentId ? `${event.type} [${event.agentId.slice(0, AGENT_ID_LENGTH)}]` : event.type,
  text: describeFeedEvent(event),
});

const bySeq = Order.mapInput(Order.Number, (line: LogLine) => line.seq);

/** Merge lines into the log: one line per seq, ordered, newest MAX_LOG_LINES kept. */
export const mergeLines = (logLines: ReadonlyArray<LogLine>, lines: ReadonlyArray<LogLine>): ReadonlyArray<LogLine> => {
  const known = new Set(Array.map(logLines, ({ seq }) => seq));
  // The Set also drops a seq repeated inside one batch.
  const added = Array.filter(lines, ({ seq }) => !known.has(seq) && Boolean(known.add(seq)));
  return Array.isReadonlyArrayEmpty(added)
    ? logLines
    : pipe(Array.appendAll(logLines, added), Array.sort(bySeq), Array.takeRight(MAX_LOG_LINES));
};

/** A backlog holds thousands of events. Only the newest shown ones can survive the cap, so the Command
 *  turns just those into lines and the Message stays small. */
export const toBacklogLines = (events: ReadonlyArray<FeedEvent>): ReadonlyArray<LogLine> =>
  pipe(events, Array.filter(isShownEvent), Array.takeRight(MAX_LOG_LINES), Array.map(toLogLine));

/** One live event as log lines (none when the event is not shown). */
export const toEventLines = (event: FeedEvent): ReadonlyArray<LogLine> => (isShownEvent(event) ? [toLogLine(event)] : []);
