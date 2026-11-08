import { Schema, Stream } from "effect";
import { Subscription } from "foldkit";
import { type FeedEvent, RESYNC } from "../../../shared/feed";
import { feedEvents } from "../feed";
import { Message } from "./message";
import type { Model } from "./model";

/** Feed events after which files in a worktree may differ: a finished tool call (edit, write, shell), a cleaned worktree, a feed gap. */
export const changesFiles = ({ type }: FeedEvent): boolean =>
  type === "tool.execution_complete" || type === "factory.worktree_cleaned" || type === RESYNC;

/** A busy worker finishes several tools per second; reload once the burst settles. */
const RELOAD_DEBOUNCE = "1 second";

/** While the panel is open, file changes reload it. Closed, it listens to nothing. */
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  diffPanelReload: entry(
    { isOpen: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isOpen: model.dialog.isOpen }),
      dependenciesToStream: ({ isOpen }) =>
        isOpen ? feedEvents.pipe(Stream.filter(changesFiles), Stream.debounce(RELOAD_DEBOUNCE), Stream.map(() => Message.ReceivedFileChange())) : Stream.empty,
    },
  ),
}));
