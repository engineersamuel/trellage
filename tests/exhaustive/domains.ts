import {
  GuideEffort,
  GuideLongPromptVariant,
  guideIntentMaximumLength,
} from "../../packages/trellage-launcher/src/guide-api.ts"
import { forkPreviewVariants } from "../../packages/trellage-launcher/src/fork-preview.tsx"
import { shippedRituals } from "../../packages/trellage-launcher/src/ritual-catalog.ts"
import { commandInventory } from "./inventory.ts"
import { matrixSize, type Domain, type DomainValue } from "./matrix.ts"
import { guideStdinCases } from "./guide-stdin.ts"
import { guideRequestFieldDomains } from "./guide-request-fields.ts"

const omitted: DomainValue = { id: "omitted", argv: [] }
const rootHelp: Domain = {
  name: "root-help",
  values: [omitted, ...["-h", "--help", "help"].map((alias) => ({ id: alias, argv: [], rootArgv: [alias] }))],
}
const flag = (name: string): Domain => ({ name, values: [omitted, { id: "present", argv: [name] }] })
const runFlag = (name: string): Domain => ({
  name,
  values: [...flag(name).values, { id: "repeat", argv: [name, name] }],
})
const values = (name: string, entries: ReadonlyArray<readonly [string, string]>): Domain => ({
  name,
  values: [omitted, ...entries.map(([id, value]) => ({ id, argv: [name, value] }))],
})

const runValues = (name: string, entries: ReadonlyArray<readonly [string, string]>, first: string): Domain => ({
  name,
  values: [
    omitted,
    ...entries.flatMap(([id, value]) => [
      { id, argv: [name, value], optionValues: [value], valueClass: value.startsWith("-") ? "missing-value" : id },
      { id: `${id}:inline`, argv: [`${name}=${value}`], optionValues: [value], valueClass: id },
      {
        id: `${id}:repeat`,
        argv: [name, first, name, value],
        optionValues: [first, value],
        valueClass: value.startsWith("-") ? "missing-value" : id,
      },
      {
        id: `${id}:duplicate`,
        argv: [name, value, name, value],
        optionValues: [value, value],
        valueClass: value.startsWith("-") ? "missing-value" : id,
      },
      {
        id: `${id}:empty-first`,
        argv: [name, "", name, value],
        optionValues: ["", value],
        valueClass: name === "--skill" ? "invalid-earlier" : value.startsWith("-") ? "missing-value" : id,
      },
    ]),
    { id: "missing-value", argv: [name], optionValues: [], valueClass: "missing-value" },
  ],
})

export const exhaustiveDomains = async (root: string) => {
  const inventory = await commandInventory(root)
  const run: Domain[] = [
    rootHelp,
    {
      name: "harness",
      values: [
        omitted,
        ...[...inventory.harnesses, "unknown-harness"].map((name) => ({ id: name, argv: [name] })),
        { id: "empty", argv: [""] },
        { id: "help-short", argv: ["-h"] },
        { id: "help-long", argv: ["--help"] },
        { id: "help-word", argv: ["help"] },
      ],
    },
    {
      name: "profiles",
      values: [
        omitted,
        ...inventory.profiles.map((name) => ({ id: name, argv: [name] })),
        { id: "unknown", argv: ["unknown-profile"] },
        { id: "stacked", argv: ["office", "superpowers"] },
        { id: "duplicate", argv: ["office", "office"] },
        { id: "clean-mixed", argv: ["clean", "office"] },
      ],
    },
    ...[
      "--dry-run",
      "--plan",
      "--no-always",
      "--allow-unproven-isolation",
      "--require-proven-isolation",
      "--continue",
      "--resume",
    ].map(runFlag),
    runValues(
      "--model",
      [
        ["representative", "gpt-5.6-sol"],
        ["provider-qualified", "github-copilot/claude-opus-5.5"],
        ["uji-qualified", "copilot-proxy-rs/gpt-6-astra"],
        ["uji-empty-id", "copilot-proxy-rs/"],
        ["empty", ""],
        ["unicode", "モデル"],
        ["long", "m".repeat(4096)],
        ["flag-shaped", "--help"],
      ],
      "fixture-first-model",
    ),
    runValues(
      "--effort",
      [
        ...inventory.efforts.map((value) => [value, value] as const),
        ["empty", ""],
        ["invalid", "unknown"],
        ["flag-shaped", "--help"],
      ],
      "high",
    ),
    runValues(
      "--skill",
      [
        ["representative", "example/skills:review"],
        ["empty", ""],
        ["missing-name", "example/skills:"],
        ["invalid-path", "../skills:review"],
        ["invalid-owner", "owner_name/skills:review"],
        ["invalid-dot-repository", "example/.:review"],
        ["invalid-parent-repository", "example/..:review"],
        ["dot-prefixed-repository", "example/.github:review"],
        ["hyphenated-owner", "example-team/skills:review"],
        ["flag-shaped", "--help"],
      ],
      "example/skills:initial",
    ),
    {
      name: "resume-id",
      values: [omitted, { id: "representative", argv: ["--resume=session-1"] }, { id: "empty", argv: ["--resume="] }],
    },
    {
      name: "isolation-order",
      values: [
        omitted,
        { id: "require-allow", argv: ["--require-proven-isolation", "--allow-unproven-isolation"] },
        { id: "allow-require", argv: ["--allow-unproven-isolation", "--require-proven-isolation"] },
      ],
    },
    {
      name: "resume-order",
      values: [
        omitted,
        ...[
          ["continue", "pick", "id"],
          ["continue", "id", "pick"],
          ["pick", "continue", "id"],
          ["pick", "id", "continue"],
          ["id", "continue", "pick"],
          ["id", "pick", "continue"],
        ].map((order) => ({
          id: order.join("-"),
          argv: order.map((kind) => ({ continue: "--continue", pick: "--resume", id: "--resume=session-2" })[kind]!),
        })),
      ],
    },
    {
      name: "forwarded",
      values: [
        omitted,
        { id: "empty-separator", argv: ["--"] },
        { id: "prompt-quoting", argv: ["--", "-p", "quote ' $() `literal`\nnext"] },
        { id: "managed-override", argv: ["--", "--model", "override"] },
      ],
    },
  ]
  const profileRefs = inventory.harnesses.flatMap((harness) =>
    inventory.profiles.map((profile) => `native:${harness}/${profile}`),
  )
  const guide: Domain[] = [
    rootHelp,
    { name: "json-stdin", values: guideStdinCases.map(({ id }) => ({ id, argv: [] })) },
    ...guideRequestFieldDomains(profileRefs, inventory.workflows),
    ...[
      "--help",
      "--json",
      "--intent-stdin",
      "--next-steps",
      "--engagement",
      "--review",
      "--optimize",
      "--prompts",
      "--print",
      "--copy",
      "--preview",
    ].map(flag),
    {
      name: "--forks",
      values: [
        omitted,
        { id: "default", argv: ["--forks"] },
        ...forkPreviewVariants.map((variant) => ({ id: variant, argv: ["--forks", variant] })),
        { id: "invalid", argv: ["--forks", "unknown"] },
      ],
    },
    values("--intent", [
      ["representative", "Fix the parser"],
      ["empty", ""],
      ["whitespace", " "],
      ["maximum", "x".repeat(guideIntentMaximumLength)],
      ["over-maximum", "x".repeat(guideIntentMaximumLength + 1)],
      ["multiline-unicode", "Fix parsing\n日本語"],
      ["control", "x\u0001y"],
    ]),
    values("--profile", [
      ...profileRefs.map((ref) => [ref, ref] as const),
      ["empty", ""],
      ["maximum", `native:${"a".repeat(247)}/x`],
      ["over-maximum", "x".repeat(257)],
    ]),
    values("--model", [
      ["representative", "gpt-5.6-sol"],
      ["empty", ""],
      ["maximum", "x".repeat(128)],
      ["over-maximum", "x".repeat(129)],
      ["invalid", "Provider/Model"],
    ]),
    values("--effort", [
      ...Object.values(GuideEffort).map((effort) => [effort, effort] as const),
      ["invalid", "unknown"],
    ]),
    values("--ui-variant", [
      ...Object.values(GuideLongPromptVariant).map((variant) => [variant, variant] as const),
      ["invalid", "unknown"],
    ]),
    values("--base", [
      ["representative", "main"],
      ["empty", ""],
      ["maximum", "x".repeat(256)],
      ["over-maximum", "x".repeat(257)],
    ]),
    {
      name: "positional",
      values: [
        omitted,
        { id: "intent-or-ritual", argv: ["review"] },
        ...shippedRituals.map((ritual) => ({ id: `ritual-${ritual.id}`, argv: [ritual.id] })),
        { id: "empty", argv: [""] },
        { id: "ritual-maximum", argv: ["x".repeat(64)] },
        { id: "ritual-over-maximum", argv: ["x".repeat(65)] },
        { id: "extra", argv: ["first", "second"] },
      ],
    },
  ]
  return {
    inventory,
    matrices: { run, guide },
    counts: { run: matrixSize(run).toString(), guide: matrixSize(guide).toString() },
    boundaries: {
      rootHelp:
        "Omission and each -h/--help/help root alias, placed before the command and combined with every command-specific option state. Root help exits before command parsing or Bun startup.",
      runDispatch:
        "Omitted and empty first operand, every harness, unknown harness, and -h/--help/help aliases; combined with every remaining run domain. The Bash router discards trailing operands after an empty first operand and normalizes help aliases before runtime parsing.",
      runModel:
        "No declared maximum; empty, provider-qualified (including Uji's required copilot-proxy-rs/ID and empty-ID boundary), Unicode, and 4096-character representatives.",
      runValuedSyntax:
        "Model, effort, and skill values each include separated, inline, repeated distinct, duplicate, and empty-first occurrences, plus missing values and flag-shaped values. Scalars retain the last occurrence; skills accumulate and validate every occurrence.",
      runFlagOrder:
        "Every boolean flag is omitted, present, or repeated. Trailing isolation flags include both orders; continue, resume picker, and explicit resume ID include all six orders, crossed with all earlier states. Last occurrence wins; forwarded arguments remain after the separator.",
      runProfiles:
        "Open-ended list; every declared name plus omission, duplicate, stacked, mixed-clean, and unknown representatives.",
      guideIntent: `Empty, whitespace, control, multiline Unicode, ${guideIntentMaximumLength}, and ${guideIntentMaximumLength + 1} characters.`,
      guideJsonStdin:
        "JSON mode without CLI intent reads the selected request: valid default/Unicode/maximum intent, empty or malformed stream, non-object JSON, missing or wrong version, missing/unknown fields, and invalid intent boundaries. CLI intent bypasses stdin. Other modes do not use this JSON-request context.",
      guideJsonFields:
        "JSON profile, model, and effort combine with every other guide domain. Profiles cover every harness/profile reference and unknown, empty, 256/257-character and null values; models cover omission, representative, 128/129-character, invalid, empty and null values; efforts include omission, all enum values, empty, invalid and null. CLI intent ignores the request; otherwise JSON validation precedes CLI field overrides.",
      guideJsonContext:
        "JSON workflow includes omission, every workflow ID parsed from authoritative profile guides, unknown, empty, control, null, and 128/129-character values. A workflow requires an effective profile. Original intent includes omission, representative, Unicode, empty, whitespace, control, null, unpaired surrogate, 8000/8001 and 60000/60001 UTF-16-unit values. Matching ignores valid original intent; generation preserves it or rejects without truncation. An 8000-unit original leaves no room for its required appendix framing, and larger originals exceed the generation limit.",
      guideJsonGoal:
        "23 JSON goal states cross every guide axis: omission, valid minimum/maximum criteria and text boundaries, null, malformed objects, unknown fields, placeholders, duplicate criteria, and over-limit fields. CLI intent bypasses JSON goals. Goal execution verifies controller/workflow compatibility, protected objective fields, and public argv/manual transport. Full Cartesian execution and interactive goal refinement remain unverified.",
      guideProfile: "Every harness/profile reference; empty, 256, and 257 characters.",
      guideModel: "Empty, 128, 129 characters and invalid identifier syntax.",
      guideBase: "Empty, 256, and 257 characters.",
      ritualId:
        "Every shipped ritual ID, omission, unknown representative, empty, 64, 65 characters, and multiple positional arguments.",
    },
  }
}

if (import.meta.main) {
  const root = new URL("../../", import.meta.url).pathname
  const declaration = await exhaustiveDomains(root)
  console.log(
    JSON.stringify(
      {
        counts: declaration.counts,
        harnesses: declaration.inventory.harnesses.length,
        profiles: declaration.inventory.profiles.length,
        boundaries: declaration.boundaries,
      },
      null,
      2,
    ),
  )
}
