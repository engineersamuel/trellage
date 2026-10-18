import assert from "node:assert/strict"
import path from "node:path"
import { guideWorld } from "./guide-world.ts"
import { createGuideCaseVerifier } from "./guide-case.ts"
import { captureSourceIdentity } from "./source-identity.ts"
import { exhaustiveDomains } from "./domains.ts"
import { guideGoalFixtures } from "./guide-goal-fixtures.ts"

const root = path.resolve(import.meta.dir, "../..")
const identity = captureSourceIdentity(root)
const world = await guideWorld(root)
try {
  const declaration = await exhaustiveDomains(root)
  const workflowIds = new Set(
    declaration.matrices.guide.find((domain) => domain.name === "json-workflow")!.values.map(({ id }) => id),
  )
  for (const entry of world.catalog.native)
    for (const { id } of entry.guide.workflows)
      assert.ok(
        workflowIds.has(`id:${id}`),
        `Catalog workflow missing from matrix: ${entry.launcher}/${entry.name}/${id}`,
      )
  const verify = await createGuideCaseVerifier(world)
  const profile = world.catalog.native[0]!
  const ref = `native:${profile.launcher}/${profile.name}`
  const workflow = `id:${profile.guide.workflows[0]!.id}`
  const unsupported = world.catalog.native.find((entry) => entry.guide.goalExecution === undefined)!
  const cases = [
    { argv: ["--json"], values: { "json-goal": "null" }, outcome: "json-input-rejected" },
    {
      argv: ["--json"],
      values: {
        "json-goal": "minimum-criteria",
        "json-profile": `native:${unsupported.launcher}/${unsupported.name}`,
      },
      outcome: "goal-incompatible",
    },
    { argv: ["--json"], values: { "json-goal": "minimum-criteria" }, outcome: "goal-matched" },
    {
      argv: ["--json", "--intent", "CLI intent"],
      values: { "--intent": "representative", "json-goal": "null" },
      outcome: "matched",
    },
    ...world.catalog.native
      .filter((entry) => entry.guide.goalExecution !== undefined)
      .flatMap((entry) => {
        const profileRef = `native:${entry.launcher}/${entry.name}`
        return [
          ...entry.guide.goalExecution!.workflowIds.map((id) => ({
            argv: ["--json"],
            values: {
              "json-goal": "minimum-criteria",
              "json-profile": profileRef,
              "json-workflow": `id:${id}`,
            },
            outcome: "goal-generated",
          })),
          {
            argv: ["--json"],
            values: { "json-goal": "maximum-task", "json-profile": profileRef },
            outcome: entry.guide.goalExecution!.controller === "claude-goal" ? "goal-too-large" : "goal-generated",
          },
          {
            argv: ["--json"],
            values: {
              "json-goal": "minimum-criteria",
              "json-profile": profileRef,
              "json-workflow": "unknown",
            },
            outcome: "goal-incompatible",
          },
        ]
      }),
    { argv: ["--json"], values: { "json-workflow": "unknown" }, outcome: "json-input-rejected" },
    {
      argv: ["--json"],
      values: { "json-profile": ref, "json-workflow": "unknown" },
      outcome: "unknown-workflow",
    },
    {
      argv: ["--json"],
      values: { "json-profile": ref, "json-workflow": workflow },
      outcome: "generated",
    },
    {
      argv: ["--json"],
      values: { "json-profile": ref, "json-original-intent": "generation-maximum" },
      outcome: "original-intent-no-room",
    },
    {
      argv: ["--json"],
      values: { "json-profile": ref, "json-original-intent": "generation-over-maximum" },
      outcome: "original-intent-too-large",
    },
    {
      argv: ["--json"],
      values: { "json-original-intent": "over-maximum" },
      outcome: "json-input-rejected",
    },
    {
      argv: ["--json", "--intent", "CLI intent"],
      values: {
        "--intent": "representative",
        "json-original-intent": "null",
        "json-workflow": "unknown",
      },
      outcome: "matched",
    },
    { argv: ["--json"], values: { "json-original-intent": "maximum" }, outcome: "matched" },
    {
      argv: ["--json"],
      values: { "json-profile": ref, "json-original-intent": "unicode" },
      outcome: "generated",
    },
    { argv: ["--json"], values: { "json-profile": ref }, outcome: "generated" },
    {
      argv: ["--json"],
      values: { "json-profile": "native:unknown-harness/unknown-profile" },
      outcome: "unknown-profile",
    },
    {
      argv: ["--json"],
      values: { "json-model": "maximum", "json-effort": "max" },
      outcome: "matched",
    },
    {
      argv: ["--json", "--model", "gpt-5.6-sol"],
      values: { "--model": "representative", "json-model": "null" },
      outcome: "json-input-rejected",
    },
    {
      argv: ["--json", "--intent", "Fix from CLI"],
      values: {
        "--intent": "representative",
        "json-profile": "null",
        "json-model": "null",
        "json-effort": "null",
      },
      outcome: "matched",
    },
    {
      argv: ["--json", "--profile", ref],
      values: { "--profile": ref, "json-profile": "null" },
      outcome: "json-input-rejected",
    },
    {
      argv: ["--json", "--profile", ref],
      values: {
        "--profile": ref,
        "json-profile": "native:unknown-harness/unknown-profile",
        "json-effort": "high",
      },
      outcome: "generated",
    },
    { argv: ["--json"], values: { "json-effort": "invalid" }, outcome: "json-input-rejected" },
  ]
  if (process.argv.includes("--all-goals")) {
    for (const goal of guideGoalFixtures) {
      cases.push(
        {
          argv: ["--json"],
          values: { "json-goal": goal.id },
          outcome: !goal.valid ? "json-input-rejected" : goal.id === "omitted" ? "matched" : "goal-matched",
        },
        {
          argv: ["--json", "--intent", "CLI intent"],
          values: { "--intent": "representative", "json-goal": goal.id },
          outcome: "matched",
        },
      )
      for (const entry of world.catalog.native.filter((entry) => entry.guide.goalExecution !== undefined)) {
        for (const id of entry.guide.goalExecution!.workflowIds) {
          cases.push({
            argv: ["--json"],
            values: {
              "json-goal": goal.id,
              "json-profile": `native:${entry.launcher}/${entry.name}`,
              "json-workflow": `id:${id}`,
            },
            outcome: !goal.valid
              ? "json-input-rejected"
              : goal.id === "omitted"
                ? "generated"
                : goal.id === "maximum-task" && entry.guide.goalExecution!.controller === "claude-goal"
                  ? "goal-too-large"
                  : "goal-generated",
          })
        }
      }
    }
  }
  for (const [index, entry] of cases.entries()) {
    const result = await verify(
      {
        id: `request-fields:${index}`,
        argv: entry.argv,
        values: { "--json": "present", ...entry.values },
      },
      BigInt(index),
    )
    assert.equal(result, entry.outcome, `Request-field case ${index}`)
  }
  identity.assertUnchanged()
  console.log(JSON.stringify({ status: "passed", checked: cases.length, sourceIdentity: identity.sha256 }))
} finally {
  await world.dispose()
}
