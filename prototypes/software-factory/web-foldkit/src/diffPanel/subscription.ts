import { Array, Option, Schema, Stream } from "effect";
import { AsyncData } from "foldkit";
import { type FeedEvent, RESYNC } from "../../../shared/feed";
import type { Worker } from "../domain";
import { feedEvents } from "../feed";
import { Message } from "./message";
import type { Model } from "./model";

/** Feed events after which files may differ: a finished tool call, a cleaned worktree, a feed gap. */
export const changesFiles = ({ type }: FeedEvent): boolean =>
  type === "tool.execution_complete" || type === "factory.worktree_cleaned" || type === RESYNC;

/** True when the event can change the shown worktree: a tool call of an agent working there, or a cleanup or gap. */
export const changesWorktree =
  (agentIds: ReadonlyArray<string>) =>
  (event: FeedEvent): boolean =>
    changesFiles(event) && (event.type !== "tool.execution_complete" || agentIds.includes(event.workerId));

/** A busy worker finishes several tools per second; reload once the burst settles. */
const RELOAD_DEBOUNCE = "1 second";

export const ReloadDependencies = { isOpen: Schema.Boolean, agentIds: Schema.Array(Schema.String) };

/** Ids of the agents whose working directory is the worktree the panel shows. */
export const reloadDependencies = (model: Model, workers: ReadonlyArray<Worker>): { isOpen: boolean; agentIds: ReadonlyArray<string> } => ({
  isOpen: model.dialog.isOpen,
  agentIds: Option.match(AsyncData.getData(model.diff), {
    onNone: () => [],
    onSome: ({ worktree }) => Array.map(Array.filter(workers, ({ workdir }) => workdir === worktree), ({ id }) => id),
  }),
});

/** While the panel is open, file changes in its worktree reload it. Closed, it listens to nothing. */
export const reloadStream = ({ isOpen, agentIds }: { isOpen: boolean; agentIds: ReadonlyArray<string> }): Stream.Stream<Message> =>
  isOpen ? feedEvents.pipe(Stream.filter(changesWorktree(agentIds)), Stream.debounce(RELOAD_DEBOUNCE), Stream.map(() => Message.ReceivedFileChange())) : Stream.empty;
