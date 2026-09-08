import assert from "node:assert/strict"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { JobPlacement, QueuedGuideJob } from "../src/guide-batch.js"
import type { SelectedProfile } from "../src/guide-launch.js"
import {
  FixtureMode,
  candidateTitles,
  codebaseIntent,
  fixtureBranch,
  fixtureIntent,
  fixtureProfile,
  fixtureProfiles,
  generatedCandidates,
  pinnedIds,
  recommendationIds,
  repositoryPack,
  researchIntent,
  type FixtureEvent,
  type FixtureProfileId,
  type FixtureReport,
  type RecordedCommand,
} from "./fixtures/guide-integration-data.js"
import { createGuideTerminal, type GuideTerminal } from "./helpers/guide-terminal.js"

let bundleRoot: string
let entry: string
beforeAll(async () => {
  bundleRoot = await mkdtemp(path.join(tmpdir(), "trellage-guide-ui-bundle-"))
  entry = path.join(bundleRoot, "guide.mjs")
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/guide-integration.tsx", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: "import { createRequire as __trellageCreateRequire } from 'node:module'; const require = __trellageCreateRequire(import.meta.url);",
    },
    logLevel: "silent",
  })
})
afterAll(async () => {
  if (bundleRoot !== undefined) await rm(bundleRoot, { recursive: true, force: true })
})

const it = test.extend<{ guide: GuideTerminal }>({
  guide: async ({ onTestFailed }, use) => {
    const guide = await createGuideTerminal(entry, onTestFailed)
    try {
      await use(guide)
    } finally {
      await guide.close()
    }
  },
})

const down = "\u001b[B"
const enter = "\r"
const panePlacement: JobPlacement = { kind: "current-workspace-pane", direction: "right" }

interface Selection {
  readonly id: number
  readonly profileId: FixtureProfileId
  readonly candidate: number
  readonly intent: string
  readonly placement: JobPlacement
  readonly appended?: string
}

// Independent command oracles: do not call the production launch or workflow builders.
const launchArguments: Record<FixtureProfileId, ReadonlyArray<string>> = {
  planner: ["planner", "--"],
  reviewer: ["reviewer", "-i"],
  writer: ["writer", "--"],
  builder: ["builder"],
  sandbox: ["--profile", "sandbox-reviewer"],
  council: ["--profile", "claude-council"],
  research: ["--profile", "claude-research"],
  hve: ["hve", "--agent", "hve-core:rpi-agent", "-i"],
}

const expectedPrompt = (selection: Pick<Selection, "profileId" | "candidate" | "intent" | "appended">): string => {
  const profile = fixtureProfile(selection.profileId)
  const title = candidateTitles[selection.candidate]
  assert(title !== undefined)
  return `${profile.beforeBody}${selection.intent}\nProfile: ${profile.ref}\nApproach: ${title.toLowerCase()}.\nReport the findings.${profile.afterBody}${selection.appended ?? ""}`
}

const expectedProfile = (root: string, id: FixtureProfileId): SelectedProfile => {
  const profile = fixtureProfile(id)
  const common = { profile: profile.name, headlessPrompt: true }
  return profile.surface === "native"
    ? {
        ...common,
        surface: "native",
        launcher: profile.launcher,
        commandPath: path.join(root, "bin", profile.launcher),
        ...(profile.agent === undefined ? {} : { agent: profile.agent }),
      }
    : { ...common, surface: "sandbox", commandPath: path.join(root, "bin", "trellage") }
}

const expectedJob = (root: string, selection: Selection): QueuedGuideJob => {
  const profile = expectedProfile(root, selection.profileId)
  const prompt = expectedPrompt(selection)
  return {
    id: selection.id,
    profile,
    prompt,
    command: { executable: profile.commandPath, args: [...launchArguments[selection.profileId], prompt] },
    promptDelivery: "command",
    placement: selection.placement,
  }
}

const quoted = (text: string): string => `'${text.replaceAll("'", "'\"'\"'")}'`
const expectedPaneCommand = (root: string, selection: Selection): string =>
  [
    "env",
    "TRELLAGE_AUTOMATION=1",
    quoted(expectedProfile(root, selection.profileId).commandPath),
    ...launchArguments[selection.profileId],
    quoted(expectedPrompt(selection)),
  ].join(" ")

const readinessCommand = (root: string, id: FixtureProfileId): RecordedCommand => {
  const profile = expectedProfile(root, id)
  return {
    executable: profile.commandPath,
    args:
      profile.surface === "native"
        ? ["inventory", profile.profile, "--json"]
        : ["doctor", "--profile", profile.profile],
    cwd: root,
  }
}

const commandEvents = (events: ReadonlyArray<FixtureEvent>): ReadonlyArray<RecordedCommand> =>
  events.filter((event) => event.kind === "command").map((event) => event.command)

const assertDeferredLaunch = async (guide: GuideTerminal): Promise<void> => {
  const events = await guide.events()
  expect(commandEvents(events).filter((command) => command.executable === "herdr")).toEqual([])
  expect(events.filter((event) => event.kind === "interactive-launch")).toEqual([])
  await expect(access(path.join(guide.root, "result.json"))).rejects.toMatchObject({ code: "ENOENT" })
}

const assertDataflow = (
  report: FixtureReport,
  selections: ReadonlyArray<Selection>,
  matchedIntents: ReadonlyArray<string> = [fixtureIntent],
  enrichedIntents: ReadonlyArray<string> = [],
): void => {
  const matches = report.events.filter((event) => event.kind === "match")
  expect(matches.map((event) => event.intent)).toEqual(matchedIntents)
  for (const match of matches) {
    expect([...match.profileRefs].sort()).toEqual(fixtureProfiles.map((profile) => profile.ref).sort())
    expect(match.recommendations).toEqual(recommendationIds.map((id) => fixtureProfile(id).ref))
  }
  const generated = report.events.filter((event) => event.kind === "generate")
  expect(generated).toEqual(
    selections.map((selection) => {
      const profile = fixtureProfile(selection.profileId)
      return {
        kind: "generate",
        input: { intent: selection.intent, profileRef: profile.ref, workflowId: profile.workflowId },
        candidates: generatedCandidates(profile, selection.intent),
      }
    }),
  )
  expect(generated.flatMap((event) => event.candidates)).toHaveLength(selections.length * 3)
  expect(report.events.filter((event) => event.kind === "optimize")).toEqual(
    selections.map((selection) => {
      const profile = fixtureProfile(selection.profileId)
      const candidates = generatedCandidates(profile, selection.intent)
      return {
        kind: "optimize",
        input: {
          profileRef: profile.ref,
          targetTool: profile.harness,
          candidates,
          ...(profile.skill === undefined
            ? {}
            : { fixedFrame: { beforeBody: profile.beforeBody, afterBody: profile.afterBody } }),
        },
        candidates: candidates.map((candidate) => ({
          ...candidate,
          prompt: `${candidate.prompt}\nReport the findings.`,
        })),
      }
    }),
  )
  expect(report.events.filter((event) => event.kind === "enrich")).toEqual(
    enrichedIntents.map((intent) => ({
      kind: "enrich",
      input: { intent, pack: repositoryPack },
      intent: codebaseIntent(intent),
    })),
  )
}

const gitCommand = (root: string, ...args: ReadonlyArray<string>): RecordedCommand => ({
  executable: "git",
  args: ["--no-pager", "-C", root, ...args],
})

const inspectionCommands = (root: string): ReadonlyArray<RecordedCommand> => [
  gitCommand(root, "check-ref-format", "--branch", fixtureBranch),
  gitCommand(root, "rev-parse", "--show-toplevel"),
  gitCommand(root, "status", "--porcelain"),
  gitCommand(root, "rev-parse", "HEAD"),
  gitCommand(root, "show-ref", "--verify", "--quiet", `refs/heads/${fixtureBranch}`),
  gitCommand(root, "worktree", "list", "--porcelain"),
]

const expectedAllocation = (root: string, selection: Selection, index: number) => {
  const placement = selection.placement
  const ordinal = index + 1
  if (placement.kind === "current-workspace-pane" || placement.kind === "new-tab") {
    return {
      cwd: root,
      workspaceId: "9",
      paneId: `9-${ordinal}`,
      commands: [
        {
          executable: "herdr",
          cwd: root,
          args:
            placement.kind === "new-tab"
              ? ["tab", "create", "--workspace", "9", "--cwd", root, "--no-focus"]
              : ["pane", "split", "--pane", "9-0", "--cwd", root, "--direction", "right", "--no-focus"],
        },
      ],
    }
  }
  const existing = placement.kind === "existing-worktree"
  return {
    cwd: existing ? path.join(root, "worktrees", "existing-canonical") : path.join(root, "worktrees", fixtureBranch),
    workspaceId: String(20 + ordinal),
    paneId: `${20 + ordinal}-1`,
    commands: [
      ...(existing ? [] : [gitCommand(root, "check-ref-format", "--branch", fixtureBranch)]),
      {
        executable: "herdr",
        cwd: root,
        args: existing
          ? ["worktree", "open", "--cwd", root, "--path", placement.path, "--no-focus"]
          : ["worktree", "create", "--cwd", root, "--branch", fixtureBranch, "--base", "HEAD", "--no-focus"],
      },
    ],
  }
}

const assertBatch = (
  guide: GuideTerminal,
  report: FixtureReport,
  selections: ReadonlyArray<Selection>,
  beforeLaunch: ReadonlyArray<RecordedCommand> = [],
): void => {
  const allocated = selections.map((selection, index) => ({
    ...expectedAllocation(guide.root, selection, index),
    selection,
  }))
  expect(report.result).toEqual({
    action: "batch",
    result: {
      entries: allocated.map(({ selection, cwd, paneId, workspaceId }) => ({
        job: expectedJob(guide.root, selection),
        status: "launched",
        cwd,
        paneId,
        workspaceId,
      })),
    },
  })
  expect(commandEvents(report.events)).toEqual([
    ...beforeLaunch,
    ...selections.map((selection) => readinessCommand(guide.root, selection.profileId)),
    ...allocated.flatMap((allocation) => allocation.commands),
    ...allocated.map(({ selection, paneId, cwd }) => ({
      executable: "herdr",
      args: ["pane", "run", paneId, expectedPaneCommand(guide.root, selection)],
      cwd,
    })),
  ])
  expect(
    commandEvents(report.events).filter((command) => command.args[0] === "pane" && command.args[1] === "run"),
  ).toHaveLength(selections.length)
  expect(report.events.filter((event) => event.kind === "interactive-launch")).toEqual([])
}

const assertCurrentTerminal = (guide: GuideTerminal, report: FixtureReport, selection: Selection): void => {
  const job = expectedJob(guide.root, selection)
  expect(report.result).toEqual({
    action: "current-terminal",
    profile: job.profile,
    command: job.command,
    promptHandling: "argv",
    prompt: job.prompt,
    cwd: guide.root,
  })
  expect(commandEvents(report.events)).toEqual([readinessCommand(guide.root, selection.profileId)])
  expect(report.events.filter((event) => event.kind === "interactive-launch")).toEqual([
    { kind: "interactive-launch", command: job.command, cwd: guide.root, automation: "1" },
  ])
  expect(report.writes).toEqual([])
}

const assertCancelledQueue = (report: FixtureReport): void => {
  expect(report.result).toEqual({ action: "cancel", exitCode: 130 })
  expect(commandEvents(report.events)).toEqual([])
  expect(report.events.filter((event) => event.kind === "interactive-launch")).toEqual([])
}

const enterIntent = async (guide: GuideTerminal, intent = fixtureIntent): Promise<void> => {
  await guide.pressAndWait(intent, intent)
  await guide.pressAndWait(enter, "Profile recommendations")
}

const mainScreen = async (guide: GuideTerminal): Promise<number> => {
  if (!guide.text().includes("Profile recommendations")) {
    await guide.pressAndWait("`", "Profile recommendations")
  }
  return guide.readScreen((text) => {
    const selected = recommendationIds.filter((id) => text.includes(`${fixtureProfile(id).ref} |`))
    assert.equal(selected.length, 1, "The recommendations screen must identify exactly one selected profile")
    const id = selected[0]
    assert(id !== undefined)
    return recommendationIds.indexOf(id)
  })
}

const selectCandidate = async (
  guide: GuideTerminal,
  profileId: FixtureProfileId,
  candidate: number,
  intent: string,
): Promise<void> => {
  const promptLines = (index: number): ReadonlyArray<string> =>
    expectedPrompt({ profileId, candidate: index, intent }).split("\n")
  await guide.waitForText("Prompt candidates", ...candidateTitles, ...promptLines(0))
  for (let index = 0; index < 3; index += 1) {
    await guide.pressAndWait(down, ...promptLines((index + 1) % 3))
  }
  for (let index = 0; index < candidate; index += 1) {
    await guide.pressAndWait(down, ...promptLines(index + 1))
  }
}

const selectProfile = async (
  guide: GuideTerminal,
  profileId: FixtureProfileId,
  candidate: number,
  intent = fixtureIntent,
): Promise<void> => {
  const current = await mainScreen(guide)
  const profile = fixtureProfile(profileId)
  if (profile.key === undefined) {
    const target = recommendationIds.indexOf(profileId)
    assert(target >= 0)
    const steps = (target - current + recommendationIds.length) % recommendationIds.length
    for (let moved = 1; moved <= steps; moved += 1) {
      const next = recommendationIds[(current + moved) % recommendationIds.length]
      assert(next !== undefined)
      await guide.pressAndWait(down, `${fixtureProfile(next).ref} |`)
    }
    await guide.waitForText(`${profile.ref} |`)
    guide.press(enter)
  } else {
    guide.press(profile.key)
  }
  await guide.waitForText("Prompt candidates", `Profile: ${profile.ref}`, "Approach: focused.")
  await selectCandidate(guide, profileId, candidate, intent)
}

const queueText = (count: number): string => `Batch queue. ${count} ${count === 1 ? "job" : "jobs"} launch together`
const enqueue = async (guide: GuideTerminal, count: number): Promise<void> => {
  await guide.pressAndWait("a", "Where does this queued job run?")
  await guide.pressAndWait(enter, queueText(count))
}

const randomSource =
  (seed: number) =>
  (limit: number): number => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
    return seed % limit
  }

const queueProfiles = async (
  guide: GuideTerminal,
  ids: ReadonlyArray<FixtureProfileId>,
  seed: number,
): Promise<ReadonlyArray<Selection>> => {
  const random = randomSource(seed)
  const ordered = ids
    .map((id) => ({ id, order: random(0x1_0000_0000) }))
    .sort((left, right) => left.order - right.order)
  const selections: Selection[] = []
  for (const { id: profileId } of ordered) {
    const candidate = random(3)
    await selectProfile(guide, profileId, candidate)
    selections.push({
      id: selections.length + 1,
      profileId,
      candidate,
      intent: fixtureIntent,
      placement: panePlacement,
    })
    await enqueue(guide, selections.length)
  }
  return selections
}

const inspectQueueEntry = async (guide: GuideTerminal, selection: Selection, count: number): Promise<void> => {
  await guide.pressAndWait("o", `Queued prompt ${selection.id} `)
  await guide.waitForText(...expectedPrompt(selection).split("\n"))
  await guide.pressAndWait("b", queueText(count))
}

const selectQueueEntry = async (
  guide: GuideTerminal,
  selections: ReadonlyArray<Selection>,
  current: number,
  target: number,
): Promise<void> => {
  const initial = selections[current]
  assert(initial !== undefined)
  await guide.waitForQueueSelection(initial.id)
  const steps = (target - current + selections.length) % selections.length
  for (let index = 1; index <= steps; index += 1) {
    const next = selections[(current + index) % selections.length]
    assert(next !== undefined)
    guide.press(down)
    await guide.waitForQueueSelection(next.id)
  }
  const selected = selections[target]
  assert(selected !== undefined)
  await inspectQueueEntry(guide, selected, selections.length)
}

const augment = async (
  guide: GuideTerminal,
  kind: "research" | "codebase",
  key: string,
  expected: string,
): Promise<void> => {
  await guide.pressAndWait(key, "Augment your prompt")
  if (kind === "codebase") await guide.pressAndWait(down, "\u276f Codebase")
  await guide.pressAndWait(enter, ...expected.split("\n"))
}

const augmentationCommand = (
  guide: GuideTerminal,
  events: ReadonlyArray<FixtureEvent>,
  kind: "research" | "codebase",
  intent: string,
): RecordedCommand => {
  const commands = commandEvents(events).filter((command) => command.executable === "npx" || command.args[0] === "hve")
  expect(commands).toHaveLength(1)
  const command = commands[0]
  assert(command !== undefined)
  expect(command.cwd).toBe(guide.root)
  if (kind === "research") {
    expect(command.executable).toBe(path.join(guide.root, "bin", "cpx"))
    expect(command.args).toEqual(["hve", "-p", expect.stringContaining(`\n<request>\n${intent}\n</request>`)])
    expect(command.args[2]).toContain("rpi-research")
  } else {
    expect(command.executable).toBe("npx")
    expect(command.args).toEqual([
      "--yes",
      "repomix@latest",
      "--style",
      "markdown",
      "--compress",
      "--ignore",
      expect.stringContaining("**/node_modules/**"),
      "-o",
      expect.stringContaining(path.join(guide.root, "tmp") + path.sep),
    ])
  }
  return command
}

it.for([
  { profileId: "reviewer" as const, candidate: 1, surface: "native" },
  { profileId: "sandbox" as const, candidate: 2, surface: "Sandbox" },
])(
  "hands the selected $surface command to the current-terminal boundary",
  { timeout: 30_000 },
  async ({ profileId, candidate }, { guide }) => {
    await guide.start(FixtureMode.Terminal)
    await enterIntent(guide)
    await selectProfile(guide, profileId, candidate)
    await guide.pressAndWait(enter, "Choose a destination", "This terminal")
    await assertDeferredLaunch(guide)
    const report = await guide.finish(enter)
    const selection = { id: 1, profileId, candidate, intent: fixtureIntent, placement: panePlacement }
    assertCurrentTerminal(guide, report, selection)
    assertDataflow(report, [selection])
  },
)

it("queues all pinned lenses and launches them from the main screen with L", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  const selections = await queueProfiles(guide, pinnedIds, 29)
  await assertDeferredLaunch(guide)
  await mainScreen(guide)
  const report = await guide.finish("L")
  assertBatch(guide, report, selections)
  assertDataflow(report, selections)
}, 30_000)

it.for([17, 73])(
  "queues all five recommendations with seeded candidates, seed %i",
  { timeout: 30_000 },
  async (seed, { guide }) => {
    await guide.start(FixtureMode.Herdr)
    await enterIntent(guide)
    const selections = await queueProfiles(guide, recommendationIds, seed)
    await assertDeferredLaunch(guide)
    const report = await guide.finish("L")
    assertBatch(guide, report, selections)
    assertDataflow(report, selections)
  },
)

it("launches five recommendations and three pinned lenses together from a reopened fork", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  const selections = await queueProfiles(guide, [...recommendationIds, ...pinnedIds], 101)
  await assertDeferredLaunch(guide)
  await guide.pressAndWait("1", "Where does this queued job run?")
  const report = await guide.finish("L")
  assertBatch(guide, report, selections)
  assertDataflow(report, selections)
}, 30_000)

it.for([
  { seed: 41, columns: 120 },
  { seed: 97, columns: 240 },
])(
  "removes seeded jobs without mixing prompts or IDs, seed $seed at $columns columns",
  { timeout: 45_000 },
  async ({ seed, columns }, { guide }) => {
    await guide.start(FixtureMode.Herdr, columns)
    await enterIntent(guide)
    const generated = await queueProfiles(guide, [...recommendationIds, ...pinnedIds], seed)
    const retained = [...generated]
    const random = randomSource(seed)
    let current = retained.length - 1
    for (let removed = 0; removed < 3; removed += 1) {
      const target = random(retained.length)
      await selectQueueEntry(guide, retained, current, target)
      retained.splice(target, 1)
      await guide.pressAndWait("x", queueText(retained.length))
      current = Math.min(target, retained.length - 1)
    }
    for (let target = 0; target < retained.length; target += 1) {
      await selectQueueEntry(guide, retained, current, target)
      current = target
    }
    await assertDeferredLaunch(guide)
    const report = await guide.finish("L")
    assertBatch(guide, report, retained)
    assertDataflow(report, generated)
  },
)

it("removes every queued job and does not emit a command for an empty launch", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  const selections = await queueProfiles(guide, recommendationIds, 19)
  for (let remaining = selections.length - 1; remaining >= 0; remaining -= 1) {
    await guide.pressAndWait("x", queueText(remaining))
  }
  guide.press("L")
  await guide.pressAndWait(enter, "Batch queue is empty.")
  await assertDeferredLaunch(guide)
  const report = await guide.finish("q", 130)
  assertCancelledQueue(report)
  assertDataflow(report, selections)
}, 30_000)

it.for(["research", "codebase"] as const)(
  "uses %s augmentation as the complete downstream intent",
  { timeout: 30_000 },
  async (kind, { guide }) => {
    await guide.start(FixtureMode.Herdr)
    await guide.pressAndWait(fixtureIntent, fixtureIntent)
    const intent = kind === "research" ? researchIntent(fixtureIntent) : codebaseIntent(fixtureIntent)
    await augment(guide, kind, "\u0007", intent)
    await guide.waitForText("What do you want to do?")
    await guide.pressAndWait(enter, "Profile recommendations")
    await selectProfile(guide, "reviewer", 2, intent)
    await enqueue(guide, 1)
    const selection: Selection = { id: 1, profileId: "reviewer", candidate: 2, intent, placement: panePlacement }
    await inspectQueueEntry(guide, selection, 1)
    await assertDeferredLaunch(guide)
    const before = augmentationCommand(guide, await guide.events(), kind, fixtureIntent)
    const report = await guide.finish("L")
    assertBatch(guide, report, [selection], [before])
    assertDataflow(report, [selection], [intent], kind === "codebase" ? [fixtureIntent] : [])
  },
)

it("rematches an augmented prompt without changing a job already in the queue", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  await selectProfile(guide, "planner", 0)
  await enqueue(guide, 1)
  await mainScreen(guide)
  await guide.pressAndWait("p", fixtureIntent)
  const intent = codebaseIntent(fixtureIntent)
  await augment(guide, "codebase", "a", intent)
  await guide.pressAndWait(enter, "Profile recommendations")
  await selectProfile(guide, "sandbox", 1, intent)
  await enqueue(guide, 2)
  const selections: ReadonlyArray<Selection> = [
    { id: 1, profileId: "planner", candidate: 0, intent: fixtureIntent, placement: panePlacement },
    { id: 2, profileId: "sandbox", candidate: 1, intent, placement: panePlacement },
  ]
  await selectQueueEntry(guide, selections, 1, 0)
  await assertDeferredLaunch(guide)
  const before = augmentationCommand(guide, await guide.events(), "codebase", fixtureIntent)
  const report = await guide.finish("L")
  assertBatch(guide, report, selections, [before])
  assertDataflow(report, selections, [fixtureIntent, intent], [fixtureIntent])
}, 30_000)

it("edits one queued prompt and treats launch and removal hotkeys as literal text", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  const selections = await queueProfiles(guide, pinnedIds, 11)
  await selectQueueEntry(guide, selections, 2, 1)
  await guide.pressAndWait("e", "Edit queued prompt")
  const pasted = "\nKeep 'quotes', $HOME and $(not-a-command) as text.\nTyped keys: "
  await guide.pressAndWait(`\u001b[200~${pasted}\u001b[201~`, "Typed keys:")
  let typed = ""
  for (const key of "Lx`19avq") {
    typed += key
    await guide.pressAndWait(key, "Edit queued prompt", `Typed keys: ${typed}`)
  }
  await assertDeferredLaunch(guide)
  const appended = pasted + typed
  await guide.pressAndWait(enter, queueText(3))
  const edited = selections.map((selection, index) => (index === 1 ? { ...selection, appended } : selection))
  const selected = edited[1]
  assert(selected !== undefined)
  await inspectQueueEntry(guide, selected, 3)
  await assertDeferredLaunch(guide)
  const report = await guide.finish("L")
  assertBatch(guide, report, edited)
  assertDataflow(report, selections)
}, 30_000)

it("replaces the candidate on an existing fork without adding a duplicate job", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  await selectProfile(guide, "council", 0)
  await enqueue(guide, 1)
  await guide.pressAndWait("1", "Where does this queued job run?")
  await guide.pressAndWait("b", "Prompt candidates", "Approach: focused.")
  await selectCandidate(guide, "council", 2, fixtureIntent)
  await enqueue(guide, 1)
  const original: Selection = {
    id: 1,
    profileId: "council",
    candidate: 0,
    intent: fixtureIntent,
    placement: panePlacement,
  }
  const replacement = { ...original, candidate: 2 }
  await inspectQueueEntry(guide, replacement, 1)
  await assertDeferredLaunch(guide)
  const report = await guide.finish("L")
  assertBatch(guide, report, [replacement])
  assertDataflow(report, [original])
}, 30_000)

const queueWorktree = async (guide: GuideTerminal, count: number, mode: FixtureMode): Promise<void> => {
  await guide.pressAndWait("a", "Where does this queued job run?")
  await guide.pressAndWait(down, "\u276f Herdr worktree")
  await guide.pressAndWait(enter, fixtureBranch)
  guide.press(enter)
  if (mode === FixtureMode.ExistingWorktree) {
    await guide.waitForText("Worktree collision:", "open existing worktree")
  } else {
    await guide.waitForText("Create Herdr worktree", `Branch: ${fixtureBranch}`, "Base: HEAD")
    if (mode === FixtureMode.DirtyWorktree) {
      await guide.waitForText("Source working tree: dirty", "Confirm 0/2")
      await guide.pressAndWait(enter, "Confirm 1/2")
      await assertDeferredLaunch(guide)
    }
  }
  await guide.pressAndWait(enter, queueText(count))
}

it("launches a mixed queue into the correct pane, tab and new worktree", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  await selectProfile(guide, "reviewer", 0)
  await enqueue(guide, 1)
  await selectProfile(guide, "research", 1)
  await guide.pressAndWait(enter, "Choose a destination")
  await guide.pressAndWait(down, "\u276f New pane in this Herdr workspace")
  await guide.pressAndWait(down, "\u276f New tab in this Herdr worktree")
  await guide.pressAndWait(enter, queueText(2))
  await selectProfile(guide, "hve", 2)
  await queueWorktree(guide, 3, FixtureMode.Herdr)
  const selections: ReadonlyArray<Selection> = [
    { id: 1, profileId: "reviewer", candidate: 0, intent: fixtureIntent, placement: panePlacement },
    { id: 2, profileId: "research", candidate: 1, intent: fixtureIntent, placement: { kind: "new-tab" } },
    {
      id: 3,
      profileId: "hve",
      candidate: 2,
      intent: fixtureIntent,
      placement: { kind: "new-worktree", branch: fixtureBranch, baseRef: "HEAD" },
    },
  ]
  await assertDeferredLaunch(guide)
  const report = await guide.finish("L")
  assertBatch(guide, report, selections, [readinessCommand(guide.root, "research"), ...inspectionCommands(guide.root)])
  assertDataflow(report, selections)
}, 30_000)

it.for([FixtureMode.DirtyWorktree, FixtureMode.ExistingWorktree])(
  "honors the %s destination before L",
  { timeout: 30_000 },
  async (mode, { guide }) => {
    await guide.start(mode)
    await enterIntent(guide)
    await selectProfile(guide, "sandbox", 2)
    await queueWorktree(guide, 1, mode)
    const placement: JobPlacement =
      mode === FixtureMode.ExistingWorktree
        ? { kind: "existing-worktree", path: path.join(guide.root, "worktrees", "existing") }
        : { kind: "new-worktree", branch: fixtureBranch, baseRef: "HEAD" }
    const selection: Selection = { id: 1, profileId: "sandbox", candidate: 2, intent: fixtureIntent, placement }
    await assertDeferredLaunch(guide)
    const report = await guide.finish("L")
    assertBatch(guide, report, [selection], inspectionCommands(guide.root))
    assertDataflow(report, [selection])
  },
)
