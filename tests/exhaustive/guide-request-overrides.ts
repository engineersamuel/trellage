import assert from "node:assert/strict"
import path from "node:path"
import {
  GuideEffort,
  defaultGuideModelRouting,
  parseGuideHeadlessArgv,
} from "../../packages/trellage-launcher/src/guide-api.ts"
import { resolveGuideRequest } from "../../packages/trellage-launcher/src/guide-command.ts"
import { GuideValidationError } from "../../packages/trellage-launcher/src/guide-text.ts"
import { captureSourceIdentity } from "./source-identity.ts"

if (process.env.TRELLAGE_TEST_OFFLINE !== "1") throw Error("Offline wrapper required")
const identity = captureSourceIdentity(path.resolve(import.meta.dir, "../.."))
const profiles = [undefined, "native:pi/clean", "", null]
const models = [undefined, "gpt-5.6-sol", "", null]
const efforts = [undefined, ...Object.values(GuideEffort), "", null]
const workflows = [undefined, "review", "", null]
let checked = 0
let rejected = 0
let accepted = 0
const outcomes: Record<string, number> = {}
for (const profile of profiles)
  for (const model of models)
    for (const effort of efforts)
      for (const workflowId of workflows)
        for (let switches = 0; switches < 32; switches++) {
          const cliIntent = Boolean(switches & 1)
          const cliProfile = Boolean(switches & 2)
          const cliModel = Boolean(switches & 4)
          const cliEffort = Boolean(switches & 8)
          const environment = Boolean(switches & 16)
          const argv = [
            "--json",
            ...(cliIntent ? ["--intent", "CLI intent"] : []),
            ...(cliProfile ? ["--profile", "native:codex/default"] : []),
            ...(cliModel ? ["--model", "gpt-6-sol"] : []),
            ...(cliEffort ? ["--effort", "high"] : []),
          ]
          const payload = { schemaVersion: 2, intent: "JSON intent", profile, model, effort, workflowId }
          const invalidField = [profile, model, effort, workflowId].some((value) => value === null || value === "")
          const missingProfile = workflowId !== undefined && profile === undefined && !cliProfile
          const shouldReject = !cliIntent && (invalidField || missingProfile)
          const args = parseGuideHeadlessArgv(argv)
          const env = environment ? { TRELLAGE_GUIDE_MODEL: "gpt-5.6-luna", TRELLAGE_GUIDE_EFFORT: "low" } : {}
          let result: ReturnType<typeof resolveGuideRequest> | undefined
          try {
            result = resolveGuideRequest(args, JSON.stringify(payload), env)
          } catch (error) {
            assert.ok(shouldReject, `Unexpected rejection for ${JSON.stringify({ payload, argv, env })}: ${error}`)
            assert.ok(error instanceof GuideValidationError)
            rejected++
          }
          if (result !== undefined) {
            assert.equal(shouldReject, false, `Unexpected acceptance for ${JSON.stringify({ payload, argv, env })}`)
            const expected: Record<string, unknown> = {
              schemaVersion: 2,
              intent: cliIntent ? "CLI intent" : "JSON intent",
            }
            if (!cliIntent) {
              for (const [key, value] of Object.entries({ profile, model, effort, workflowId }))
                if (value !== undefined) expected[key] = value
            }
            if (cliProfile) expected.profile = "native:codex/default"
            if (cliModel) expected.model = "gpt-6-sol"
            if (cliEffort) expected.effort = "high"
            assert.deepEqual(result.request, expected)
            for (const phase of Object.keys(defaultGuideModelRouting) as (keyof typeof defaultGuideModelRouting)[]) {
              assert.deepEqual(result.routing[phase], {
                model: expected.model ?? (environment ? "gpt-5.6-luna" : defaultGuideModelRouting[phase].model),
                effort: expected.effort ?? (environment ? "low" : defaultGuideModelRouting[phase].effort),
              })
            }
            accepted++
          }
          checked++
          const key = `${cliIntent ? "cli-intent" : "json-intent"}:${shouldReject ? "rejected" : "accepted"}`
          outcomes[key] = (outcomes[key] ?? 0) + 1
        }
assert.equal(checked, profiles.length * models.length * efforts.length * workflows.length * 32)
assert.equal(checked, accepted + rejected)
identity.assertUnchanged()
const describe = (values: readonly unknown[]) =>
  values.map((value) => (value === undefined ? { kind: "omitted" } : { kind: "value", value }))
const report = {
  status: "passed",
  checked,
  accepted,
  rejected,
  outcomes,
  sourceIdentity: identity.sha256,
  domains: {
    profiles: describe(profiles),
    models: describe(models),
    efforts: describe(efforts),
    workflows: describe(workflows),
    switches: ["cliIntent", "cliProfile", "cliModel", "cliEffort", "environment"],
  },
  scope:
    "Complete product of these request-resolution domains through real argv/request parsers and routing. No model calls. Not full guide execution or the declared exhaustive command matrix; goal and originalIntent fields remain outside this audit.",
}
console.log(JSON.stringify(report))
