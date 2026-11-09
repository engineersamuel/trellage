// Payload of GET /api/threads/<id>/diff (coordinator/src/worktreeDiff.ts).
import { Array, Effect, Order, Schema, pipe } from "effect";
import { AsyncData } from "foldkit";

export const ChangedFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["M", "A", "D", "?"]),
  added: Schema.Number,
  removed: Schema.Number,
  binary: Schema.Boolean,
  patch: Schema.String,
  tooLarge: Schema.Boolean,
  /** Changed by the branch's commits: in its PR once pushed. */
  committed: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Uncommitted changes on disk (staged, unstaged or untracked): in no PR. */
  local: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type ChangedFile = typeof ChangedFile.Type;

/** Files grouped by folder, folders in path order: the list order, and the order j/k moves in. */
export const fileGroups = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<readonly [string, ReadonlyArray<ChangedFile>]> =>
  pipe(
    Object.entries(Array.groupBy(files, ({ path }) => path.split("/").slice(0, -1).join("/"))),
    Array.sortWith(([folder]) => folder, Order.String),
  );

/** The two lists of the panel: files in the branch (committed), then files only on disk. A committed file with
 * more local edits is listed in the branch, marked as edited. */
export type Section = { readonly id: "branch" | "local"; readonly title: string; readonly files: ReadonlyArray<ChangedFile> };
export const sections = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<Section> => {
  const all: ReadonlyArray<Section> = [
    { id: "branch", title: "In the branch (committed)", files: Array.filter(files, (f) => f.committed) },
    { id: "local", title: "Only on disk (not committed)", files: Array.filter(files, (f) => !f.committed) },
  ];
  return Array.filter(all, (s) => s.files.length > 0);
};

/** Paths in list order: section by section, folder by folder. j/k move in this order. */
export const orderedPaths = (files: ReadonlyArray<ChangedFile>): ReadonlyArray<string> =>
  Array.flatMap(sections(files), (s) => Array.flatMap(fileGroups(s.files), ([, group]) => Array.map(group, ({ path }) => path)));

export const WorktreeDiff = Schema.Struct({
  worktree: Schema.String,
  base: Schema.String,
  files: Schema.Array(ChangedFile),
  /** Commits on HEAD not on its upstream; null when there is no upstream. */
  unpushed: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
export type WorktreeDiff = typeof WorktreeDiff.Type;
export const WorktreeDiffAsyncData = AsyncData.Schema(WorktreeDiff, Schema.String);
