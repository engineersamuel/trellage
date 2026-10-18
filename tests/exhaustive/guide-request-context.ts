import { guideGoalFixtures, type Fixture } from "./guide-goal-fixtures.ts"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import path from "node:path"
import { GUIDE_MAX_ORIGINAL_INTENT } from "@trellage/guide-core"
import { parseGuideHeadlessArgv } from "../../packages/trellage-launcher/src/guide-api.ts"
import { resolveGuideRequest } from "../../packages/trellage-launcher/src/guide-command.ts"
import { GuideValidationError } from "../../packages/trellage-launcher/src/guide-text.ts"
import { GuideGoalError } from "../../packages/trellage-launcher/src/guide-goal-augment.ts"
import { captureSourceIdentity } from "./source-identity.ts"

if (process.env.TRELLAGE_TEST_OFFLINE !== "1") throw Error("Offline wrapper required")
const identity = captureSourceIdentity(path.resolve(import.meta.dir, "../.."))
const goals = guideGoalFixtures
const originals: Fixture[] = [
  { id: "omitted", valid: true },
  { id: "text", value: "Original request", valid: true },
  { id: "unicode", value: "日本語\nrequest", valid: true },
  { id: "maximum", value: "x".repeat(GUIDE_MAX_ORIGINAL_INTENT), valid: true },
  ...[
    ["null", null],
    ["empty", ""],
    ["whitespace", " "],
    ["control", "a\u0001b"],
    ["surrogate", "\ud800"],
    ["over", "x".repeat(GUIDE_MAX_ORIGINAL_INTENT + 1)],
  ].map(([id, value]) => ({ id: id as string, value, valid: false })),
]
let checked = 0,
  accepted = 0,
  rejected = 0
for (const goal of goals)
  for (const original of originals)
    for (const cliIntent of [false, true])
      for (const cliProfile of [false, true]) {
        const argv = [
          "--json",
          ...(cliIntent ? ["--intent", "CLI intent"] : []),
          ...(cliProfile ? ["--profile", "native:pi/clean"] : []),
        ]
        const args = parseGuideHeadlessArgv(argv)
        const request = JSON.stringify({
          schemaVersion: 2,
          intent: "JSON intent",
          goal: goal.value,
          originalIntent: original.value,
        })
        const expectedRejection = !cliIntent && (!goal.valid || !original.valid)
        let result: ReturnType<typeof resolveGuideRequest> | undefined
        try {
          result = resolveGuideRequest(args, request, {})
        } catch (error) {
          assert.ok(expectedRejection, `${goal.id}/${original.id}: ${error}`)
          assert.ok(error instanceof GuideValidationError || error instanceof GuideGoalError)
          rejected++
        }
        if (result !== undefined) {
          assert.equal(expectedRejection, false, `${goal.id}/${original.id}: invalid request accepted`)
          assert.equal(result.request.intent, cliIntent ? "CLI intent" : "JSON intent")
          assert.equal(result.request.profile, cliProfile ? "native:pi/clean" : undefined)
          assert.equal(result.request.originalIntent, cliIntent ? undefined : original.value)
          if (cliIntent || goal.value === undefined) assert.equal(result.request.goal, undefined)
          else {
            assert.deepEqual(result.request.goal?.draft, goal.value)
            assert.equal(result.request.goal?.prompt, "JSON intent")
            const expectedFingerprint = createHash("sha256")
              .update(JSON.stringify({ draft: goal.value, prompt: "JSON intent" }))
              .digest("hex")
            assert.equal(result.request.goal?.fingerprint, expectedFingerprint)
            assert.ok(Object.isFrozen(result.request.goal))
            assert.ok(Object.isFrozen(result.request.goal?.draft.criteria))
          }
          accepted++
        }
        checked++
      }
assert.equal(checked, goals.length * originals.length * 4)
assert.equal(checked, accepted + rejected)
identity.assertUnchanged()
const report = {
  status: "passed",
  checked,
  accepted,
  rejected,
  sourceIdentity: identity.sha256,
  domains: {
    goals: goals.map(({ id, valid }) => ({ id, valid })),
    originals: originals.map(({ id, valid }) => ({ id, valid })),
    cliIntent: [false, true],
    cliProfile: [false, true],
  },
  scope:
    "Full product of the declared goal/originalIntent request fixtures and two CLI switches through real request resolution. Not full command execution or the overall exhaustive command matrix.",
}
console.log(JSON.stringify(report))
