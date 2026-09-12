import assert, { deepStrictEqual } from "node:assert/strict"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import React from "react"
import { render } from "ink"

import { parseProfileGuide } from "@trellage/guide-core"
import { defaultGuideModelRouting } from "../../src/guide-api.ts"
import { parseGuideCatalog } from "../../src/guide-catalog.ts"
import { executeGuideUiResult } from "../../src/guide-interactive-execution.ts"
import type { CommandRunner } from "../../src/guide-launch.ts"
import { checkSelectedProfileReadiness } from "../../src/guide-preflight.ts"
import type { GuideProvider } from "../../src/guide-provider.ts"
import { createInitialGuideRenderHandler } from "../../src/guide-terminal.ts"
import { GuideApp, type GuideUiResult } from "../../src/guide-ui.tsx"
import {
  FixtureMode,
  codebaseIntent,
  fixtureProfile,
  fixtureProfilesForMode,
  generatedCandidates,
  generatedGoalApproaches,
  goalRecommendationIds,
  guideSource,
  recommendationIds,
  repositoryPack,
  type FixtureEvent,
} from "./guide-integration-data.ts"
import { createFixtureGoalReadinessServices, createFixtureRunner } from "./guide-integration-runner.ts"
import { createFixtureGoalProvider } from "./guide-goal-provider.ts"
import { createFixtureGoalModelProvider } from "./guide-goal-model.ts"

assert(process.versions.bun, "Guide integration fixtures must execute with Bun")
const root = process.argv[2]
if (root === undefined) throw new Error("guide integration fixture requires a workspace")
const mode = Object.values(FixtureMode).find((value) => value === process.argv[3])
if (mode === undefined) throw new Error("guide integration fixture requires a known mode")
const fixtureProfiles = fixtureProfilesForMode(mode)
const events: FixtureEvent[] = []
const eventPath = path.join(root, "events.jsonl")
await writeFile(eventPath, "", { mode: 0o600 })
const record = async (event: FixtureEvent): Promise<void> => {
  events.push(event)
  await appendFile(eventPath, `${JSON.stringify(event)}\n`)
}
let releaseReadiness!: () => void
const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve })
// Acknowledge consumed keys even when they intentionally produce no redraw.
const recordInput = (input: Buffer | string): void => {
  if (mode === FixtureMode.ParkedReadiness && input.toString() === "\u0012") releaseReadiness()
  void record({ kind: "input", input: input.toString() }).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
process.stdin.on("data", recordInput)
const headless = {
  schemaVersion: 1,
  prompt: true,
  outputFormats: ["json"],
  eventContract: null,
  trellageEventContract: null,
  sessionId: "native",
  resume: false,
  resumeWithPrompt: false,
  questionToolControl: "hard-deny",
  changedFiles: "native",
  usage: true,
  cost: true,
  modelOverride: false,
  effortOverride: false,
  testedHarnessVersion: null,
}
const guideRoot = path.join(root, "guides")
const parsedGuides = new Map(
  fixtureProfiles.map((profile) => [
    profile.ref,
    parseProfileGuide(
      profile.surface === "native"
        ? `native/${profile.launcher}/${profile.name}.md`
        : `sandbox/${profile.name}.md`,
      guideSource(profile),
    ),
  ]),
)
const catalog = parseGuideCatalog(
  JSON.stringify({
    schemaVersion: 1,
    sandboxCommandPath: path.join(root, "bin", "trellage"),
    native: fixtureProfiles
      .filter((profile) => profile.surface === "native")
      .map((profile) => ({
        launcher: profile.launcher,
        harness: profile.harness,
        name: profile.name,
        description: `${profile.name} integration fixture`,
        commandPath: path.join(root, "bin", profile.launcher),
        guide: parsedGuides.get(profile.ref)?.guide,
        sandbox: false,
        herdrCompatibility: { status: "supported" },
        headless,
      })),
    sandbox: fixtureProfiles
      .filter((profile) => profile.surface === "sandbox")
      .map((profile) => ({
        name: profile.name,
        description: `${profile.name} integration fixture`,
        path: path.join(root, "profiles", profile.name, "profile.toml"),
        guide: parsedGuides.get(profile.ref)?.guide,
        supportedPlatforms: ["linux/amd64"],
        harness: { kind: profile.harness, version: "1.0.0" },
        resolutionPolicy: "floating",
        locallyResolved: false,
        releaseLockAvailable: false,
        skillBundles: ["sandbox-common"],
        skillsMode: "floating",
        finalDigestLocked: false,
        skills: [],
        plugins: [],
        mcps: [],
        sandbox: true,
        headless,
        locked: false,
        herdrCompatibility: { status: "supported" },
      })),
  }),
)
for (const profile of fixtureProfiles) {
  const directory =
    profile.surface === "native"
      ? path.join(guideRoot, "native", profile.launcher)
      : path.join(root, "profile-guides", "sandbox")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${profile.name}.md`), guideSource(profile))
}

const goalModelProvider = await createFixtureGoalModelProvider(root, record)
const provider: GuideProvider = {
  async match(input) {
    if (input.goal === undefined) {
      deepStrictEqual(
        input.entries.map((entry) => entry.ref).sort(),
        fixtureProfiles.map((profile) => profile.ref).sort(),
      )
    } else {
      assert(input.entries.length > 0, "Goal matching must supply eligible profiles")
      for (const entry of input.entries) {
        assert(
          fixtureProfiles.find((profile) => profile.ref === entry.ref)?.goalExecution !== undefined,
          `Unsupported profile supplied for goal matching: ${entry.ref}`,
        )
      }
    }
    const ids = input.goal === undefined
      ? recommendationIds
      : goalRecommendationIds.filter((id) => input.entries.some((entry) => entry.ref === fixtureProfile(id).ref))
    const candidates = ids.map((id, index) => {
      const profile = fixtureProfile(id)
      return {
        profileRef: profile.ref,
        workflowId: profile.workflowId,
        confidence: 0.95 - index * 0.1,
        reason: `Use the ${profile.name} profile.`,
        tradeoff: "Fixture response; no model call.",
      }
    })
    await record({
      kind: "match",
      intent: input.intent,
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      profileRefs: input.entries.map((entry) => entry.ref),
      recommendations: candidates.map((candidate) => candidate.profileRef),
    })
    return input.goal === undefined ? { candidates } : goalModelProvider("match", { candidates }).match(input)
  },
  async generate(input) {
    const profile = fixtureProfiles.find((entry) => entry.ref === input.profileRef)
    assert(profile !== undefined, `Unexpected generated profile: ${input.profileRef}`)
    deepStrictEqual(input.workflowId, profile.workflowId)
    deepStrictEqual(input.guide, parsedGuides.get(profile.ref)?.guide)
    deepStrictEqual(input.guideBody, parsedGuides.get(profile.ref)?.body)
    const candidates = input.goal === undefined
      ? generatedCandidates(profile, input.intent)
      : generatedGoalApproaches(profile)
    await record({
      kind: "generate",
      input: {
        intent: input.intent,
        profileRef: input.profileRef,
        workflowId: input.workflowId,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
      },
      candidates,
    })
    return input.goal === undefined ? { candidates } : goalModelProvider("generate", { candidates }).generate(input)
  },
  async optimize(input) {
    const profile = fixtureProfiles.find((entry) => entry.ref === input.profileRef)
    assert(profile !== undefined, `Unexpected optimized profile: ${input.profileRef}`)
    deepStrictEqual(input.targetTool, profile.harness)
    if (input.goalExecution === undefined) {
      deepStrictEqual(
        input.fixedFrame,
        profile.skill === undefined ? undefined : { beforeBody: profile.beforeBody, afterBody: profile.afterBody },
      )
    } else {
      deepStrictEqual(input.candidates, generatedGoalApproaches(profile))
      deepStrictEqual(input.goal, input.goalExecution.goal)
      deepStrictEqual(input.fixedFrame, { beforeBody: profile.beforeBody, afterBody: profile.afterBody })
      deepStrictEqual(input.goalExecution.controller, profile.goalExecution?.controller)
      deepStrictEqual(
        input.goalExecution.workflow,
        parsedGuides.get(profile.ref)?.guide.workflows.find((workflow) => workflow.id === profile.workflowId),
      )
    }
    const candidates = input.candidates.map((candidate) => ({
      ...candidate,
      prompt: `${candidate.prompt}\nReport the findings.`,
    }))
    await record({ kind: "optimize", input, candidates })
    return input.goalExecution === undefined ? { candidates } : goalModelProvider("optimize", { candidates }).optimize(input)
  },
  async refine() {
    throw new Error("Unexpected refinement in the integration matrix")
  },
  async enrich(input) {
    deepStrictEqual(input.pack, repositoryPack)
    const intent = codebaseIntent(input.intent)
    await record({ kind: "enrich", input, intent })
    return { intent }
  },
}

const fixtureRunner = createFixtureRunner(root, mode, record)
// Ctrl-R releases held inventory responses in the parked-readiness scenario.
const runner: CommandRunner = mode === FixtureMode.ParkedReadiness ? {
  async run(executable, args, options) {
    const result = await fixtureRunner.run(executable, args, options)
    if (args[0] === "inventory") await readinessGate
    return result
  },
} : fixtureRunner
const goalReadinessServices = createFixtureGoalReadinessServices(root, record)
const writes: string[] = []
const instance = render(
  <GuideApp
    catalog={catalog}
    guideRoot={guideRoot}
    provider={provider}
    goalProvider={createFixtureGoalProvider(mode, record)}
    goalReadinessServices={goalReadinessServices}
    routing={defaultGuideModelRouting}
    runner={runner}
    cwd={root}
    herdrEnv={mode === FixtureMode.Terminal ? {} : { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "9", HERDR_PANE_ID: "9-0" }}
    herdrAvailabilityProbe={mode !== FixtureMode.Terminal}
  />,
  {
    stdin: process.stdin,
    stdout: process.stderr,
    interactive: true,
    exitOnCtrlC: false,
    kittyKeyboard: { mode: "disabled" },
    alternateScreen: true,
    onRender: createInitialGuideRenderHandler((text) => process.stderr.write(text), true),
    maxFps: 30,
  },
)
try {
  const result = (await instance.waitUntilExit()) as GuideUiResult
  const exitCode = await executeGuideUiResult(result, {
    runner,
    checkReadiness: (runner, profile, cwd, signal, goal) =>
      checkSelectedProfileReadiness(runner, profile, cwd, signal, goal, goalReadinessServices),
    write: (text) => writes.push(text),
    runInteractive: async (command, options) => {
      await record({
        kind: "interactive-launch",
        command,
        cwd: options.cwd,
        automation: options.env.TRELLAGE_AUTOMATION,
      })
    },
  })
  await writeFile(path.join(root, "result.json"), JSON.stringify({ result, events, writes }), { mode: 0o600 })
  if (exitCode === 1) console.error(writes.join(""))
  process.exitCode = exitCode
} finally {
  process.stdin.off("data", recordInput)
  instance.cleanup()
}
