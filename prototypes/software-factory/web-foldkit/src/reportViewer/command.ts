import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { Report, StartedConversation } from "../../../shared/schemas";
import { getJson, postJson } from "../api";
import { Message } from "./message";

const reportUrl = (ref: string, agent: string | null, thread: string | null) =>
  `/api/reports?${new URLSearchParams({ path: ref, ...(agent ? { agent } : {}), ...(thread ? { thread } : {}) })}`;

export const FetchReport = Command.define("FetchReport", {
  args: { ref: Schema.String, agent: Schema.NullOr(Schema.String) },
  messages: [Message.SucceededFetchReport, Message.FailedFetchReport],
  execute: ({ ref, agent }) =>
    getJson(reportUrl(ref, agent, null), Report).pipe(
      Effect.map((report) => Message.SucceededFetchReport({ ref, report })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchReport({ ref, error }))),
    ),
});

/** The brief next to a report, in the report's own conversation. Most reports have none. */
export const FetchBrief = Command.define("FetchBrief", {
  args: { ref: Schema.String, briefRef: Schema.String, threadId: Schema.String },
  messages: [Message.SucceededFetchBrief, Message.FailedFetchBrief],
  execute: ({ ref, briefRef, threadId }) =>
    getJson(reportUrl(briefRef, null, threadId), Report).pipe(
      Effect.map(({ content }) => Message.SucceededFetchBrief({ ref, content })),
      Effect.catch(() => Effect.succeed(Message.FailedFetchBrief({ ref }))),
    ),
});

/** Start a finding as a new conversation in the report's repo. */
export const StartFinding = Command.define("StartFinding", {
  args: { rank: Schema.Number, path: Schema.String, thread: Schema.String, title: Schema.String, body: Schema.String },
  messages: [Message.SucceededStart, Message.FailedStart],
  execute: ({ rank, path, thread, title, body }) =>
    postJson("/api/reports/start", { path, thread, title, body }, StartedConversation).pipe(
      Effect.map(({ threadId, branch }) => Message.SucceededStart({ rank, threadId, branch })),
      Effect.catch((error) => Effect.succeed(Message.FailedStart({ rank, error }))),
    ),
});

/** Open text as a new tab, or download it when `download` names a file. */
export const OpenBlob = Command.define("OpenBlob", {
  args: { text: Schema.String, type: Schema.String, download: Schema.NullOr(Schema.String) },
  messages: [Message.CompletedOpenBlob],
  execute: ({ text, type, download }) =>
    Effect.sync(() => {
      const url = URL.createObjectURL(new Blob([text], { type }));
      if (download) Object.assign(document.createElement("a"), { href: url, download }).click();
      else window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return Message.CompletedOpenBlob();
    }),
});

/** Open the started conversation: the host listens for window event "sf:open-thread". */
export const OpenThread = Command.define("OpenThread", {
  args: { threadId: Schema.String },
  messages: [Message.CompletedOpenThread],
  execute: ({ threadId }) =>
    Effect.sync(() => {
      window.dispatchEvent(new CustomEvent("sf:open-thread", { detail: threadId }));
      return Message.CompletedOpenThread();
    }),
});
