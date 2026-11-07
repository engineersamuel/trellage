import { Effect, Schema } from "effect";
import { Command } from "foldkit";
import { getJson, postJson } from "../api";
import { FoldersPayload, GoalList, LoopPrompt, SavedGoal, StepsPayload } from "./domain";
import { Message } from "./message";
import { GoalSpec } from "../../../shared/goal";

export const FetchGoals = Command.define("FetchGoals", {
  messages: [Message.SucceededFetchGoals, Message.FailedFetchGoals],
  execute: getJson("/api/goals", GoalList).pipe(
    Effect.map((goals) => Message.SucceededFetchGoals({ goals })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchGoals({ error }))),
  ),
});

/** The steps and skills the factory has, and its repo folders: the form offers only these. */
export const FetchCatalog = Command.define("FetchCatalog", {
  messages: [Message.SucceededFetchCatalog, Message.FailedFetchCatalog],
  execute: Effect.all([getJson("/api/steps", StepsPayload), getJson("/api/folders", FoldersPayload)]).pipe(
    Effect.map(([{ steps }, folders]) => Message.SucceededFetchCatalog({ catalog: { steps, folders: folders.filter((f) => f.path !== "") } })),
    Effect.catch((error) => Effect.succeed(Message.FailedFetchCatalog({ error }))),
  ),
});

/** Save the spec, then fetch the paste-ready loop prompt for it. */
export const SaveGoal = Command.define("SaveGoal", {
  args: { spec: GoalSpec },
  messages: [Message.SucceededSaveGoal, Message.FailedSaveGoal],
  execute: ({ spec }) =>
    postJson("/api/goals", spec, SavedGoal).pipe(
      Effect.flatMap(({ id }) => getJson(`/api/goals/${encodeURIComponent(id)}/prompt`, LoopPrompt)),
      Effect.map((saved) => Message.SucceededSaveGoal({ saved })),
      Effect.catch((error) => Effect.succeed(Message.FailedSaveGoal({ error }))),
    ),
});

export const CopyText = Command.define("CopyText", {
  args: { text: Schema.String },
  messages: [Message.CompletedCopy],
  execute: ({ text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedCopy()),
    ),
});
