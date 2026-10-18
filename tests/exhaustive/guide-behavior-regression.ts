import assert from "node:assert/strict"
import path from "node:path"
import { guideWorld } from "./guide-world.ts"
import { installGuideModelFixture } from "./guide-model-fixture.ts"

const root = path.resolve(import.meta.dir, "../..")
const fixture = await installGuideModelFixture()
const world = await guideWorld(root)
const { runGuideJsonCommand } = await import("../../packages/trellage-launcher/src/guide-command.ts")
let ordinal = 0n
const results: unknown[] = []
try {
  for (const optimize of [false, true])
    for (const profile of world.catalog.native) {
      fixture.configure({ fallback: false, optimize })
      const ref = `native:${profile.launcher}/${profile.name}`
      const before = fixture.audit.snapshot()
      await world.withCase(ordinal++, async (cwd) => {
        const response: any = await runGuideJsonCommand({
          argv: ["--json", "--intent", "Fix the parser", "--profile", ref],
          catalog: world.catalog,
          guideRoot: world.guideRoot,
          promptMasterSkillDirectory: world.promptMasterSkillDirectory,
          cwd,
          env: { HOME: world.root, TYPESAFE_API_KEY: "fixture-not-a-secret" },
        })
        fixture.audit.assertClean()
        assert.equal(response.profile.ref, ref)
        assert.equal(response.model, fixture.providerRouting()!.generate.model)
        assert.equal(response.effort, fixture.providerRouting()!.generate.effort)
        assert.equal(response.candidates.length, 3)
        const after = fixture.audit.snapshot()
        assert.equal((after["copilot.generate"] ?? 0) - (before["copilot.generate"] ?? 0), 1)
        assert.equal((after["copilot.optimize"] ?? 0) - (before["copilot.optimize"] ?? 0), optimize ? 1 : 0)
        results.push({ ref, optimize, status: "passed" })
      })
    }
  for (const fallback of [false, true]) {
    fixture.configure({ fallback, optimize: true })
    await world.withCase(ordinal++, async (cwd) => {
      const response: any = await runGuideJsonCommand({
        argv: ["--json", "--intent", "Fix the parser"],
        catalog: world.catalog,
        guideRoot: world.guideRoot,
        promptMasterSkillDirectory: world.promptMasterSkillDirectory,
        cwd,
        env: {
          HOME: world.root,
          ...(fallback ? {} : { TYPESAFE_API_KEY: "fixture-not-a-secret" }),
        },
      })
      fixture.audit.assertClean()
      assert.deepEqual(
        response.recommendations.map(({ ref, workflowId, confidence }: any) => ({
          profileRef: ref,
          workflowId,
          confidence,
        })),
        fixture.expectedMatches(),
      )
      assert.equal(response.execution.backend, fallback ? "copilot" : "jev")
      results.push({ matching: true, fallback, status: "passed" })
    })
  }
  const calls = fixture.audit.snapshot()
  const { createLiveCopilotClient } = await import("../../packages/trellage-launcher/src/provider-clients.ts")
  try {
    createLiveCopilotClient({})
  } catch {}
  assert.throws(() => fixture.audit.assertClean(), /Unexpected mock interaction/)
  assert.throws(() => fixture.configure({ fallback: true, optimize: true }), /Unexpected mock interaction/)
  console.log(
    JSON.stringify({
      status: "passed",
      scope:
        "Every catalog profile with both optimization outcomes, Jev and fallback matching, persistent caught-violation canary; not the Cartesian option matrix.",
      results,
      calls,
      caughtViolationStillFails: true,
    }),
  )
} finally {
  await world.dispose()
}
console.log(`Integrated guide fixture PASS: ${results.length} behavior cases and caught-violation canary`)
