import { Option } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Dialog } from "@foldkit/ui";
import { type Finding, type Report, briefLines, fileName, findings, markdownHtml, sections } from "./domain";
import { Message } from "./message";
import type { Model, View } from "./model";

type H = HtmlBuilder<Message>;

const VIEW_LABEL: Record<View, string> = { brief: "Brief", full: "Full", source: "Source" };

const startButton = (model: Model, report: Report, finding: Finding, h: H): Html => {
  const state = model.starts[String(finding.rank)];
  if (state?._tag === "Started") return h.span([h.Class("rv-started")], [`Started in Factory · ${state.branch ?? "new worktree"}`]);
  return h.span([h.Class("rv-start-wrap")], [
    h.button(
      [
        h.Type("button"),
        h.Class("rv-start"),
        h.Disabled(state?._tag === "Starting"),
        h.AriaLabel(`${state?._tag === "Starting" ? "Starting" : "Start in Factory"}: finding ${finding.rank}`),
        h.Title(`New worktree of ${report.folderId}; the coordinator plans, asks you to approve, implements, and verifies`),
        h.OnClick(Message.ClickedStart({ rank: finding.rank })),
      ],
      [state?._tag === "Starting" ? "Starting…" : "▶ Start in Factory"],
    ),
    ...(state?._tag === "FailedStart" ? [h.span([h.Class("rv-error"), h.Role("alert")], [state.error])] : []),
  ]);
};

/** Markdown with each ranked finding as a card that has its own Start button. */
const rendered = (model: Model, report: Report, content: string, h: H): ReadonlyArray<Html> =>
  sections(content).map((section, index) =>
    section.kind === "text"
      ? h.keyed("div")(`text-${index}`, [h.Class("rv-md"), h.InnerHTML(markdownHtml(section.markdown))])
      : h.keyed("section")(`finding-${section.finding.rank}`, [h.Class("rv-finding"), h.AriaLabel(`Finding ${section.finding.rank}`)], [
          h.header([], [
            h.span([h.Class("rv-rank")], [String(section.finding.rank)]),
            h.h2([], [`${section.finding.rank}. ${section.finding.title}`]),
            startButton(model, report, findings(report.content).find((f) => f.rank === section.finding.rank) ?? section.finding, h),
          ]),
          h.div([h.Class("rv-md"), h.InnerHTML(markdownHtml(section.finding.body))]),
        ]),
  );

const tabs = (model: Model, h: H): Html => {
  const views: ReadonlyArray<View> = Option.isSome(model.maybeBrief) ? ["brief", "full", "source"] : ["full", "source"];
  return h.div([h.Class("rv-tabs"), h.Role("tablist"), h.AriaLabel("Report views")], views.map((view) =>
    h.button([h.Type("button"), h.Role("tab"), h.AriaSelected(model.view === view), h.Class(model.view === view ? "on" : ""), h.OnClick(Message.ClickedView({ view }))], [VIEW_LABEL[view]]),
  ));
};

const body = (model: Model, report: Report, h: H): ReadonlyArray<Html> => {
  const count = findings(report.content).length;
  const note = count && model.view !== "source"
    ? [h.p([h.Class("rv-muted")], [`${count} findings · each "Start in Factory" opens a new worktree of ${report.folderId} and runs plan → approval → implement → verify.`])]
    : [];
  return [
    ...note,
    ...(model.view === "source"
      ? [h.pre([h.Class("rv-source")], [report.content])]
      : rendered(model, report, model.view === "brief" ? Option.match(model.maybeBrief, { onNone: () => report.content, onSome: briefLines }) : report.content, h)),
  ];
};

const content = (model: Model, render: Dialog.RenderInfo, h: H): ReadonlyArray<Html> => {
  const maybeReport = AsyncData.getData(model.report);
  return [
    h.header([h.Class("rv-head")], [
      h.div([h.Class("rv-title")], [
        h.b([...render.title], [`Report ${fileName(Option.match(maybeReport, { onNone: () => model.ref, onSome: (r) => r.path }))}`]),
        h.span([h.Class("rv-path")], [Option.match(maybeReport, { onNone: () => model.ref, onSome: (r) => r.path })]),
        h.span([...render.description, h.Class("rv-muted")], [Option.match(maybeReport, { onNone: () => "", onSome: (r) => `${r.folderId} · ${r.title}` })]),
      ]),
      ...(Option.isSome(maybeReport)
        ? [
            tabs(model, h),
            h.button([h.Type("button"), h.OnClick(Message.ClickedOpenHtml())], ["Open as HTML ↗"]),
            h.button([h.Type("button"), h.OnClick(Message.ClickedDownloadMdx())], ["Download .mdx"]),
          ]
        : []),
      h.button([...render.closeButton, h.Class("rv-x"), h.AriaLabel("Close report")], ["✕"]),
    ]),
    h.div([h.Class("rv-body")], AsyncData.matchData(model.report, {
      onEmpty: () => [h.p([h.Class("rv-muted")], ["Loading…"])],
      onFailure: (error) => [h.p([h.Class("rv-error"), h.Role("alert")], [error])],
      onData: (report) => body(model, report, h),
    })),
  ];
};

/** The report viewer: a modal Dialog with the report as Markdown, its brief, its source, and a Start button per finding. */
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
          render.isVisible ? [h.div([...render.backdrop, h.Class("fk-backdrop")]), h.div([...render.panel, h.Class("rv-modal")], content(model, render, h))] : [],
        ),
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  }),
);
