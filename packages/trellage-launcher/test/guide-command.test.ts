import { afterEach, describe, expect, it, vi } from "vitest"

import * as guideApi from "../src/guide-api.js"
import { defaultGuideModelRouting, GuideEffort, parseGuideHeadlessArgv } from "../src/guide-api.js"
import { parseGuideCatalog } from "../src/guide-catalog.js"
import { resolveGuideRequest, runGuideJsonCommand } from "../src/guide-command.js"
import * as guidePrompts from "../src/guide-prompts.js"
import { goalDraft } from "./fixtures/goal-me-skill.js"

afterEach(() => vi.restoreAllMocks())

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
      routing: defaultGuideModelRouting,
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
      routing: {
        match: { model: "mai-code-1.1-flash", effort: GuideEffort.High },
        generate: { model: "mai-code-1.1-flash", effort: GuideEffort.High },
        optimize: { model: "mai-code-1.1-flash", effort: GuideEffort.High },
        refine: { model: "mai-code-1.1-flash", effort: GuideEffort.High },
      },
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
      routing: {
        match: { model: "claude-sonnet-5", effort: GuideEffort.XHigh },
        generate: { model: "claude-sonnet-5", effort: GuideEffort.XHigh },
        optimize: { model: "claude-sonnet-5", effort: GuideEffort.XHigh },
        refine: { model: "claude-sonnet-5", effort: GuideEffort.XHigh },
      },
    })
  })

  it("preserves explicit goal fields and the selected workflow through argv overrides", () => {
    const resolved = resolveGuideRequest(
      parseGuideHeadlessArgv(["--json", "--model", "gpt-6-astra"]),
      JSON.stringify({
        schemaVersion: 1,
        intent: "The approved retry goal.",
        goal: goalDraft,
        profile: "native:cdx/superpowers",
        workflowId: "test-driven-development",
      }),
      {},
    )
    expect(resolved.request).toMatchObject({
      model: "gpt-6-astra",
      profile: "native:cdx/superpowers",
      workflowId: "test-driven-development",
      goal: { draft: goalDraft, prompt: "The approved retry goal." },
    })
  })

  it("does not inherit stdin goal mode when an explicit new intent is supplied", () => {
    const resolved = resolveGuideRequest(
      parseGuideHeadlessArgv(["--json", "--intent", "Write a normal prompt"]),
      JSON.stringify({ schemaVersion: 1, intent: "Old goal", goal: goalDraft }),
      {},
    )
    expect(resolved.request).toEqual({ schemaVersion: 1, intent: "Write a normal prompt" })
  })

  it("accepts a stdin workflow when the selected profile is supplied in argv", () => {
    const resolved = resolveGuideRequest(
      parseGuideHeadlessArgv(["--json", "--profile", "native:cdx/superpowers"]),
      JSON.stringify({
        schemaVersion: 1,
        intent: "The approved retry goal.",
        goal: goalDraft,
        workflowId: "test-driven-development",
      }),
      {},
    )
    expect(resolved.request.profile).toBe("native:cdx/superpowers")
    expect(resolved.request.workflowId).toBe("test-driven-development")
    expect(resolved.request.goal?.draft).toEqual(goalDraft)
  })

  it.each(["match", "generate"] as const)("forwards the structured goal to the JSON %s service", async (operation) => {
    const intercepted = new Error("Intercepted at the service boundary.")
    vi.spyOn(guidePrompts, "loadDefaultGuidePrompts").mockResolvedValue({
      match: "Match the goal.", generate: "Generate approaches.", optimize: "Optimize approaches.",
      refine: "Refine an approach.", enrich: "Enrich a prompt.",
    })
    const matching = vi.spyOn(guideApi, "runGuideMatch").mockRejectedValue(intercepted)
    const generation = vi.spyOn(guideApi, "runGuideGenerate").mockRejectedValue(intercepted)
    const stdinRequest = JSON.stringify({
      schemaVersion: 1,
      intent: "The approved retry goal.",
      goal: goalDraft,
      ...(operation === "match" ? {} : {
        profile: "native:cdx/superpowers",
        workflowId: "test-driven-development",
      }),
    })
    await expect(runGuideJsonCommand({
      argv: ["--json"],
      catalog: parseGuideCatalog(JSON.stringify({
        schemaVersion: 1, sandboxCommandPath: "/unused/trellage", native: [], sandbox: [],
      })),
      guideRoot: "/unused/profile-guides",
      promptMasterSkillDirectory: "/unused/prompt-master",
      stdinRequest,
      env: {},
      cwd: import.meta.dirname,
    })).rejects.toBe(intercepted)
    const forwarded = operation === "match" ? matching.mock.calls[0]?.[2] : generation.mock.calls[0]?.[3]
    expect(forwarded).toMatchObject({
      intent: "The approved retry goal.",
      goal: guideApi.parseGuideServiceRequestJson(stdinRequest).goal,
      ...(operation === "match" ? {} : {
        profileRef: "native:cdx/superpowers",
        workflowId: "test-driven-development",
      }),
    })
    expect(matching).toHaveBeenCalledTimes(operation === "match" ? 1 : 0)
    expect(generation).toHaveBeenCalledTimes(operation === "generate" ? 1 : 0)
  })
})
