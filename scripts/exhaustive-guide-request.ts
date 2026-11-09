import assert from "node:assert/strict"
import {
  defaultGuideModelRouting,
  resolveGuideModelRouting,
  type GuideHeadlessArgs,
} from "../packages/trellage-launcher/src/guide-api.ts"
import { resolveGuideRequest } from "../packages/trellage-launcher/src/guide-command.ts"

export const expectedGuideRouting = (model?: string, effort?: string) =>
  Object.fromEntries(
    Object.entries(defaultGuideModelRouting).map(([phase, defaults]) => [
      phase,
      {
        model: model ?? defaults.model,
        effort: effort ?? defaults.effort,
      },
    ]),
  )

export const guideStdinFixture = {
  schemaVersion: 2,
  intent: "Fixture intent from stdin",
  profile: "native:codex/default",
  model: "stdin-model",
  effort: "high",
} as const

const assertGuideJsonResolution = (
  args: GuideHeadlessArgs,
  environment: Readonly<Record<string, string | undefined>>,
  id: string,
): void => {
  const expected = {
    ...(args.intent === undefined ? guideStdinFixture : { schemaVersion: 2, intent: args.intent }),
    ...(args.profile === undefined ? {} : { profile: args.profile }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
  }
  const resolved = resolveGuideRequest(args, JSON.stringify(guideStdinFixture), environment)
  assert.deepEqual(resolved.request, expected, `${id}: JSON request precedence`)
  const model = "model" in expected ? expected.model : undefined,
    effort = "effort" in expected ? expected.effort : undefined
  assert.deepEqual(
    resolved.routing,
    expectedGuideRouting(model ?? environment.TRELLAGE_GUIDE_MODEL, effort ?? environment.TRELLAGE_GUIDE_EFFORT),
    `${id}: JSON model routing`,
  )
}

export const assertGuideRequestResolution = (args: GuideHeadlessArgs, id: string): void => {
  if (args.help) return
  for (const environment of [{}, { TRELLAGE_GUIDE_MODEL: "environment-model", TRELLAGE_GUIDE_EFFORT: "low" }]) {
    assert.deepEqual(
      resolveGuideModelRouting(
        {
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.effort === undefined ? {} : { effort: args.effort }),
        },
        environment,
      ),
      expectedGuideRouting(
        args.model ?? environment.TRELLAGE_GUIDE_MODEL,
        args.effort ?? environment.TRELLAGE_GUIDE_EFFORT,
      ),
      id,
    )
    if (args.json) assertGuideJsonResolution(args, environment, id)
  }
}
