// Payload of GET /api/threads/<id>/diff (coordinator/src/worktreeDiff.ts).
import { Array, Order, Schema, pipe } from "effect";
import { AsyncData } from "foldkit";

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["M", "A", "D", "?"]),
  added: Schema.Number,
  removed: Schema.Number,
  binary: Schema.Boolean,
  patch: Schema.String,
  tooLarge: Schema.Boolean,
});
export type ChangedFile = typeof ChangedFile.Type;

/** Files grouped by folder, folders in path order: the list order, and the order j/k moves in. */
export const fileGroups = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<readonly [string, ReadonlyArray<ChangedFile>]> =>
  pipe(
    Object.entries(Array.groupBy(files, ({ path }) => path.split("/").slice(0, -1).join("/"))),
    Array.sortWith(([folder]) => folder, Order.String),
  );

export const WorktreeDiff = Schema.Struct({ worktree: Schema.String, base: Schema.String, files: Schema.Array(ChangedFile) });
export type WorktreeDiff = typeof WorktreeDiff.Type;
export const WorktreeDiffAsyncData = AsyncData.Schema(WorktreeDiff, Schema.String);
