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

export const ReloadDependencies = { agentIds: Schema.Array(Schema.String) };

/** Ids of the agents whose working directory is the worktree the panel shows. */
export const reloadDependencies = (model: Model, workers: ReadonlyArray<Worker>): { agentIds: ReadonlyArray<string> } => ({
  agentIds: Option.match(AsyncData.getData(model.diff), {
    onNone: () => [],
    onSome: ({ worktree }) => Array.map(Array.filter(workers, ({ workdir }) => workdir === worktree), ({ id }) => id),
  }),
});

/** File changes in the shown worktree reload it, open or closed: the navbar button shows the live counts. */
export const reloadStream = ({ agentIds }: { agentIds: ReadonlyArray<string> }): Stream.Stream<Message> =>
  feedEvents.pipe(Stream.filter(changesWorktree(agentIds)), Stream.debounce(RELOAD_DEBOUNCE), Stream.map(() => Message.ReceivedFileChange()));
