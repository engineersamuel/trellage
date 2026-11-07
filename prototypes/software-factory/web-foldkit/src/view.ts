import { Array, Match, Option, Record } from "effect";
import { AsyncData } from "foldkit";
import { type Document, type Html, type HtmlBuilder, createLazy } from "foldkit/html";
import { Meter } from "@foldkit/ui";
import { AttachSlot } from "./command";
import type { Decision as Approval } from "../../shared/approvals";
import { COORDINATOR_ID, type Delivery, type Settings as SettingsDocument, type Worker, backendName } from "./domain";
import { Message } from "./message";
import { toGotChatMessage } from "./chat";
import { chat } from "./chatProgram";
import type { Model } from "./model";
import * as Goals from "./goals";
import * as Settings from "./settings";
import { toGotGoalsMessage, toGotSettingsMessage, toGotWorkerPanelMessage } from "./update";
import * as WorkerPanel from "./workerPanel";

const BUSY_COLOR = "#f59e0b";
const IDLE_COLOR = "#16a34a";
const TOKENS_PER_K = 1000;

/** An empty extension mount point. shared/extensions.ts owns its children; the Mount registers it while it is on the page. */
const slot = (name: string, h: HtmlBuilder<Message>, className = ""): Html =>
  h.keyed("div")(`slot-${name}`, [h.DataAttribute("slot", name), h.Class(className), h.OnMount(AttachSlot({ name }))]);

// ---------- Navbar ----------

const contextMeter = (maybeCoordinator: Option.Option<Worker>, h: HtmlBuilder<Message>): Html => {
  const used = Option.match(maybeCoordinator, { onNone: () => 0, onSome: (worker) => worker.contextTokens ?? 0 });
  const limit = Option.match(maybeCoordinator, { onNone: () => 0, onSome: (worker) => worker.contextLimit ?? 0 });
  const label = `${Math.round(used / TOKENS_PER_K)}k / ${Math.round(limit / TOKENS_PER_K)}k`;
  return limit === 0
    ? h.span([h.Class("fk-nav-item")], ["ctx –"])
    : Meter.view(
        {
          id: "context-meter",
          value: Math.min(used, limit),
          min: 0,
          max: limit,
          valueText: `${used} of ${limit} context tokens`,
          toView: (attributes) =>
            h.span([h.Class("fk-nav-item"), h.Title(`${used} / ${limit} tokens`)], [
              h.span([...attributes.label, h.Class("fk-visually-hidden")], ["Coordinator context"]),
              h.span([...attributes.meter, h.Class("fk-ctx-bar")], [h.span([...attributes.fill])]),
              label,
            ]),
        },
        h,
      );
};

const repoLabel = (settings: SettingsDocument, maybeDelivery: Option.Option<Delivery>): string => {
  const repo = settings.repo ? Option.getOrElse(Array.last(settings.repo.split("/")), () => settings.repo) : "no repo";
  const branch = Option.match(Option.flatMap(maybeDelivery, ({ run }) => Option.fromNullishOr(run)), { onNone: () => "", onSome: (run) => ` · ${run.branch}` });
  return `⎇ ${repo}${branch}`;
};

const navbarItem = (settings: SettingsDocument, maybeDelivery: Option.Option<Delivery>, workers: ReadonlyArray<Worker>, item: string, h: HtmlBuilder<Message>): Html => {
  const maybeCoordinator = Array.findFirst(workers, ({ id }) => id === COORDINATOR_ID);
  const isBusy = Option.exists(maybeCoordinator, ({ status }) => status === "running");
  return Match.value(item).pipe(
    Match.withReturnType<Html>(),
    Match.when("status", () =>
      h.span([h.Class("fk-nav-item")], [
        h.span([h.Class(`fk-dot ${isBusy ? "sf-busy" : ""}`), h.AriaHidden(true), h.Style({ background: isBusy ? BUSY_COLOR : IDLE_COLOR })]),
        Option.match(maybeCoordinator, { onNone: () => "…", onSome: ({ status }) => status }),
      ]),
    ),
    Match.when("workers", () =>
      h.span([h.Class("fk-nav-item")], [
        `${Array.filter(workers, ({ role }) => role !== COORDINATOR_ID).length} workers · ${Array.filter(workers, ({ status }) => status === "running").length} running`,
      ]),
    ),
    Match.when("model", () => h.span([h.Class("fk-nav-item")], [`${settings.agent.model} · ${settings.agent.reasoningEffort}`])),
    Match.when("context", () => contextMeter(maybeCoordinator, h)),
    Match.when("auth", () =>
      h.span([h.Class("fk-nav-item")], [Option.match(maybeCoordinator, { onNone: () => "", onSome: ({ auth }) => backendName(auth) })]),
    ),
    Match.when("repo", () =>
      h.span([h.Class("fk-nav-item"), h.Title(settings.repo)], [repoLabel(settings, maybeDelivery)]),
    ),
    Match.when("crons", () =>
      h.span([h.Class("fk-nav-item")], [`⏱ ${Array.filter(Record.values(settings.crons), ({ enabled }) => enabled).length} crons`]),
    ),
    Match.orElse(() => h.empty),
  );
};

const approvalsLink = (pending: ReadonlyArray<Approval>, h: HtmlBuilder<Message>): Html =>
  Array.match(pending, {
    onEmpty: () => h.empty,
    onNonEmpty: (approvals) =>
      // A hash link, not a route: shared/decisions.ts opens #decision=<id> as an overlay over any page.
      h.a(
        [h.Class("fk-nav-item fk-approvals"), h.Href(`#decision=${Array.headNonEmpty(approvals).id}`), h.Title(Array.map(approvals, ({ title }) => title).join("\n"))],
        [`⚑ ${approvals.length} waiting`],
      ),
  });

const EMPTY_WORKERS: ReadonlyArray<Worker> = [];

/** The navbar reads only settings, workers and approvals, so a chat Message reuses the cached subtree. */
const navbar = (settingsModel: Settings.Model, goalsModel: Goals.Model, workers: WorkerPanel.Model["workers"], approvals: ReadonlyArray<Approval>, h: HtmlBuilder<Message>): Html =>
  Option.match(Settings.maybeSettings(settingsModel), {
    onNone: () => h.empty,
    onSome: (settings) => {
      const workerList = AsyncData.getOrElse(workers, () => EMPTY_WORKERS);
      const maybeDelivery = AsyncData.getData(settingsModel.delivery);
      return h.nav([h.Class("fk-nav sf-nav"), h.AriaLabel("Factory status")], [
        h.h1([h.Class("fk-title")], ["Factory · Foldkit"]),
        ...Array.map(settings.navbar, (item) =>
          h.keyed("span")(`nav-${item}`, [h.Class("fk-nav-slot")], [navbarItem(settings, maybeDelivery, workerList, item, h)]),
        ),
        approvalsLink(approvals, h),
        slot("navbar", h, "fk-nav-item"),
        h.span([h.Class("fk-spacer")]),
        h.span([h.Class("fk-nav-item fk-muted")], [settings.theme]),
        h.submodel({ model: goalsModel, slotId: "goals-button", toParentMessage: toGotGoalsMessage, view: Goals.navButton }),
        h.submodel({ model: settingsModel, slotId: "settings-gear", toParentMessage: toGotSettingsMessage, view: Settings.gearButton }),
      ]);
    },
  });

// ---------- Layout ----------

/** Reads only the chat Model, so a worker, settings or approvals Message reuses the cached chat subtree. */
const chatView = (chatModel: Model["chat"], h: HtmlBuilder<Message>): Html =>
  // .sf-chat is the stable hook extension CSS targets in both UIs.
  h.keyed("div")("chat", [h.Class("fk-chat sf-chat")], [
    slot("chat-background", h, "fk-slot-bg"),
    h.div([h.Class("fk-chat-body")], [h.submodel({ model: chatModel, slotId: "chat", toParentMessage: toGotChatMessage, view: chat.view })]),
  ]);

const workerPanel = (workerPanelModel: WorkerPanel.Model, h: HtmlBuilder<Message>): Html =>
  h.aside([h.Class("fk-panel sf-panel"), h.AriaLabel("Agents panel")], [
    slot("panel-top", h),
    h.submodel({ model: workerPanelModel, slotId: "worker-panel", toParentMessage: toGotWorkerPanelMessage, view: WorkerPanel.view }),
  ]);

const settingsDrawer = (settingsModel: Settings.Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({ model: settingsModel, slotId: "settings", toParentMessage: toGotSettingsMessage, view: Settings.view });

// One memo slot per tree position: a cached VNode must render at a single position.
const lazyNavbar = createLazy();
const lazyPanelLeft = createLazy();
const lazyPanelRight = createLazy();
const lazySettingsDrawer = createLazy();
const lazyGoalsDialog = createLazy();
const lazyClassicChat = createLazy();
const lazyPrototypeChat = createLazy();

const goalsDialog = (goalsModel: Goals.Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({ model: goalsModel, slotId: "goals", toParentMessage: toGotGoalsMessage, view: Goals.view });

const gridColumns = (side: string, width: number): string =>
  Match.value(side).pipe(
    Match.when("hidden", () => "1fr"),
    Match.when("left", () => `${width}% 1fr`),
    Match.orElse(() => `1fr ${width}%`),
  );

const classicLayout = (model: Model, layout: SettingsDocument["layout"], h: HtmlBuilder<Message>): Html => {
  const { panel: side, panelWidth } = layout;
  const cells = Match.value(side).pipe(
    Match.when("hidden", () => [lazyClassicChat(chatView, [model.chat, h])]),
    Match.when("left", () => [lazyPanelLeft(workerPanel, [model.workerPanel, h]), lazyClassicChat(chatView, [model.chat, h])]),
    Match.orElse(() => [lazyClassicChat(chatView, [model.chat, h]), lazyPanelRight(workerPanel, [model.workerPanel, h])]),
  );
  return h.main([h.Class("fk-layout"), h.Style({ "grid-template-columns": gridColumns(side, panelWidth) })], cells);
};

/** Prototype layout: shared/protos owns .sfp-host's children and places the chat cell. */
const prototypeLayout = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.main([h.Class("sfp-stage"), h.DataAttribute("proto", String(model.protoIndex))], [
    h.keyed("div")("sfp-chat", [h.Class("sfp-chat")], [lazyPrototypeChat(chatView, [model.chat, h])]),
    h.keyed("div")(`sfp-host-${model.protoIndex}`, [h.Class("sfp-host"), h.DataAttribute("proto", String(model.protoIndex))]),
  ]);

/** Default layout until settings arrive: the same tree as the loaded page, so the chat is never rebuilt. */
const LOADING_LAYOUT: SettingsDocument["layout"] = { panel: "hidden", panelWidth: 0 };

/** One page skeleton for every state. The chat keeps its tree position when settings load, so it is patched,
 *  not destroyed and rebuilt (which also made it measure its layout again). */
export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const maybeDocument = AsyncData.getData(model.settings.document);
  const maybeSettings = Option.map(maybeDocument, ({ settings }) => settings);
  const banner = Option.flatMap(maybeSettings, ({ banner }) => Option.fromNullishOr(banner));
  return {
    title: "Software Factory · Foldkit",
    body: h.div([h.Class("fk-root")], [
      // NOTE: theme CSS comes from the coordinator (settings.ts renders it from the palette the agent picks). CSS cannot
      // run script; agent-written extension CSS is mounted the same way by shared/extensions.ts. Both are trusted by design.
      h.style([], [Option.match(maybeDocument, { onNone: () => "", onSome: ({ css }) => css })]),
      slot("page-background", h, "fk-slot-bg"),
      Option.match(maybeSettings, {
        onNone: () => h.h1([h.Class("fk-visually-hidden")], ["Factory · Foldkit"]),
        onSome: () => lazyNavbar(navbar, [model.settings, model.goals, model.workerPanel.workers, model.approvals, h]),
      }),
      ...Option.match(banner, { onNone: () => [], onSome: (text) => [h.div([h.Class("fk-banner"), h.Role("status")], [text])] }),
      slot("banner", h),
      model.protoIndex > 0
        ? prototypeLayout(model, h)
        : classicLayout(model, Option.match(maybeSettings, { onNone: () => LOADING_LAYOUT, onSome: ({ layout }) => layout }), h),
      slot("overlay", h, "fk-slot-overlay"),
      lazySettingsDrawer(settingsDrawer, [model.settings, h]),
      lazyGoalsDialog(goalsDialog, [model.goals, h]),
    ]),
  };
};
