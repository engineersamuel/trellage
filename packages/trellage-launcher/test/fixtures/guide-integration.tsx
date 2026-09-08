import assert, { deepStrictEqual } from "node:assert/strict"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import React from "react"
import { render } from "ink"

import { parseProfileGuide } from "../../../trellage-guide-core/dist/index.js"
import { defaultGuideModelRouting } from "../../src/guide-api.js"
import { parseGuideCatalog } from "../../src/guide-catalog.js"
import { executeGuideUiResult } from "../../src/guide-interactive-execution.js"
import type { GuideProvider } from "../../src/guide-provider.js"
import { createInitialGuideRenderHandler } from "../../src/guide-terminal.js"
import { GuideApp, type GuideUiResult } from "../../src/guide-ui.js"
import {
  FixtureMode,
  codebaseIntent,
  fixtureProfile,
  fixtureProfiles,
  generatedCandidates,
  guideSource,
  recommendationIds,
  repositoryPack,
  type FixtureEvent,
} from "./guide-integration-data.js"
import { createFixtureRunner } from "./guide-integration-runner.js"

const root = process.argv[2]
if (root === undefined) throw new Error("guide integration fixture requires a workspace")
const mode = Object.values(FixtureMode).find((value) => value === process.argv[3])
if (mode === undefined) throw new Error("guide integration fixture requires a known mode")
const events: FixtureEvent[] = []
const eventPath = path.join(root, "events.jsonl")
await writeFile(eventPath, "", { mode: 0o600 })
const record = async (event: FixtureEvent): Promise<void> => {
  events.push(event)
  await appendFile(eventPath, `${JSON.stringify(event)}\n`)
}
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
  fixtureProfiles.map((profile) => [profile.ref, parseProfileGuide(`${profile.name}.md`, guideSource(profile))]),
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

const provider: GuideProvider = {
  async match(input) {
    deepStrictEqual(
      input.entries.map((entry) => entry.ref).sort(),
      fixtureProfiles.map((profile) => profile.ref).sort(),
    )
    const candidates = recommendationIds.map((id, index) => {
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
      profileRefs: input.entries.map((entry) => entry.ref),
      recommendations: candidates.map((candidate) => candidate.profileRef),
    })
    return { candidates }
  },
  async generate(input) {
    const profile = fixtureProfiles.find((entry) => entry.ref === input.profileRef)
    assert(profile !== undefined, `Unexpected generated profile: ${input.profileRef}`)
    deepStrictEqual(input.workflowId, profile.workflowId)
    deepStrictEqual(input.guide, parsedGuides.get(profile.ref)?.guide)
    deepStrictEqual(input.guideBody, parsedGuides.get(profile.ref)?.body)
    const candidates = generatedCandidates(profile, input.intent)
    await record({
      kind: "generate",
      input: { intent: input.intent, profileRef: input.profileRef, workflowId: input.workflowId },
      candidates,
    })
    return { candidates }
  },
  async optimize(input) {
    const profile = fixtureProfiles.find((entry) => entry.ref === input.profileRef)
    assert(profile !== undefined, `Unexpected optimized profile: ${input.profileRef}`)
    deepStrictEqual(input.targetTool, profile.harness)
    deepStrictEqual(
      input.fixedFrame,
      profile.skill === undefined ? undefined : { beforeBody: profile.beforeBody, afterBody: profile.afterBody },
    )
    const candidates = input.candidates.map((candidate) => ({
      ...candidate,
      prompt: `${candidate.prompt}\nReport the findings.`,
    }))
    await record({ kind: "optimize", input, candidates })
    return { candidates }
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

const runner = createFixtureRunner(root, mode, record)
const writes: string[] = []
const instance = render(
  <GuideApp
    catalog={catalog}
    guideRoot={guideRoot}
    provider={provider}
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
  process.exitCode = exitCode
} finally {
  instance.cleanup()
}
