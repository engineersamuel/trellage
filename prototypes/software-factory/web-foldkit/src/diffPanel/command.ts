import { Effect, Schema } from "effect";
import { Command, Mount } from "foldkit";
import { parseUnified } from "../../../shared/diff";
import { renderDiffs } from "../../../shared/diffview";
import { getJson } from "../api";
import { WorktreeDiff } from "./domain";
import { Message } from "./message";

export const FetchDiff = Command.define("FetchDiff", {
  args: { threadId: Schema.String },
  messages: [Message.SucceededFetchDiff, Message.FailedFetchDiff],
  execute: ({ threadId }) =>
    getJson(`/api/threads/${encodeURIComponent(threadId)}/diff`, WorktreeDiff).pipe(
      Effect.map((diff) => Message.SucceededFetchDiff({ threadId, diff })),
      Effect.catch((error) => Effect.succeed(Message.FailedFetchDiff({ threadId, error }))),
    ),
});

/** shared/diffview.ts draws the patch, every line, in the chosen diff style. */
export const MountNativeDiff = Mount.define("MountNativeDiff", {
  args: { patch: Schema.String },
  messages: [Message.CompletedMountNativeDiff],
  execute: ({ element, patch }) =>
    Effect.sync(() => {
      if (element instanceof HTMLElement) renderDiffs(element, parseUnified(patch), { cap: Infinity });
      return Message.CompletedMountNativeDiff();
    }),
});
