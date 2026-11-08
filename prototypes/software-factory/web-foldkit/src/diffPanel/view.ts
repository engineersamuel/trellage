import { Array, Equal, Option } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Button, Dialog } from "@foldkit/ui";
import { MountNativeDiff } from "./command";
import { totals as lineTotals } from "./update";
import { type ChangedFile, type WorktreeDiff, fileGroups } from "./domain";
import { Message } from "./message";
import type { Model } from "./model";

const STATUS_TITLE: Record<ChangedFile["status"], string> = { M: "Changed", A: "Added", D: "Deleted", "?": "New, not committed" };

const fileName = (path: string): string => Option.getOrElse(Array.last(path.split("/")), () => path);

const fileRow = (file: ChangedFile, isSelected: boolean, h: HtmlBuilder<Message>): Html =>
  h.keyed("li")(file.path, [], [
    h.button(
      [
        h.Type("button"),
        h.Class(`fk-diff-file${isSelected ? " is-selected" : ""}`),
        h.AriaCurrent(isSelected ? "true" : "false"),
        h.Title(file.path),
        h.OnClick(Message.ClickedFile({ path: file.path })),
      ],
      [
        h.span([h.Class(`fk-diff-status fk-diff-status-${file.status === "?" ? "U" : file.status}`), h.Title(STATUS_TITLE[file.status])], [file.status]),
        h.span([h.Class("fk-diff-name")], [fileName(file.path)]),
        h.span([h.Class("fk-diff-count")], file.binary ? ["bin"] : [h.span([h.Class("dv-plus")], [`+${file.added}`]), " ", h.span([h.Class("dv-minus")], [`-${file.removed}`])]),
      ],
    ),
  ]);

const fileList = (diff: WorktreeDiff, maybeSelectedPath: Option.Option<string>, h: HtmlBuilder<Message>): Html =>
  h.nav([h.Class("fk-diff-files"), h.AriaLabel("Changed files")], [
    ...Array.map(fileGroups(diff.files), ([folder, files]) =>
      h.keyed("section")(`dir-${folder}`, [], [
        h.h4([h.Class("fk-diff-dir"), h.Title(folder || "/")], [folder ? `${folder}/` : "./"]),
        h.ul([], Array.map(files, (file) => fileRow(file, Option.contains(maybeSelectedPath, file.path), h))),
      ]),
    ),
  ]);

/** Short hash of a patch. Mount args are read once, so a changed patch needs a new element key. */
const patchKey = (patch: string): string => {
  let hash = 5381;
  for (let index = 0; index < patch.length; index++) hash = (hash * 33) ^ patch.charCodeAt(index);
  return (hash >>> 0).toString(36);
};

/** The selected file's diff. Keyed by file and patch: a new file or a changed patch is a fresh Mount; an unchanged reload keeps the element and its scroll position. */
const filePane = (model: Model, file: ChangedFile, h: HtmlBuilder<Message>): Html => {
  const note = file.binary ? "Binary file, no text diff." : file.tooLarge ? "Patch larger than 512 KB; not shown." : file.patch === "" ? "No text changes (mode only)." : "";
  return h.section([h.Class("fk-diff-pane"), h.AriaLabel(`Diff of ${file.path}`)], [
    h.header([h.Class("fk-diff-pane-head")], [h.code([], [file.path])]),
    note
      ? h.p([h.Class("fk-muted")], [note])
      : // renderDiffs owns the inner element's class, so the scroll box is its parent.
        h.div([h.Class("fk-diff-body")], [h.keyed("div")(`${file.path}:${patchKey(file.patch)}`, [h.OnMount(MountNativeDiff({ patch: file.patch }))])]),
  ]);
};

const totals = (diff: WorktreeDiff): string => {
  const added = Array.reduce(diff.files, 0, (n, f) => n + f.added);
  const removed = Array.reduce(diff.files, 0, (n, f) => n + f.removed);
  return `${diff.files.length} files · +${added} -${removed} · base ${diff.base.slice(0, 8)}`;
};

const body = (model: Model, diff: WorktreeDiff, h: HtmlBuilder<Message>): Html =>
  Array.match(diff.files, {
    onEmpty: () => h.p([h.Class("fk-muted")], ["No changes against the base commit."]),
    onNonEmpty: (files) =>
      h.div([h.Class("fk-diff-split")], [
        fileList(diff, model.maybeSelectedPath, h),
        Option.match(
          Option.flatMap(model.maybeSelectedPath, (path) => Array.findFirst(files, (file) => Equal.equals(file.path, path))),
          { onNone: () => h.section([h.Class("fk-diff-pane")]), onSome: (file) => filePane(model, file, h) },
        ),
      ]),
  });

const keyToMessage = (key: string): Option.Option<Message> =>
  key === "j" || key === "ArrowDown" ? Option.some(Message.PressedNextFile()) : key === "k" || key === "ArrowUp" ? Option.some(Message.PressedPreviousFile()) : Option.none();

const content = (model: Model, render: Dialog.RenderInfo, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.header([], [
    h.h2([...render.title], ["Worktree changes"]),
    h.span([...render.description, h.Class("fk-muted")], [
      AsyncData.matchData(model.diff, { onEmpty: () => " · loading…", onFailure: () => "", onData: (diff) => ` · ${totals(diff)}` }),
    ]),
    h.button([h.Type("button"), h.OnClick(Message.ClickedRefresh()), h.AriaLabel("Reload changes"), h.Title("Reload the changes")], ["↻"]),
    h.button([...render.closeButton, h.AriaLabel("Close changes")], ["✕"]),
  ]),
  AsyncData.matchData(model.diff, {
    onEmpty: () => h.p([h.Class("fk-muted")], ["Loading changes…"]),
    onFailure: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load changes: ${error}`]),
    onData: (diff) => body(model, diff, h),
  }),
];

/** The changes panel: a modal Dialog with the changed files on the left and the selected file's diff on the right. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.submodel({
    slotId: model.dialog.id,
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      hasDescription: true,
      toView: (render: Dialog.RenderInfo) =>
        h.dialog(
          [...render.dialog, h.Class("fk-dialog")],
          render.isVisible
            ? [
                h.div([...render.backdrop, h.Class("fk-backdrop")]),
                h.div([...render.panel, h.Class("fk-diff-panel"), h.OnKeyDownPreventDefault(keyToMessage)], content(model, render, h)),
              ]
            : [],
        ),
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  }),
);

/** The navbar button that opens the changes panel. */
export const navButton = <ParentMessage>(model: Model, onClick: ParentMessage, h: HtmlBuilder<ParentMessage>): Html =>
  Button.view(
    {
      onClick,
      toView: (attributes) =>
        h.button(
          [...attributes.button, h.AriaLabel("Open worktree changes"), h.Title("Worktree changes: lines added and removed against the base")],
          [
            "± Changes",
            ...Option.match(lineTotals(model), {
              onNone: () => [],
              onSome: ({ added, removed }) => [" ", h.span([h.Class("fk-nav-plus")], [`+${added}`]), " ", h.span([h.Class("fk-nav-minus")], [`−${removed}`])],
            }),
          ],
        ),
    },
    h,
  );
