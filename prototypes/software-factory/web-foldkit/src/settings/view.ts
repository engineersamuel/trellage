import { Array, Option, Record } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Button, Checkbox, Dialog, Input, Select, Slider, Textarea } from "@foldkit/ui";
import type { Delivery, JevDecision, SecurityReview, Settings, SettingsOptions } from "../domain";
import { Message } from "./message";
import type { Model } from "./model";

const RECENT_DECISIONS = 5;
const RECENT_REVIEWS = 3;
const REQUEST_PREVIEW_LENGTH = 60;

// ---------- Small controls ----------

/** A toggle button; `aria-pressed` tells assistive tech whether it is on. */
const chip = (label: string, isOn: boolean, onClick: Message, h: HtmlBuilder<Message>, extraClass = ""): Html =>
  Button.view(
    {
      onClick,
      toView: (attributes) =>
        h.button([...attributes.button, h.Class(`${isOn ? "on" : ""} ${extraClass}`), h.AriaPressed(isOn ? "true" : "false")], [label]),
    },
    h,
  );

const iconButton = (label: string, onClick: Message, h: HtmlBuilder<Message>): Html =>
  Button.view({ onClick, toView: (attributes) => h.button([...attributes.button, h.AriaLabel(label)], ["✕"]) }, h);

const checkbox = (id: string, label: string, isChecked: boolean, onToggle: (isChecked: boolean) => Message, h: HtmlBuilder<Message>): Html =>
  Checkbox.view(
    {
      id,
      isChecked,
      onToggle,
      toView: (attributes) =>
        h.span([h.Class("fk-check-row")], [
          h.button([...attributes.checkbox, h.Class("fk-check")], isChecked ? ["✓"] : []),
          h.label([...attributes.label], [label]),
        ]),
    },
    h,
  );

/** A text field that saves on change (blur or Enter), not on every key. */
const textField = (id: string, label: string, value: string, placeholder: string, onChange: (value: string) => Message, h: HtmlBuilder<Message>): Html =>
  Input.view(
    {
      id,
      value,
      placeholder,
      toView: (attributes) =>
        h.span([h.Class("fk-field")], [h.label([...attributes.label], [label]), h.input([...attributes.input, h.OnChange(onChange)])]),
    },
    h,
  );

const select = (id: string, label: string, value: string, options: ReadonlyArray<string>, onChange: (value: string) => Message, h: HtmlBuilder<Message>): Html =>
  Select.view(
    {
      id,
      value,
      onChange,
      toView: (attributes) =>
        h.span([h.Class("fk-field")], [
          h.label([...attributes.label], [label]),
          h.select([...attributes.select], Array.map(options, (option) => h.option([h.Value(option)], [option]))),
        ]),
    },
    h,
  );

const errorLine = (maybeError: Option.Option<string>, h: HtmlBuilder<Message>): Html =>
  Option.match(maybeError, { onNone: () => h.empty, onSome: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [error]) });

const section = (title: string, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section([], [h.h3([], [title]), ...children]);

// ---------- Sections ----------

const themeSection = (settings: Settings, h: HtmlBuilder<Message>): Html =>
  section(
    "Theme",
    [
      h.div(
        [h.Class("fk-chips")],
        Array.map(Record.toEntries(settings.themes), ([name, palette]) =>
          Button.view(
            {
              onClick: Message.ClickedTheme({ theme: name }),
              toView: (attributes) =>
                h.keyed("button")(name, [...attributes.button, h.Class(name === settings.theme ? "on" : ""), h.AriaPressed(name === settings.theme ? "true" : "false")], [
                  h.span([h.Class("fk-swatch"), h.AriaHidden(true), h.Style({ background: palette.bg, "border-color": palette.accent })]),
                  name,
                ]),
            },
            h,
          ),
        ),
      ),
      checkbox("animations", "animations", settings.animations, (isChecked) => Message.ToggledAnimations({ isChecked }), h),
    ],
    h,
  );

const layoutSection = (model: Model, settings: Settings, options: SettingsOptions, h: HtmlBuilder<Message>): Html =>
  section(
    "Layout",
    [
      h.div(
        [h.Class("fk-chips")],
        Array.map(options.panelPositions, (position) =>
          h.keyed("span")(position, [], [chip(position, position === settings.layout.panel, Message.ClickedPanelPosition({ position }), h)]),
        ),
      ),
      h.submodel({
        slotId: model.panelWidthSlider.id,
        model: model.panelWidthSlider,
        view: Slider.view,
        viewInputs: {
          value: settings.layout.panelWidth,
          formatValue: (value: number) => `${value}%`,
          toView: (attributes: Slider.SliderAttributes) =>
            h.div([h.Class("fk-slider")], [
              h.label([...attributes.label], [`panel width ${settings.layout.panelWidth}%`]),
              h.div([...attributes.root, h.Class("fk-slider-root")], [
                h.div([...attributes.track, h.Class("fk-slider-track")], [h.div([...attributes.filledTrack, h.Class("fk-slider-fill")])]),
                h.div([...attributes.thumb, h.Class("fk-slider-thumb")]),
              ]),
            ]),
        },
        toParentMessage: (message: Slider.Message) => Message.GotPanelWidthSliderMessage({ message }),
      }),
    ],
    h,
  );

const navbarSection = (settings: Settings, options: SettingsOptions, h: HtmlBuilder<Message>): Html =>
  section(
    "Navbar",
    [
      h.div(
        [h.Class("fk-chips")],
        Array.map(options.navbarItems, (item) =>
          h.keyed("span")(item, [], [chip(item, Array.contains(settings.navbar, item), Message.ToggledNavbarItem({ item }), h)]),
        ),
      ),
      textField("banner", "banner", settings.banner ?? "", "(none)", (value) => Message.UpdatedBanner({ value }), h),
    ],
    h,
  );

const decisionSummary = (decision: JevDecision): Readonly<{ title: string; detail: string }> =>
  "step" in decision
    ? { title: decision.step, detail: ` conf ${decision.confidence.toFixed(2)} · more ${decision.moreWork.toFixed(2)} ` }
    : {
        title: decision.selected.join(", "),
        detail: ` ${Array.map(Record.toEntries(decision.probabilities), ([id, probability]) => `${id} ${probability.toFixed(2)}`).join(" · ")} `,
      };

/** Decisions carry no id; the request text plus the step picked tells them apart in the short recent list. */
const decisionRow = (decision: JevDecision, h: HtmlBuilder<Message>): Html => {
  const { title, detail } = decisionSummary(decision);
  return h.keyed("li")(`${title}|${decision.request}`, [h.Class("fk-cron")], [
    h.b([], [title]),
    detail,
    h.span([h.Class("fk-muted")], [decision.request.slice(0, REQUEST_PREVIEW_LENGTH)]),
  ]);
};

const reviewRows = (review: SecurityReview, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.keyed("li")(review.id, [h.Class("fk-cron")], [h.b([], [review.status]), ` ${review.model || "routing model"} `, h.span([h.Class("fk-muted")], [review.id])]),
  ...(review.error === undefined ? [] : [h.keyed("li")(`${review.id}-error`, [h.Class("fk-error")], [review.error])]),
  ...Array.map(review.findings, (finding) =>
    h.keyed("li")(`${review.id}-${finding.id}`, [h.Class("fk-cron")], [
      h.b([], [finding.verdict]),
      ` [${finding.severity}] ${finding.title} `,
      h.span([h.Class("fk-muted")], [`${finding.file} · ${finding.reason}`]),
    ]),
  ),
];

const deliveryDetails = (delivery: Delivery, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const decisions = Array.takeRight(delivery.decisions, RECENT_DECISIONS);
  const reviews = Array.takeRight(delivery.securityReviews, RECENT_REVIEWS);
  return [
    h.p([h.Class("fk-muted")], [delivery.run ? `run ${delivery.run.id} · ${delivery.run.branch} · ${delivery.run.worktree}` : "no run yet (starts with the first worker)"]),
    ...(delivery.run?.dirty ? [h.p([h.Class("fk-error")], ["target repo has uncommitted changes; the run worktree does not contain them"])] : []),
    h.h4([], ["Step catalog (Jev picks the next step)"]),
    h.ul(
      [h.Class("fk-list")],
      Array.map(delivery.steps, (step) =>
        h.keyed("li")(step.id, [h.Class("fk-cron")], [
          h.b([], [step.id]),
          " ",
          h.span([h.Class("fk-muted")], [`${Array.isReadonlyArrayNonEmpty(step.skills) ? `[${step.skills.join(", ")}] ` : ""}${step.description}`]),
        ]),
      ),
    ),
    ...Array.match(decisions, {
      onEmpty: () => [],
      onNonEmpty: (recent) => [
        h.h4([], ["Jev decisions"]),
        h.ul([h.Class("fk-list")], Array.map(recent, (decision) => decisionRow(decision, h))),
      ],
    }),
    ...Array.match(reviews, {
      onEmpty: () => [],
      onNonEmpty: (recent) => [h.h4([], ["Security review"]), h.ul([h.Class("fk-list")], Array.flatMap(recent, (review) => reviewRows(review, h)))],
    }),
  ];
};

const deliverySection = (model: Model, settings: Settings, h: HtmlBuilder<Message>): Html =>
  section(
    "Delivery",
    [
      textField("repo", "target repo", settings.repo, "/absolute/path/to/git/repo", (value) => Message.UpdatedRepo({ value }), h),
      ...AsyncData.match(model.delivery, {
        onIdle: () => [],
        onLoading: () => [h.p([h.Class("fk-muted")], ["Loading delivery…"])],
        onRefreshing: (delivery) => deliveryDetails(delivery, h),
        onFailure: (error) => [h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load delivery: ${error}`])],
        onStale: ({ error, data }) => [h.p([h.Class("fk-error"), h.Role("alert")], [`Delivery may be out of date: ${error}`]), ...deliveryDetails(data, h)],
        onSuccess: (delivery) => deliveryDetails(delivery, h),
      }),
    ],
    h,
  );

const agentSection = (settings: Settings, options: SettingsOptions, h: HtmlBuilder<Message>): Html =>
  section(
    "Agent (core 4)",
    [
      select("agent-model", "model", settings.agent.model, options.models, (model) => Message.SelectedModel({ model }), h),
      select("agent-effort", "reasoning", settings.agent.reasoningEffort, options.efforts, (effort) => Message.SelectedReasoningEffort({ effort }), h),
      h.h4([], ["Disabled built-in tools"]),
      h.div(
        [h.Class("fk-chips")],
        Array.map(options.toolKinds, (tool) =>
          h.keyed("span")(tool, [], [chip(tool, Array.contains(settings.agent.disabledTools, tool), Message.ToggledDisabledTool({ tool }), h, "danger")]),
        ),
      ),
      Textarea.view(
        {
          id: "agent-instructions",
          value: settings.agent.instructions,
          rows: 3,
          toView: (attributes) =>
            h.span([h.Class("fk-field")], [
              h.label([...attributes.label], ["instructions"]),
              h.textarea([...attributes.textarea, h.OnChange((value) => Message.UpdatedInstructions({ value }))]),
            ]),
        },
        h,
      ),
    ],
    h,
  );

const cronDraftInput = (id: string, label: string, value: string, placeholder: string, onInput: (value: string) => Message, h: HtmlBuilder<Message>): Html =>
  Input.view(
    {
      id,
      value,
      placeholder,
      onInput,
      toView: (attributes) =>
        h.span([h.Class("fk-field")], [h.label([...attributes.label, h.Class("fk-visually-hidden")], [label]), h.input([...attributes.input])]),
    },
    h,
  );

const cronDraftForm = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form([h.Class("fk-send"), h.OnSubmit(Message.SubmittedCronDraft())], [
    cronDraftInput("cron-name", "Cron name", model.cronDraft.name, "name", (value) => Message.UpdatedCronName({ value }), h),
    cronDraftInput("cron-every", "Interval in seconds", model.cronDraft.every, "seconds", (value) => Message.UpdatedCronInterval({ value }), h),
    cronDraftInput("cron-prompt", "Cron prompt", model.cronDraft.prompt, "prompt", (value) => Message.UpdatedCronPrompt({ value }), h),
    Button.view({ type: "submit", toView: (attributes) => h.button([...attributes.button], ["Add"]) }, h),
  ]);

const cronSection = (model: Model, settings: Settings, h: HtmlBuilder<Message>): Html =>
  section(
    "Cron prompts",
    [
      h.ul(
        [h.Class("fk-list")],
        Array.map(Record.toEntries(settings.crons), ([name, cron]) =>
          h.keyed("li")(name, [h.Class("fk-cron")], [
            checkbox(`cron-${name}`, name, cron.enabled, (isChecked) => Message.ToggledCron({ name, isChecked }), h),
            ` every ${cron.everySeconds}s `,
            h.span([h.Class("fk-muted")], [cron.prompt]),
            iconButton(`Remove cron ${name}`, Message.ClickedRemoveCron({ name }), h),
          ]),
        ),
      ),
      errorLine(model.maybeCronDraftError, h),
      cronDraftForm(model, h),
    ],
    h,
  );

const extensionSection = (settings: Settings, h: HtmlBuilder<Message>): Html =>
  section(
    "Extensions",
    [
      Array.match(Record.toEntries(settings.extensions), {
        onEmpty: () => h.p([h.Class("fk-muted")], ["none yet. Ask the agent for any UI change."]),
        onNonEmpty: (extensions) =>
          h.ul(
            [h.Class("fk-list")],
            Array.map(extensions, ([name, extension]) =>
              h.keyed("li")(name, [h.Class("fk-cron")], [
                checkbox(`extension-${name}`, name, extension.enabled, (isChecked) => Message.ToggledExtension({ name, isChecked }), h),
                " ",
                h.span([h.Class("fk-muted")], [`${extension.slot} · ${extension.description}`]),
                iconButton(`Remove extension ${name}`, Message.ClickedRemoveExtension({ name }), h),
              ]),
            ),
          ),
      }),
    ],
    h,
  );

const hotkeySection = (settings: Settings, h: HtmlBuilder<Message>): Html =>
  section(
    "Hotkeys",
    [h.ul([h.Class("fk-list")], Array.map(Record.toEntries(settings.hotkeys), ([key, action]) => h.keyed("li")(key, [], [h.kbd([], [key]), ` ${action}`])))],
    h,
  );

// ---------- Drawer ----------

const drawerContent = (model: Model, render: Dialog.RenderInfo, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(AsyncData.getData(model.document), {
    onNone: () => [h.p([h.Class("fk-muted")], ["Loading settings…"])],
    onSome: ({ settings, options }) => [
      h.header([], [
        h.h2([...render.title], ["Settings"]),
        h.span([...render.description, h.Class("fk-muted")], [" · the agent can change all of this too"]),
        h.button([...render.closeButton, h.AriaLabel("Close settings")], ["✕"]),
      ]),
      errorLine(model.maybePatchError, h),
      themeSection(settings, h),
      layoutSection(model, settings, options, h),
      navbarSection(settings, options, h),
      deliverySection(model, settings, h),
      agentSection(settings, options, h),
      cronSection(model, settings, h),
      extensionSection(settings, h),
      hotkeySection(settings, h),
    ],
  });

/** The settings drawer: a modal Dialog (focus trap, Escape, focus return) styled as a side panel. */
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
            ? [h.div([...render.backdrop, h.Class("fk-backdrop")]), h.div([...render.panel, h.Class("fk-drawer")], drawerContent(model, render, h))]
            : [],
        ),
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  }),
);

/** The navbar gear that opens the drawer. The `,` hotkey does the same. */
export const gearButton = Submodel.defineView<Model, Message>((_model, h) =>
  Button.view(
    {
      onClick: Message.ClickedOpenSettings(),
      toView: (attributes) => h.button([...attributes.button, h.AriaLabel("Open settings"), h.Title("Settings (,)")], ["⚙"]),
    },
    h,
  ),
);
