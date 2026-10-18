import { GuideEffort } from "../../packages/trellage-launcher/src/guide-api.ts"
import { guideStdinCase } from "./guide-stdin.ts"
import { guideGoalFixtures } from "./guide-goal-fixtures.ts"
import type { Domain } from "./matrix.ts"
import { GUIDE_MAX_ORIGINAL_INTENT, GUIDE_MAX_GENERATED_SPEC } from "@trellage/guide-core"

interface RequestFieldValue {
  id: string
  value?: unknown
  rejected: boolean
}
const omitted: RequestFieldValue = { id: "omitted", rejected: false }
const goalValues: readonly RequestFieldValue[] = guideGoalFixtures.map(({ id, value, valid }) => ({
  id,
  value,
  rejected: !valid,
}))
const modelValues: readonly RequestFieldValue[] = [
  omitted,
  { id: "representative", value: "gpt-5.6-sol", rejected: false },
  { id: "maximum", value: "x".repeat(128), rejected: false },
  { id: "empty", value: "", rejected: true },
  { id: "over-maximum", value: "x".repeat(129), rejected: true },
  { id: "invalid", value: "Provider/Model", rejected: true },
  { id: "null", value: null, rejected: true },
]
const effortValues: readonly RequestFieldValue[] = [
  omitted,
  ...Object.values(GuideEffort).map((value) => ({ id: value, value, rejected: false })),
  { id: "empty", value: "", rejected: true },
  { id: "invalid", value: "unknown", rejected: true },
  { id: "null", value: null, rejected: true },
]
const profileValues = (refs: readonly string[]): readonly RequestFieldValue[] => [
  omitted,
  ...refs.map((value) => ({ id: value, value, rejected: false })),
  {
    id: "native:unknown-harness/unknown-profile",
    value: "native:unknown-harness/unknown-profile",
    rejected: false,
  },
  { id: "maximum", value: "x".repeat(256), rejected: false },
  { id: "empty", value: "", rejected: true },
  { id: "over-maximum", value: "x".repeat(257), rejected: true },
  { id: "null", value: null, rejected: true },
]
const workflowValues = (ids: readonly string[]): readonly RequestFieldValue[] => [
  omitted,
  ...ids.map((value) => ({ id: `id:${value}`, value, rejected: false })),
  { id: "unknown", value: "unknown-workflow", rejected: false },
  { id: "maximum", value: "x".repeat(128), rejected: false },
  { id: "over-maximum", value: "x".repeat(129), rejected: true },
  { id: "empty", value: "", rejected: true },
  { id: "null", value: null, rejected: true },
  { id: "control", value: "x\u0001y", rejected: true },
]
const originalValues: readonly RequestFieldValue[] = [
  omitted,
  { id: "representative", value: "Original request", rejected: false },
  { id: "unicode", value: "日本語\nrequest", rejected: false },
  { id: "generation-maximum", value: "x".repeat(GUIDE_MAX_GENERATED_SPEC), rejected: false },
  {
    id: "generation-over-maximum",
    value: "x".repeat(GUIDE_MAX_GENERATED_SPEC + 1),
    rejected: false,
  },
  { id: "maximum", value: "x".repeat(GUIDE_MAX_ORIGINAL_INTENT), rejected: false },
  { id: "over-maximum", value: "x".repeat(GUIDE_MAX_ORIGINAL_INTENT + 1), rejected: true },
  { id: "empty", value: "", rejected: true },
  { id: "whitespace", value: " ", rejected: true },
  { id: "control", value: "x\u0001y", rejected: true },
  { id: "null", value: null, rejected: true },
  { id: "surrogate", value: "\ud800", rejected: true },
]

export const guideRequestFieldDomains = (refs: readonly string[], workflows: readonly string[]): Domain[] => [
  { name: "json-goal", values: goalValues.map(({ id }) => ({ id, argv: [] })) },
  { name: "json-profile", values: profileValues(refs).map(({ id }) => ({ id, argv: [] })) },
  { name: "json-model", values: modelValues.map(({ id }) => ({ id, argv: [] })) },
  { name: "json-effort", values: effortValues.map(({ id }) => ({ id, argv: [] })) },
  { name: "json-workflow", values: workflowValues(workflows).map(({ id }) => ({ id, argv: [] })) },
  { name: "json-original-intent", values: originalValues.map(({ id }) => ({ id, argv: [] })) },
]

const selected = (values: readonly RequestFieldValue[], id: string | undefined): RequestFieldValue => {
  const value = values.find((entry) => entry.id === (id ?? "omitted"))
  if (!value) throw Error(`Undeclared JSON request field value: ${id}`)
  return value
}

export function guideJsonRequestInput(selection: Readonly<Record<string, string>>) {
  const input = guideStdinCase(selection["json-stdin"])
  const profileId = selection["json-profile"]
  const profile = selected(profileValues(profileId?.startsWith("native:") ? [profileId] : []), profileId)
  const model = selected(modelValues, selection["json-model"])
  const effort = selected(effortValues, selection["json-effort"])
  const workflowId = selection["json-workflow"]
  const workflow = selected(workflowValues(workflowId?.startsWith("id:") ? [workflowId.slice(3)] : []), workflowId)
  const original = selected(originalValues, selection["json-original-intent"])
  const goal = selected(goalValues, selection["json-goal"])
  let source = input.source
  // Malformed or non-object input remains malformed in every field combination.
  // Valid objects receive the selected optional fields even when another field is invalid.
  try {
    const payload: unknown = JSON.parse(source)
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      for (const [key, field] of [
        ["profile", profile],
        ["model", model],
        ["effort", effort],
        ["workflowId", workflow],
        ["originalIntent", original],
        ["goal", goal],
      ] as const)
        if (field.id !== "omitted") Object.assign(payload, { [key]: field.value })
      source = JSON.stringify(payload)
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  return {
    ...input,
    source,
    rejected:
      input.rejected ||
      profile.rejected ||
      model.rejected ||
      effort.rejected ||
      workflow.rejected ||
      original.rejected ||
      goal.rejected,
    goal: !goal.rejected
      ? (goal.value as import("../../packages/trellage-launcher/src/guide-goal-augment.ts").GuideGoalDraft | undefined)
      : undefined,
    profile: typeof profile.value === "string" ? profile.value : undefined,
    model: typeof model.value === "string" ? model.value : undefined,
    effort: typeof effort.value === "string" ? effort.value : undefined,
    workflowId: typeof workflow.value === "string" ? workflow.value : undefined,
    originalIntent: typeof original.value === "string" ? original.value : undefined,
  }
}
