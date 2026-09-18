import assert from "node:assert/strict"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import React from "react"
import { render } from "ink"
import type { ProfileGuideV1 } from "@trellage/guide-core"
import { defaultGuideModelRouting } from "../../src/guide-api.ts"
import { parseGuideCatalog } from "../../src/guide-catalog.ts"
import type { CommandRunner } from "../../src/guide-launch.ts"
import type { GuideProvider } from "../../src/guide-provider.ts"
import { createInitialGuideRenderHandler } from "../../src/guide-terminal.ts"
import { GuideApp, type GuideUiResult } from "../../src/guide-ui.tsx"
import {
  missingToolsFleet,
  preparationInventory,
  preparationPlan,
  preparationProfile,
  preparationRevision,
  preparedFleet,
} from "../helpers/firstmate-preparation-fixtures.ts"
import type { FixtureEvent } from "./guide-integration-data.ts"
import { beta, instanceProfile, instanceOrchestration, InstanceRunner, MemoryCreationPlans } from "../helpers/firstmate-instance-flow.ts"

const namedInstances = process.env.TRELLAGE_TEST_NAMED_INSTANCES === "1"

const root = process.argv[2]
if (root === undefined) throw new Error("The Firstmate guide fixture requires an isolated workspace.")
const eventPath = path.join(root, "events.jsonl")
const events: FixtureEvent[] = []
await writeFile(eventPath, "", { mode: 0o600 })
const record = async (event: FixtureEvent): Promise<void> => {
  events.push(event)
  await appendFile(eventPath, `${JSON.stringify(event)}\n`)
}
const recordInput = (input: Buffer | string): void => {
  void record({ kind: "input", input: input.toString() }).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
process.stdin.on("data", recordInput)

const guide: ProfileGuideV1 = {
  schemaVersion: 1,
  capabilities: ["fleet-orchestration"],
  bestFor: ["Review a project", "Trace failures"],
  avoidFor: ["Unbounded work", "Changing authentication"],
  prerequisites: [],
  workflows: [{
    id: "review-project", scope: "project", frame: "fixed",
    description: "Review the confirmed project.",
    examples: ["Review project C", "Trace project failures"],
    promptTemplate: "Use the confirmed project. Do not merge.\n\n{{intent}}\n\nReport focused evidence.",
  }],
}
const headless = {
  schemaVersion: 1, prompt: false, outputFormats: [], eventContract: null, trellageEventContract: null,
  sessionId: "none", resume: false, resumeWithPrompt: false, questionToolControl: "none",
  changedFiles: "none", usage: false, cost: false, modelOverride: false, effortOverride: false,
  testedHarnessVersion: null,
}
const commandPath = path.join(root, "bin", "fmx")
const catalog = parseGuideCatalog(JSON.stringify({
  schemaVersion: 1, sandbox: [], sandboxCommandPath: path.join(root, "bin", "trellage"),
  native: [
    ...["default", "pstack-workers"].map((profile) => ({
      launcher: "fmx", harness: "firstmate", name: profile, description: `Firstmate ${profile}`,
      commandPath, guide, headless, sandbox: false, herdrCompatibility: { status: "supported" },
      orchestration: namedInstances && profile === "default" ? instanceOrchestration : preparationProfile(profile).orchestration,
    })),
    {
      launcher: "cdx", harness: "codex", name: "reviewer", description: "Review the project.",
      commandPath: path.join(root, "bin", "cdx"), guide, headless, sandbox: false,
      herdrCompatibility: { status: "supported" },
    },
  ],
}))
const guideRoot = path.join(root, "guides")
for (const entry of catalog.native) {
  const directory = path.join(guideRoot, "native", entry.launcher)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${entry.name}.md`), `---\n${JSON.stringify(guide)}\n---\nReview only the confirmed target.\n`)
}

const provider: GuideProvider = {
  async match(input) {
    const candidates = catalog.native.map((entry, index) => ({
      profileRef: `native:${entry.launcher}/${entry.name}`, workflowId: "review-project",
      confidence: 0.9 - index * 0.1, reason: "Use the confirmed project.", tradeoff: "Requires an explicit fleet action.",
    }))
    await record({
      kind: "match", intent: input.intent, profileRefs: input.entries.map(({ ref }) => ref),
      recommendations: candidates.map(({ profileRef }) => profileRef),
    })
    return { candidates }
  },
  async generate(input) {
    const candidates = ["Check bounded failures.", "Trace error paths.", "Inspect module boundaries."].map((prompt, index) => ({
      title: `Choice ${index + 1}`, prompt, notes: "Synthetic response. No model call.",
    }))
    await record({
      kind: "generate",
      input: {
        intent: input.intent, profileRef: input.profileRef, workflowId: input.workflowId,
        ...(input.bodyBudget === undefined ? {} : { bodyBudget: input.bodyBudget }),
      },
      candidates,
    })
    return { candidates }
  },
  async optimize(input) {
    await record({ kind: "optimize", input, candidates: input.candidates })
    return { candidates: input.candidates }
  },
  async refine() {
    throw new Error("The preparation PTY case does not call a model for refinement.")
  },
}

let installed = false
let namedPreparations = 0
const instanceRunner = new InstanceRunner()
const runner: CommandRunner = {
  async run(executable, args, options) {
    await record({ kind: "command", command: { executable, args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) } })
    assert.equal(executable, commandPath)
    if (namedInstances) {
      if (args[0] === "prepare" && ++namedPreparations === 2) {
        const signal = options?.signal
        assert(signal !== undefined)
        // Return a late result after cancellation to test the generation guard.
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
      return instanceRunner.run(executable, args, options)
    }
    assert.deepEqual(args.slice(0, 5), ["prepare", "default", "--json", "--expected-source-revision", preparationRevision])
    assert.equal(options?.stdin, undefined)
    assert.equal(options?.signal?.aborted, false)
    if (args.length === 7) {
      assert.deepEqual(args.slice(5), ["--install-prerequisites", preparationPlan.identity])
      installed = true
    } else {
      assert.equal(args.length, 5)
    }
    return { stdout: preparationInventory(installed ? preparedFleet() : missingToolsFleet()), stderr: "", exitCode: 0 }
  },
}

const instance = render(
  <GuideApp
    catalog={catalog}
    guideRoot={guideRoot}
    provider={provider}
    routing={defaultGuideModelRouting}
    runner={runner}
    cwd={namedInstances ? `${beta.root}/runtime` : root}
    {...(namedInstances ? { launchOrigin: instanceProfile(beta).firstmateInstanceContext!, firstmateCreationStore: new MemoryCreationPlans() } : {})}
    herdrEnv={{}}
    herdrAvailabilityProbe={false}
  />,
  {
    stdin: process.stdin, stdout: process.stderr, interactive: true, exitOnCtrlC: false,
    kittyKeyboard: { mode: "disabled" }, alternateScreen: true,
    onRender: createInitialGuideRenderHandler((text) => process.stderr.write(text), true), maxFps: 30,
  },
)
try {
  const result = (await instance.waitUntilExit()) as GuideUiResult
  assert.equal(result.action, "cancel")
  await writeFile(path.join(root, "result.json"), JSON.stringify({ result, events, writes: [] }), { mode: 0o600 })
  process.exitCode = 130
} finally {
  process.stdin.off("data", recordInput)
  instance.cleanup()
}
