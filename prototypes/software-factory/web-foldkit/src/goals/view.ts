import { Array, Option } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Button, Checkbox, Dialog, Input, Select, Textarea } from "@foldkit/ui";
import { APPROVAL_TOPICS, SDLC_GATES } from "../../../shared/goal";
import { Message } from "./message";
import type { Model } from "./model";
import { catalogSkills, stepRows } from "./update";

const POLICY_HINT: Record<(typeof APPROVAL_TOPICS)[number], string> = {
  plan: "plan before implement",
  findings: "apply review findings",
  ship: "push and open the PR",
  other: "any other question",
};

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

const input = (id: string, label: string, value: string, placeholder: string, onInput: (value: string) => Message, h: HtmlBuilder<Message>): Html =>
  Input.view(
    {
      id,
      value,
      placeholder,
      onInput,
      toView: (attributes) => h.span([h.Class("fk-field")], [h.label([...attributes.label], [label]), h.input([...attributes.input])]),
    },
    h,
  );

/** A small number box inside a step row; its label is for assistive tech only. */
const countInput = (id: string, label: string, value: string, placeholder: string, onInput: (value: string) => Message, h: HtmlBuilder<Message>): Html =>
  Input.view(
    {
      id,
      value,
      placeholder,
      onInput,
      toView: (attributes) =>
        h.span([h.Class("fk-goal-count")], [h.label([...attributes.label, h.Class("fk-visually-hidden")], [label]), h.input([...attributes.input])]),
    },
    h,
  );

const chip = (label: string, isOn: boolean, onClick: Message, h: HtmlBuilder<Message>): Html =>
  Button.view(
    { onClick, toView: (attributes) => h.button([...attributes.button, h.Class(isOn ? "on" : ""), h.AriaPressed(isOn ? "true" : "false")], [label]) },
    h,
  );

const section = (title: string, children: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html => h.section([], [h.h3([], [title]), ...children]);

// ---------- Sections ----------

const savedGoals = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.matchDataSplitEmpty(model.goals, {
    onIdle: () => h.empty,
    onLoading: () => h.p([h.Class("fk-muted")], ["Loading goals…"]),
    onFailure: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load goals: ${error}`]),
    onData: ({ goals, factoryCommit }) =>
      section(
        `Saved goals · factory ${factoryCommit}`,
        [
          Array.match(goals, {
            onEmpty: () => h.p([h.Class("fk-muted")], ["none yet"]),
            onNonEmpty: (list) =>
              h.ul(
                [h.Class("fk-list")],
                Array.map(list, ({ spec, runs, last }) =>
                  h.keyed("li")(spec.id, [h.Class("fk-cron")], [
                    chip(spec.id, spec.id === model.draft.id, Message.ClickedEditGoal({ id: spec.id }), h),
                    h.span([h.Class("fk-muted")], [` ${runs} runs · last ${last?.outcome ?? "-"}`]),
                  ]),
                ),
              ),
          }),
          chip("+ new goal", false, Message.ClickedNewGoal(), h),
        ],
        h,
      ),
  });

const repoSelect = (model: Model, h: HtmlBuilder<Message>): Html => {
  const folders = Option.match(AsyncData.getData(model.catalog), { onNone: () => [], onSome: ({ folders }) => folders });
  return Select.view(
    {
      id: "goal-repo",
      value: model.draft.repo,
      onChange: (value) => Message.SelectedRepo({ value }),
      toView: (attributes) =>
        h.span([h.Class("fk-field")], [
          h.label([...attributes.label], ["Repo"]),
          h.select([...attributes.select], [
            h.option([h.Value("")], ["choose a repo folder"]),
            ...Array.map(folders, ({ name, path }) => h.option([h.Value(path)], [`${name} · ${path}`])),
          ]),
        ]),
    },
    h,
  );
};

const whatSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    "What to build",
    [
      input("goal-id", "Goal id", model.draft.id, "e.g. cpr-process-compose", (value) => Message.UpdatedId({ value }), h),
      input("goal-title", "Title", model.draft.title, "one line", (value) => Message.UpdatedTitle({ value }), h),
      repoSelect(model, h),
      input("goal-base", "Base branch", model.draft.base, "main", (value) => Message.UpdatedBase({ value }), h),
      Textarea.view(
        {
          id: "goal-prompt",
          value: model.draft.prompt,
          rows: 8,
          onInput: (value) => Message.UpdatedPrompt({ value }),
          toView: (attributes) =>
            h.span([h.Class("fk-field fk-goal-prompt")], [h.label([...attributes.label], ["Prompt"]), h.textarea([...attributes.textarea])]),
        },
        h,
      ),
    ],
    h,
  );

/** One row per catalog step: on/off, and the min and max number of workers on that step. */
const stepsSection = (model: Model, h: HtmlBuilder<Message>): Html => {
  const steps = Option.match(AsyncData.getData(model.catalog), { onNone: () => [], onSome: ({ steps }) => steps });
  return section(
    "Workers that must run (step · min · max)",
    [
      h.ul(
        [h.Class("fk-list fk-goal-steps")],
        Array.map(steps, ({ id, description }) => {
          const row = model.draft.steps[id] ?? { on: false, min: "1", max: "" };
          return h.keyed("li")(id, [h.Title(description)], [
            checkbox(`goal-step-${id}`, id, row.on, (isChecked) => Message.ToggledStep({ step: id, isChecked }), h),
            countInput(`goal-step-${id}-min`, `${id} at least`, row.min, "1", (value) => Message.UpdatedStepMin({ step: id, value }), h),
            countInput(`goal-step-${id}-max`, `${id} at most`, row.max, "any", (value) => Message.UpdatedStepMax({ step: id, value }), h),
          ]);
        }),
      ),
      // Steps kept from a spec that the catalog no longer has, so they are not silently dropped.
      ...Array.map(
        Array.filter(stepRows(model), ([id]) => !steps.some((s) => s.id === id)),
        ([id]) => h.p([h.Class("fk-error")], [`step ${id} is not in the factory's catalog`]),
      ),
    ],
    h,
  );
};

const skillsSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    "Skills that must be invoked",
    [
      h.div(
        [h.Class("fk-chips")],
        Array.map(catalogSkills(model), (skill) =>
          h.keyed("span")(skill, [], [
            checkbox(`goal-skill-${skill}`, skill, model.draft.skills.includes(skill), (isChecked) => Message.ToggledSkill({ skill, isChecked }), h),
          ]),
        ),
      ),
    ],
    h,
  );

const prSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    "Pull request",
    [
      checkbox("goal-pr", "expect an open PR (never merged by the factory)", model.draft.expectPr, (isChecked) => Message.ToggledExpectPr({ isChecked }), h),
      ...(model.draft.expectPr
        ? [
            checkbox("goal-checks", "all checks green", model.draft.greenChecks, (isChecked) => Message.ToggledGreenChecks({ isChecked }), h),
            input("goal-body", "PR body includes", model.draft.bodyIncludes, "comma separated", (value) => Message.UpdatedBodyIncludes({ value }), h),
            input("goal-untouched", "Files left untouched", model.draft.untouched, "comma separated", (value) => Message.UpdatedUntouched({ value }), h),
          ]
        : []),
    ],
    h,
  );

const GATE_HINT: Record<(typeof SDLC_GATES)[number], string> = {
  design: "design note before code",
  testFirst: "failing tests committed first",
  codeReview: "Jev-picked review lenses, scored fixes",
  supplyChain: "secrets, vulnerabilities, licenses",
  docs: "README / docs / changelog updated",
  postMerge: "main's checks watched after merge",
};

/** Floors always apply (criteria proven, verify, security). Per optional gate: must run, must be skipped, or Jev decides. */
const sdlcSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    "SDLC gates",
    [
      checkbox("goal-sdlc", "check the SDLC record (criteria proven, verify and security always)", model.draft.expectSdlc, (isChecked) => Message.ToggledExpectSdlc({ isChecked }), h),
      ...(model.draft.expectSdlc
        ? [
            h.ul(
              [h.Class("fk-list")],
              Array.map(SDLC_GATES, (gate) => {
                const current = model.draft.gatesRun.includes(gate) ? "run" : model.draft.gatesSkipped.includes(gate) ? "skip" : "any";
                return h.keyed("li")(gate, [h.Class("fk-chips")], [
                  h.span([], [`${gate} `, h.span([h.Class("fk-muted")], [GATE_HINT[gate]])]),
                  chip(`${gate}: must run`, current === "run", Message.ClickedGateExpectation({ gate, expectation: "run" }), h),
                  chip(`${gate}: must skip`, current === "skip", Message.ClickedGateExpectation({ gate, expectation: "skip" }), h),
                  chip(`${gate}: Jev decides`, current === "any", Message.ClickedGateExpectation({ gate, expectation: "any" }), h),
                ]);
              }),
            ),
          ]
        : []),
    ],
    h,
  );

const approvalsSection = (model: Model, h: HtmlBuilder<Message>): Html =>
  section(
    "Who answers decisions",
    [
      h.ul(
        [h.Class("fk-list")],
        Array.map(APPROVAL_TOPICS, (topic) =>
          h.keyed("li")(topic, [h.Class("fk-chips")], [
            h.span([], [`${topic} `, h.span([h.Class("fk-muted")], [POLICY_HINT[topic]])]),
            chip(`${topic}: loop`, model.draft.approvals[topic] === "auto", Message.ClickedPolicy({ topic, policy: "auto" }), h),
            chip(`${topic}: me`, model.draft.approvals[topic] === "human", Message.ClickedPolicy({ topic, policy: "human" }), h),
          ]),
        ),
      ),
      input("goal-runs", "Max runs", model.draft.runs, "5", (value) => Message.UpdatedRuns({ value }), h),
      input("goal-minutes", "Minutes per run", model.draft.minutesPerRun, "90", (value) => Message.UpdatedMinutes({ value }), h),
    ],
    h,
  );

const copyBlock = (label: string, text: string, model: Model, h: HtmlBuilder<Message>, isPre = false): Html =>
  h.div([h.Class("fk-goal-copy")], [
    isPre ? h.pre([h.AriaLabel(label)], [text]) : h.code([h.AriaLabel(label)], [text]),
    Button.view(
      { onClick: Message.ClickedCopy({ text }), toView: (attributes) => h.button([...attributes.button], [model.isCopied ? "Copied" : `Copy ${label}`]) },
      h,
    ),
  ]);

const result = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeSaved, {
    onNone: () => h.empty,
    onSome: ({ skill, prompt }) =>
      section(
        "Saved · paste one of these into Claude Code",
        [
          h.p([h.Class("fk-muted")], ["With the skill installed (mise run factory:skill):"]),
          copyBlock("command", skill, model, h),
          h.p([h.Class("fk-muted")], ["Any agent, no skill needed:"]),
          h.details([], [h.summary([], ["full loop prompt"]), copyBlock("prompt", prompt, model, h, true)]),
        ],
        h,
      ),
  });

const form = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.form([h.Class("fk-goal-form"), h.OnSubmit(Message.SubmittedGoal())], [
    whatSection(model, h),
    stepsSection(model, h),
    skillsSection(model, h),
    prSection(model, h),
    sdlcSection(model, h),
    approvalsSection(model, h),
    ...Array.match(model.problems, {
      onEmpty: () => [],
      onNonEmpty: (problems) => [h.ul([h.Class("fk-error"), h.Role("alert")], Array.map(problems, (p) => h.li([], [p])))],
    }),
    Button.view({ type: "submit", toView: (attributes) => h.button([...attributes.button], ["Save goal"]) }, h),
  ]);

const content = (model: Model, render: Dialog.RenderInfo, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.header([], [
    h.h2([...render.title], ["Factory goals"]),
    h.span([...render.description, h.Class("fk-muted")], [" · test cases for the self-improve loop"]),
    h.button([...render.closeButton, h.AriaLabel("Close goals")], ["✕"]),
  ]),
  savedGoals(model, h),
  AsyncData.matchDataSplitEmpty(model.catalog, {
    onIdle: () => h.empty,
    onLoading: () => h.p([h.Class("fk-muted")], ["Loading steps and folders…"]),
    onFailure: (error) => h.p([h.Class("fk-error"), h.Role("alert")], [`Could not load steps: ${error}`]),
    onData: () => form(model, h),
  }),
  result(model, h),
];

/** The goal form: a modal Dialog styled as a wide side panel. */
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
            ? [h.div([...render.backdrop, h.Class("fk-backdrop")]), h.div([...render.panel, h.Class("fk-drawer fk-goals")], content(model, render, h))]
            : [],
        ),
    },
    toParentMessage: (message: Dialog.Message) => Message.GotDialogMessage({ message }),
  }),
);

/** The navbar button that opens the goal form. */
export const navButton = Submodel.defineView<Model, Message>((_model, h) =>
  Button.view(
    {
      onClick: Message.ClickedOpenGoals(),
      toView: (attributes) => h.button([...attributes.button, h.AriaLabel("Open factory goals"), h.Title("Factory goals")], ["◎ Goals"]),
    },
    h,
  ),
);
