import { describe, expect, it } from "vitest"

import { GuideEffort, parseGuideHeadlessArgv } from "../src/guide-api.js"
import { resolveGuideRequest } from "../src/guide-command.js"

describe("guide command request resolution", () => {
  it("uses stdin JSON when argv omits intent", () => {
    const args = parseGuideHeadlessArgv(["--json"])
    expect(
      resolveGuideRequest(
        args,
        '{"schemaVersion":1,"intent":"Write a post","profile":"sandbox:claude-social-media"}',
        {},
      ),
    ).toMatchObject({
      request: {
        intent: "Write a post",
        profile: "sandbox:claude-social-media",
      },
      model: "mai-code-1.1-flash",
      effort: GuideEffort.Medium,
    })
  })

  it("gives explicit argv overrides precedence over stdin request fields", () => {
    const args = parseGuideHeadlessArgv([
      "--json",
      "--profile",
      "native:cpx/awesome",
      "--model",
      "mai-code-1.1-flash",
      "--effort",
      "high",
    ])
    expect(
      resolveGuideRequest(
        args,
        '{"schemaVersion":1,"intent":"Find a skill","profile":"sandbox:other","model":"other","effort":"low"}',
        {},
      ),
    ).toMatchObject({
      request: {
        intent: "Find a skill",
        profile: "native:cpx/awesome",
        model: "mai-code-1.1-flash",
        effort: GuideEffort.High,
      },
      model: "mai-code-1.1-flash",
      effort: GuideEffort.High,
    })
  })

  it("uses environment values when the request has no override", () => {
    const args = parseGuideHeadlessArgv(["--json", "--intent", "Plan this"])
    expect(
      resolveGuideRequest(args, undefined, {
        TRELLAGE_GUIDE_MODEL: "claude-sonnet-5",
        TRELLAGE_GUIDE_EFFORT: "xhigh",
      }),
    ).toMatchObject({
      model: "claude-sonnet-5",
      effort: GuideEffort.XHigh,
    })
  })
})
