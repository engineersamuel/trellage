import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, beforeAll, expect, test } from "vitest"
import type { JobPlacement, QueuedGuideJob } from "../src/guide-batch.js"
import type { GuideGoalCandidateContext, PreparedGuideGoal } from "../src/guide-goal-execution.js"
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
  generatedGoalApproaches,
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
import { goalArtifact, goalArtifactQuestion, goalCriteria, revisedGoalIntent } from "./fixtures/guide-goal-provider.js"
import { goalMeSkill } from "./fixtures/goal-me-skill.js"

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

interface GoalSelection extends Selection {
  readonly goal: PreparedGuideGoal
}

// Independent command oracles: do not call the production launch or workflow builders.
const launchArguments: Record<FixtureProfileId, ReadonlyArray<string>> = {
  planner: ["planner", "--"],
  reviewer: ["reviewer", "-i"],
  writer: ["default", "--"],
  builder: ["builder"],
  sandbox: ["--profile", "sandbox-reviewer"],
  council: ["--profile", "claude-council"],
  research: ["--profile", "claude-research"],
  hve: ["hve", "--agent", "hve-core:rpi-agent", "-i"],
  graph: ["--profile", "claude-graph-of-loops"],
}

const expectedPrompt = (selection: Pick<Selection, "profileId" | "candidate" | "intent" | "appended">): string => {
  const profile = fixtureProfile(selection.profileId)
  const title = candidateTitles[selection.candidate]
  assert(title !== undefined)
  return `${profile.beforeBody}${selection.intent}\nProfile: ${profile.ref}\nApproach: ${title.toLowerCase()}.\nReport the findings.${profile.afterBody}${selection.appended ?? ""}`
}

const expectedProfile = (root: string, id: FixtureProfileId): SelectedProfile => {
  const profile = fixtureProfile(id)
  const common = {
    profile: profile.name,
    headlessPrompt: true,
    ...(profile.goalExecution === undefined ? {} : { goalExecutionPolicy: profile.goalExecution }),
  }
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

const openGoalAugment = async (guide: GuideTerminal): Promise<void> => {
  await guide.pressAndWait("a", "Augment your prompt", "Research", "Codebase", "Goal me")
  await guide.pressAndWait(down, "\u276f Codebase")
  await guide.pressAndWait(down, "\u276f Goal me")
  await guide.pressAndWait(enter, goalArtifactQuestion)
}

const scrollUntil = async (guide: GuideTerminal, expected: string): Promise<void> => {
  for (let page = 0; page < 20 && !guide.text().includes(expected); page += 1) {
    const before = guide.text()
    guide.press("\u001b[6~")
    await guide.readScreen((text) => expect(text).not.toBe(before))
  }
  await guide.waitForText(expected)
}

const expectedGoalIntent = (intent: string, focus: string, revision = ""): string => {
  const template = goalMeSkill.split("```")[1]?.trim()
  assert(template !== undefined)
  let prompt = template.replace(
    "[describe exactly what you want produced]",
    `Artifact: ${goalArtifact}\n${intent}\nFocus: ${focus}${revision.length === 0 ? "" : `\nRevision: ${revision}`}`,
  )
  for (const [index, criterion] of goalCriteria.entries()) {
    prompt = prompt.replaceAll(`[criterion ${index + 1}]`, criterion)
  }
  return prompt
}

const expectedPreparedGoal = (intent: string, focus: string, revision = ""): PreparedGuideGoal => {
  const draft = {
    artifact: goalArtifact,
    task: `${intent}\nFocus: ${focus}${revision.length === 0 ? "" : `\nRevision: ${revision}`}`,
    criteria: goalCriteria,
  }
  const prompt = expectedGoalIntent(intent, focus, revision)
  return { draft, prompt, fingerprint: createHash("sha256").update(JSON.stringify({ draft, prompt })).digest("hex") }
}

const expectedGoalContext = (selection: GoalSelection): GuideGoalCandidateContext => {
  const profile = fixtureProfile(selection.profileId)
  assert(profile.goalExecution !== undefined)
  const body = generatedGoalApproaches(profile)[selection.candidate]
  assert(body !== undefined)
  return {
    goal: selection.goal,
    controller: profile.goalExecution.controller,
    workflow: {
      id: profile.workflowId,
      description: `Review with ${profile.name}.`,
      examples: ["Review this change", "Find regressions in this diff"],
      ...(profile.skill === undefined ? {} : { skill: profile.skill }),
      promptTemplate: `${profile.beforeBody}{{intent}}${profile.afterBody}`,
    },
    approach: `${body.prompt}\nReport the findings.${selection.appended ?? ""}`,
  }
}

const expectedGoalPrompt = (selection: GoalSelection): string => {
  const profile = fixtureProfile(selection.profileId)
  const { goal, controller, approach } = expectedGoalContext(selection)
  const body = [
    `ARTIFACT: ${goal.draft.artifact}`,
    "",
    "TASK:",
    goal.draft.task,
    "",
    "SUCCESS CRITERIA:",
    ...goal.draft.criteria.map((criterion) => `- ${criterion}`),
    "",
    "COMPLETION:",
    "Re-score the actual artifact from 1 to 10 on every criterion and show evidence in the conversation.",
    "Finish only when every criterion scores at least 8 and the selected controller's required gates pass.",
    "Fix the weakest criterion first. Do not weaken or replace the task or success criteria.",
    "Make sensible assumptions instead of asking avoidable questions.",
    "The selected goal controller alone owns progress, continuation, and completion.",
    "",
    "EXECUTION APPROACH:",
    "Use this guidance only where it preserves the approved task, criteria, completion rule, and profile constraints.",
    approach,
  ].join("\n")
  return `${controller === "graph-of-loops" ? "" : "/goal "}${profile.beforeBody}${body}${profile.afterBody}`
}

const goalSelection = (
  goal: PreparedGuideGoal,
  profileId: FixtureProfileId = "planner",
  candidate = 0,
  id = 1,
): GoalSelection => ({ id, goal, profileId, candidate, intent: goal.prompt, placement: panePlacement })

const approveGoal = async (guide: GuideTerminal, focus: string): Promise<void> => {
  await guide.pressAndWait(enter, `What must ${goalArtifact} cover?`)
  await guide.pressAndWait(`\u001b[200~${focus}\u001b[201~`, focus.split("\n").at(-1) ?? focus)
  await guide.pressAndWait(enter, "Use goal", "Revise")
  await guide.pressAndWait(enter, "Artifact:", goalArtifact, "e edit")
  await guide.pressAndWait(enter, "Profile recommendations", `Goal: ${goalCriteria.length} approved criteria`)
}

const authorGoal = async (guide: GuideTerminal, focus: string): Promise<PreparedGuideGoal> => {
  await enterIntent(guide)
  await guide.pressAndWait("p", fixtureIntent)
  await openGoalAugment(guide)
  await approveGoal(guide, focus)
  return expectedPreparedGoal(fixtureIntent, focus)
}

const selectGoalCandidate = async (guide: GuideTerminal, selection: GoalSelection): Promise<void> => {
  const controller = expectedGoalContext(selection).controller
  const label = controller === "graph-of-loops" ? "Graph of Loops" : controller === "claude-goal" ? "Claude /goal" : "Codex /goal"
  const prefix = controller === "graph-of-loops" ? "/graph-of-loops" : "/goal ARTIFACT:"
  for (let index = 0; index < 3; index += 1) {
    const title = candidateTitles[index]
    assert(title !== undefined)
    await guide.waitForText("Prompt candidates", `Prompt \u00b7 ${label}`, `\u276f ${title}`, prefix)
    const taskStart = selection.goal.draft.task.split("\n")[0]
    assert(taskStart !== undefined)
    await scrollUntil(guide, taskStart)
    for (const criterion of goalCriteria) await scrollUntil(guide, criterion)
    await scrollUntil(guide, `Approach: ${title.toLowerCase()}.`)
    await guide.waitForText(`Profile: ${fixtureProfile(selection.profileId).ref}`, "Report the findings.")
    await guide.pressAndWait(down, `\u276f ${candidateTitles[(index + 1) % 3]}`, prefix)
  }
  for (let index = 1; index <= selection.candidate; index += 1) {
    await guide.pressAndWait(down, `\u276f ${candidateTitles[index]}`, prefix)
  }
}

const selectGoalProfile = async (
  guide: GuideTerminal,
  selection: GoalSelection,
  eligible: ReadonlyArray<FixtureProfileId> = ["planner", "writer"],
): Promise<void> => {
  await guide.waitForText("Profile recommendations", `Goal: ${goalCriteria.length} approved criteria`)
  const current = eligible.findIndex((id) => guide.text().includes(`${fixtureProfile(id).ref} |`))
  const target = eligible.indexOf(selection.profileId)
  assert(current >= 0 && target >= 0)
  const steps = (target - current + eligible.length) % eligible.length
  for (let index = 1; index <= steps; index += 1) {
    const next = eligible[(current + index) % eligible.length]
    assert(next !== undefined)
    await guide.pressAndWait(down, `${fixtureProfile(next).ref} |`)
  }
  await guide.pressAndWait(enter, "Prompt candidates", ...candidateTitles)
  await selectGoalCandidate(guide, selection)
}

const assertGoalModelInputs = (
  report: FixtureReport,
  phase: Extract<FixtureEvent, { readonly kind: "goal-model-input" }>["phase"],
  goals: ReadonlyArray<PreparedGuideGoal>,
): void => {
  const requests = report.events.filter((event) => event.kind === "goal-model-input")
    .filter((event) => event.phase === phase)
  expect(requests).toHaveLength(goals.length)
  for (const [index, goal] of goals.entries()) {
    const request = requests[index]
    assert(request !== undefined)
    expect(request.input.goal).toEqual({ ...goal.draft, minimumScore: 8 })
    if (phase !== "optimize") expect(request.input.intent).toBe(goal.draft.task)
    expect(request.input).not.toHaveProperty("goalExecution")
    expect(JSON.stringify(request.input)).not.toMatch(/LOOP PROTOCOL|SCOREBOARD/u)
  }
}

const assertGoalDataflow = (
  report: FixtureReport,
  selections: ReadonlyArray<GoalSelection>,
  matches: ReadonlyArray<{
    readonly goal: PreparedGuideGoal
    readonly profiles: ReadonlyArray<FixtureProfileId>
  }>,
): void => {
  const matched = report.events.filter((event) => event.kind === "match").filter((event) => event.goal !== undefined)
  expect(matched).toHaveLength(matches.length)
  for (const [index, { goal, profiles }] of matches.entries()) {
    const match = matched[index]
    assert(match !== undefined)
    expect(match.goal).toEqual(goal)
    expect([...match.profileRefs].sort()).toEqual(profiles.map((id) => fixtureProfile(id).ref).sort())
    expect(match.recommendations).toEqual(profiles.map((id) => fixtureProfile(id).ref))
  }
  const generated = report.events.filter((event) => event.kind === "generate").filter((event) => event.input.goal !== undefined)
  expect(generated.map(({ input, ...event }) => ({
    ...event,
    input: { goal: input.goal, profileRef: input.profileRef, workflowId: input.workflowId },
  }))).toEqual(selections.map(({ goal, profileId }) => {
    const profile = fixtureProfile(profileId)
    return {
      kind: "generate",
      input: { profileRef: profile.ref, workflowId: profile.workflowId, goal },
      candidates: generatedGoalApproaches(profile),
    }
  }))
  const optimized = report.events.filter((event) => event.kind === "optimize").filter((event) => event.input.goalExecution !== undefined)
  expect(optimized).toHaveLength(selections.length)
  for (const [index, selection] of selections.entries()) {
    const optimization = optimized[index]
    assert(optimization !== undefined)
    const profile = fixtureProfile(selection.profileId)
    const { goal, controller, workflow } = expectedGoalContext(selection)
    expect(optimization.input).toMatchObject({
      goal,
      goalExecution: { goal, controller, workflow },
      profileRef: profile.ref,
      targetTool: profile.harness,
      candidates: generatedGoalApproaches(profile),
    })
    expect(optimization.candidates).toEqual(generatedGoalApproaches(profile).map((candidate) => ({
      ...candidate, prompt: `${candidate.prompt}\nReport the findings.`,
    })))
  }
  assertGoalModelInputs(report, "match", matches.map(({ goal }) => goal))
  assertGoalModelInputs(report, "generate", selections.map(({ goal }) => goal))
  assertGoalModelInputs(report, "optimize", selections.map(({ goal }) => goal))
}

const plainDataflowReport = (report: FixtureReport): FixtureReport => ({
  ...report,
  events: report.events.filter((event) => {
    if (event.kind === "match") return event.goal === undefined
    if (event.kind === "generate") return event.input.goal === undefined
    if (event.kind === "optimize") return event.input.goalExecution === undefined
    return true
  }),
})

const assertPrintedGoal = (report: FixtureReport, selection: GoalSelection): void => {
  const prompt = expectedGoalPrompt(selection)
  expect(report.result).toEqual({ action: "print", prompt, goalExecution: expectedGoalContext(selection) })
  expect(report.writes.join("")).toContain("Selected goal (not launched):")
  assertGoalInputInstructions(report.writes, selection)
  expect(commandEvents(report.events)).toEqual([])
  expect(report.events.filter((event) => event.kind === "interactive-launch")).toEqual([])
  expect(prompt).not.toMatch(/LOOP PROTOCOL|SCOREBOARD|\/goal-me|\$goal/u)
}

const assertGoalInputInstructions = (writes: ReadonlyArray<string>, selection: GoalSelection): void => {
  const command = expectedGoalContext(selection).controller === "graph-of-loops" ? "/graph-of-loops" : "/goal"
  const output = writes.join("")
  expect(output).toContain(`Type '${command} ' in the native command input, then paste the body below and submit.`)
  expect(output).toContain(`Goal body:\n${expectedGoalPrompt(selection).slice(command.length + 1)}\n`)
}

const expectedGoalJob = (root: string, selection: GoalSelection): QueuedGuideJob => {
  const profile = expectedProfile(root, selection.profileId)
  const prompt = expectedGoalPrompt(selection)
  return {
    id: selection.id,
    profile,
    prompt,
    command: {
      executable: profile.commandPath,
      args: profile.surface === "native" ? [profile.profile] : ["--profile", profile.profile, prompt],
    },
    promptDelivery: profile.surface === "native" ? "manual" : "command",
    placement: selection.placement,
    goalExecution: expectedGoalContext(selection),
  }
}

const codexGoalReadinessCommands = (root: string): ReadonlyArray<RecordedCommand> => [
  readinessCommand(root, "planner"),
  { executable: "codex", args: ["--version"], cwd: root },
  { executable: path.join(root, "bin", "cdx"), args: ["inventory", "planner", "--goal-features"], cwd: root },
]

const goalReadinessCommands = (root: string, selection: GoalSelection): ReadonlyArray<RecordedCommand> => {
  const controller = expectedGoalContext(selection).controller
  if (controller === "codex-goal") return codexGoalReadinessCommands(root)
  assert.equal(controller, "claude-goal")
  return [
    readinessCommand(root, selection.profileId),
    { executable: path.join(root, "bin", "cldx"), args: ["harness-version"], cwd: root },
    {
      executable: "curl",
      args: ["--fail", "--silent", "--show-error", "--max-time", "5", "http://127.0.0.1:8080/v1/models"],
      cwd: root,
    },
  ]
}

const assertClaudeReadinessFiles = (guide: GuideTerminal, report: FixtureReport): void => {
  const home = path.join(guide.root, "home", ".local", "share", "trellage", "profiles", "claude", "default", "home")
  const expected: ReadonlyArray<Extract<FixtureEvent, { readonly kind: "goal-readiness" }>> = [
    { kind: "goal-readiness", operation: "realpath", path: guide.root },
    { kind: "goal-readiness", operation: "read-json", path: path.join(home, ".claude.json") },
    { kind: "goal-readiness", operation: "read-directory", path: "/etc/claude-code/managed-settings.d" },
    { kind: "goal-readiness", operation: "local-settings", path: guide.root },
    { kind: "goal-readiness", operation: "read-json", path: path.join(home, "settings.json") },
    { kind: "goal-readiness", operation: "read-json", path: path.join(guide.root, ".claude", "settings.json") },
    { kind: "goal-readiness", operation: "read-json", path: path.join(guide.root, ".claude", "settings.local.json") },
    { kind: "goal-readiness", operation: "read-json", path: "/etc/claude-code/managed-settings.json" },
  ]
  expect(report.events.filter((event) => event.kind === "goal-readiness")).toEqual([...expected, ...expected])
}

const hasGoal = (selection: Selection | GoalSelection): selection is GoalSelection => "goal" in selection

const assertGoalBatch = (
  guide: GuideTerminal,
  report: FixtureReport,
  selections: ReadonlyArray<Selection | GoalSelection>,
): void => {
  const allocated = selections.map((selection, index) => ({
    ...expectedAllocation(guide.root, selection, index),
    selection,
    job: hasGoal(selection) ? expectedGoalJob(guide.root, selection) : expectedJob(guide.root, selection),
  }))
  expect(report.result).toEqual({
    action: "batch",
    result: {
      entries: allocated.map(({ job, cwd, paneId, workspaceId }) => ({
        job, status: job.promptDelivery === "manual" ? "needs-input" : "launched", cwd, paneId, workspaceId,
      })),
    },
  })
  const commands = commandEvents(report.events)
  const probes = selections.flatMap((selection) => hasGoal(selection)
    ? goalReadinessCommands(guide.root, selection)
    : [readinessCommand(guide.root, selection.profileId)],
  )
  const commandOrder = (left: RecordedCommand, right: RecordedCommand): number =>
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  expect([...commands.slice(0, probes.length)].sort(commandOrder)).toEqual([...probes].sort(commandOrder))
  const allocations = allocated.flatMap((allocation) => allocation.commands)
  expect(commands.slice(probes.length, probes.length + allocations.length)).toEqual(allocations)
  const starting = commands.slice(probes.length + allocations.length)
  const finalProbes = selections.filter(hasGoal).flatMap((selection) => goalReadinessCommands(guide.root, selection))
  expect(starting.filter((command) => command.executable !== "herdr").sort(commandOrder))
    .toEqual([...finalProbes].sort(commandOrder))
  // Per-job readiness runs concurrently, so pane starts need not follow queue order.
  expect(starting.filter((command) => command.executable === "herdr").sort(commandOrder)).toEqual(
    allocated.map(({ selection, job, paneId, cwd }) => ({
      executable: "herdr",
      args: [
        "pane", "run", paneId,
        hasGoal(selection)
          ? `env TRELLAGE_AUTOMATION=1 ${quoted(job.command.executable)} ${job.profile.profile}`
          : expectedPaneCommand(guide.root, selection),
      ],
      cwd,
    })).sort(commandOrder),
  )
  for (const { selection, paneId, cwd } of allocated) {
    if (!hasGoal(selection)) continue
    expect(report.writes.join("")).toContain(`${selection.id}. ${fixtureProfile(selection.profileId).name}: needs-input in pane ${paneId}`)
    expect(report.writes.join("")).toContain(cwd)
    assertGoalInputInstructions(report.writes, selection)
  }
  expect(report.writes.join("")).toContain("The goal has not been activated.")
  expect(report.events.filter((event) => event.kind === "interactive-launch")).toEqual([])
}

const editMainGoal = async (guide: GuideTerminal, addition: string): Promise<void> => {
  await guide.pressAndWait("p", "Artifact:", goalArtifact, "e edit")
  await guide.pressAndWait("e", "Raw edit")
  await guide.pressAndWait(`\u001b[200~${addition}\u001b[201~`, addition.trim())
  await guide.pressAndWait(enter, "Review goal changes", "g revise goal", "n use normal prompt", "b/Esc keep goal")
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

it("keeps one readiness probe alive while its fork is parked and the main selection changes", async ({ guide }) => {
  await guide.start(FixtureMode.ParkedReadiness)
  await enterIntent(guide)
  await selectProfile(guide, "planner", 0)
  await guide.pressAndWait(enter, "Checking profile readiness")
  const current = await mainScreen(guide)
  for (let step = 1; step <= 3; step += 1) {
    const id = recommendationIds[(current + step) % recommendationIds.length]
    assert(id !== undefined)
    await guide.pressAndWait(down, `${fixtureProfile(id).ref} |`)
  }
  await guide.pressAndWait("1", "Checking profile readiness")
  await guide.pressAndWait("\u0012", "Choose a destination")
  const report = await guide.finish("q", 130)
  expect(report.result).toEqual({ action: "cancel", exitCode: 130 })
  expect(commandEvents(report.events)).toEqual([readinessCommand(guide.root, "planner")])
})

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
  await guide.waitForInput("L")
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

it("prints three explicit Codex goal approaches and edits only the selected body", async ({ guide }) => {
  await guide.start(FixtureMode.Terminal)
  const goal = await authorGoal(guide, "Cover expired tokens without changing the approved criteria.")
  const selection = goalSelection(goal, "planner", 2)
  await selectGoalProfile(guide, selection)
  await guide.pressAndWait("e", "Edit approach (goal fixed)", "Approach: minimal.")
  expect(guide.text()).not.toContain("/goal")
  expect(guide.text()).not.toContain(goalArtifact)
  expect(guide.text()).not.toContain(fixtureIntent)
  const pasted = "\nUse only offline evidence.\nLiteral keys: "
  await guide.pressAndWait(`\u001b[200~${pasted}\u001b[201~`, "Literal keys:")
  let typed = ""
  for (const key of "Lx`19agnbq") {
    typed += key
    await guide.pressAndWait(key, "Edit approach (goal fixed)", `Literal keys: ${typed}`)
  }
  await assertDeferredLaunch(guide)
  await guide.pressAndWait(enter, "Prompt candidates", "Codex /goal")
  await scrollUntil(guide, `Literal keys: ${typed}`)
  const report = await guide.finish("c")
  assertPrintedGoal(report, { ...selection, appended: pasted + typed })
  assertGoalDataflow(report, [selection], [{ goal, profiles: ["planner", "writer"] }])
  assertDataflow(plainDataflowReport(report), [])
  await expect(access(path.join(guide.root, ".trellage"))).rejects.toMatchObject({ code: "ENOENT" })
}, 30_000)

it("requires a normal-flow choice for a pinned lens without detaching the main goal", async ({ guide }) => {
  await guide.start(FixtureMode.Terminal)
  const goal = await authorGoal(guide, "Keep the evidence tied to the affected source lines.")
  for (const back of ["b", "\u001b"]) {
    await guide.pressAndWait("r", "This workflow cannot execute the goal", "n use normal prompt", "b/Esc keep goal")
    expect((await guide.events()).filter((event) => event.kind === "generate")).toHaveLength(0)
    await guide.pressAndWait(back, "Profile recommendations", "Goal: 3 approved criteria")
  }
  await guide.pressAndWait("r", "This workflow cannot execute the goal")
  await guide.pressAndWait("n", "Prompt candidates", "/hyperresearch", "Approach: focused.")
  expect(guide.text()).not.toContain("Prompt \u00b7 Codex /goal")
  const referenceIntent = [
    `Artifact: ${goal.draft.artifact}`,
    goal.draft.task,
    "Success criteria:",
    ...goal.draft.criteria.map((criterion) => `- ${criterion}`),
  ].join("\n")
  await guide.pressAndWait("`", "Profile recommendations", "Goal: 3 approved criteria")
  const selection = goalSelection(goal)
  await selectGoalProfile(guide, selection)
  const report = await guide.finish("c")
  assertPrintedGoal(report, selection)
  assertGoalDataflow(report, [selection], [{ goal, profiles: ["planner", "writer"] }])
  assertDataflow(plainDataflowReport(report), [{
    id: 1, profileId: "research", candidate: 0, intent: referenceIntent, placement: panePlacement,
  }])
}, 30_000)

it("keeps a long Unicode goal accessible and excludes Claude rather than shortening it", async ({ guide }) => {
  await guide.start(FixtureMode.Terminal, 88, 40)
  const focus = [
    ...Array.from({ length: 40 }, (_, index) =>
      `Evidence ${index + 1}: Preserve caf\u00e9 output and \u{1f9ea} results exactly. Retain the complete regression example and affected source lines.`,
    ),
    "Unicode objective complete.",
  ].join("\n")
  const goal = await authorGoal(guide, focus)
  expect([...goal.draft.task].length).toBeGreaterThan(4000)
  const selection = goalSelection(goal)
  await selectGoalProfile(guide, selection, ["planner"])
  await scrollUntil(guide, "Unicode objective complete.")
  await guide.pressAndWait("e", "Edit approach (goal fixed)", "Approach: focused.")
  expect(guide.text()).not.toContain("Unicode objective")
  const appended = "\nKeep caf\u00e9 and \u{1f9ea} unchanged."
  await guide.pressAndWait(`\u001b[200~${appended}\u001b[201~`, appended.trim())
  await guide.pressAndWait(enter, "Prompt candidates", "Codex /goal")
  const report = await guide.finish("c")
  assertPrintedGoal(report, { ...selection, appended })
  assertGoalDataflow(report, [selection], [{ goal, profiles: ["planner"] }])
  assertDataflow(plainDataflowReport(report), [])
}, 30_000)

it.for([
  { profileId: "planner" as const, controller: "Codex", manual: true },
  { profileId: "writer" as const, controller: "Claude", manual: false },
])(
  "uses the supported $controller goal handoff in this terminal",
  { timeout: 30_000 },
  async ({ profileId, manual }, { guide }) => {
    await guide.start(FixtureMode.Terminal)
    const goal = await authorGoal(guide, "Show repeatable token-expiry evidence.")
    const selection = goalSelection(goal, profileId, 1)
    await selectGoalProfile(guide, selection)
    await guide.pressAndWait(enter, "Choose a destination", "This terminal")
    const manualNotice = "Native goal input is required after the session starts."
    if (manual) await guide.waitForText(manualNotice)
    else expect(guide.text()).not.toContain(manualNotice)
    await assertDeferredLaunch(guide)
    const report = await guide.finish(enter)
    const profile = expectedProfile(guide.root, profileId)
    const prompt = expectedGoalPrompt(selection)
    const command = {
      executable: profile.commandPath,
      args: manual ? [profile.profile] : [profile.profile, "-p", prompt],
    }
    expect(report.result).toEqual({
      action: "current-terminal",
      profile,
      command,
      promptHandling: manual ? "manual-paste" : "argv",
      prompt,
      cwd: guide.root,
      goalExecution: expectedGoalContext(selection),
    })
    expect(commandEvents(report.events)).toEqual([
      ...goalReadinessCommands(guide.root, selection),
      ...goalReadinessCommands(guide.root, selection),
    ])
    expect(report.events.filter((event) => event.kind === "interactive-launch")).toEqual([
      { kind: "interactive-launch", command, cwd: guide.root, automation: "1" },
    ])
    if (manual) {
      expect(report.writes.join("")).toContain("Goal needs-input after the profile starts. Startup does not activate it.")
      assertGoalInputInstructions(report.writes, selection)
    } else {
      expect(report.writes).toEqual([])
      assertClaudeReadinessFiles(guide, report)
    }
    assertGoalDataflow(report, [selection], [{ goal, profiles: ["planner", "writer"] }])
  },
)

it("keeps a Claude goal interactive in Herdr and requires native input", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  const goal = await authorGoal(guide, "Retain the approved evidence requirements.")
  const selection = goalSelection(goal, "writer", 2)
  await selectGoalProfile(guide, selection)
  await enqueue(guide, 1)
  await guide.waitForText("Claude /goal (needs input)")
  await assertDeferredLaunch(guide)
  const report = await guide.finish("L", 2)
  assertGoalBatch(guide, report, [selection])
  assertClaudeReadinessFiles(guide, report)
  assertGoalDataflow(report, [selection], [{ goal, profiles: ["planner", "writer"] }])
}, 30_000)

it("keeps queued goals fixed through body edits, reapproval, and an explicit normal prompt", async ({ guide }) => {
  await guide.start(FixtureMode.GoalReapproval)
  const goal = await authorGoal(guide, "Cover expired tokens.")
  const original = goalSelection(goal, "planner", 1)
  await selectGoalProfile(guide, original)
  await enqueue(guide, 1)
  await guide.waitForText("Codex /goal (needs input)")
  await guide.pressAndWait("e", "Edit queued approach (goal fixed)", "Approach: thorough.")
  expect(guide.text()).not.toContain(goalArtifact)
  expect(guide.text()).not.toContain(fixtureIntent)
  const appended = "\nRetain this queued approach. Literal keys: "
  await guide.pressAndWait(`\u001b[200~${appended}\u001b[201~`, "Literal keys:")
  let typed = ""
  for (const key of "Lx`19gnbpaq") {
    typed += key
    await guide.pressAndWait(key, "Edit queued approach (goal fixed)", `Literal keys: ${typed}`)
  }
  await guide.pressAndWait(enter, queueText(1))
  await guide.pressAndWait("o", "Queued prompt 1")
  await scrollUntil(guide, `Literal keys: ${typed}`)
  await guide.pressAndWait("b", queueText(1))
  await guide.pressAndWait("`", "Profile recommendations", "Goal: 3 approved criteria")
  await guide.pressAndWait("p", "e edit")
  await guide.pressAndWait("e", "Raw edit")
  await guide.pressAndWait("\u001b", "Markdown preview", "Artifact:", goalArtifact, "e edit")
  await guide.pressAndWait(enter, "Profile recommendations", "Goal: 3 approved criteria")
  for (const back of ["b", "\u001b"]) {
    await editMainGoal(guide, "\nKeep the currently approved goal.")
    await guide.pressAndWait(back, "Artifact:", goalArtifact, "e edit")
    await guide.pressAndWait(enter, "Profile recommendations", "Goal: 3 approved criteria")
  }
  const replacement = `\nReplace the task: ${revisedGoalIntent}`
  await editMainGoal(guide, replacement)
  await guide.pressAndWait("g", goalArtifactQuestion)
  const nextFocus = "Cover sign-out without changing queued token-expiry work."
  await approveGoal(guide, nextFocus)
  const nextGoal = expectedPreparedGoal(revisedGoalIntent, nextFocus)
  const next = goalSelection(nextGoal, "planner", 0, 2)
  await selectGoalProfile(guide, next)
  await enqueue(guide, 2)
  await guide.pressAndWait("1", "Where does this queued job run?")
  await guide.pressAndWait("b", "Prompt candidates", "Codex /goal", fixtureIntent)
  expect(guide.text()).not.toContain(revisedGoalIntent)
  await guide.pressAndWait("`", "Profile recommendations", "Goal: 3 approved criteria")
  const ordinaryChange = "\nUse this as ordinary follow-up text."
  await editMainGoal(guide, ordinaryChange)
  await guide.pressAndWait("n", "Profile recommendations", "Prompt:")
  expect(guide.text()).not.toContain("Goal: 3 approved criteria")
  await assertDeferredLaunch(guide)
  const report = await guide.finish("L", 2)
  assertGoalBatch(guide, report, [{ ...original, appended: appended + typed }, next])
  assertGoalDataflow(report, [original, next], [
    { goal, profiles: ["planner", "writer"] },
    { goal: nextGoal, profiles: ["planner", "writer"] },
  ])
  assertDataflow(plainDataflowReport(report), [], [fixtureIntent, nextGoal.prompt + ordinaryChange])
  expect(report.events.filter((event) => event.kind === "goal-start")).toEqual([
    { kind: "goal-start", sessionId: 1, intent: fixtureIntent, previousTurns: 0 },
    { kind: "goal-start", sessionId: 2, intent: goal.prompt + replacement, previousTurns: 0 },
  ])
}, 45_000)

it("uses the Graph goal controller alone for all three candidates", async ({ guide }) => {
  await guide.start(FixtureMode.GoalGraph)
  const goal = await authorGoal(guide, "Require evidence for each regression finding.")
  const selection = goalSelection(goal, "graph", 1)
  await selectGoalProfile(guide, selection, ["planner", "writer", "graph"])
  const report = await guide.finish("c")
  assertPrintedGoal(report, selection)
  assertGoalDataflow(report, [selection], [{ goal, profiles: ["planner", "writer", "graph"] }])
  expect(report.result.action).toBe("print")
  assert(report.result.action === "print")
  expect(report.result.prompt.match(/\/graph-of-loops/gu)).toHaveLength(1)
  expect(report.result.prompt).not.toContain("/goal ")
  expect(report.result.prompt).toContain("Keep trellage-graph as the only completion authority.")
  expect(report.result.prompt).toContain("Require its review, proof, integration, and delivery gates.")
}, 30_000)

it("interviews through p then a, revises, and protects a newer prompt and queued job", async ({ guide }) => {
  await guide.start(FixtureMode.Herdr)
  await enterIntent(guide)
  await selectProfile(guide, "planner", 0)
  await enqueue(guide, 1)
  await mainScreen(guide)
  await guide.pressAndWait("p", fixtureIntent)
  expect((await guide.events()).filter((event) => event.kind === "goal-start")).toHaveLength(0)
  await openGoalAugment(guide)
  await guide.pressAndWait(enter, `What must ${goalArtifact} cover?`)
  const pasted = "Cover expired tokens.\nRun `npm test -- --runInBand`.\n- **Keep failure evidence.**\nKeep these keys as text: "
  await guide.pressAndWait(`\u001b[200~${pasted}\u001b[201~`, "Keep these keys as text:")
  let typed = ""
  for (const key of "Lx`19apq") {
    typed += key
    await guide.pressAndWait(key, `Keep these keys as text: ${typed}`)
  }
  const focus = pasted + typed
  await guide.pressAndWait("\u001b", fixtureIntent, "Goal me needs an answer")
  await guide.pressAndWait("e", "Raw edit")
  const change = "\nNew scope: keep my newer prompt until I confirm replacement."
  await guide.pressAndWait(`\u001b[200~${change}\u001b[201~`, "New scope:")
  await guide.pressAndWait(enter, "Profile recommendations")
  await guide.pressAndWait("p", "New scope:")
  await guide.pressAndWait("a", `What must ${goalArtifact} cover?`, `Keep these keys as text: ${typed}`)
  await guide.pressAndWait(enter, "Use goal", "Revise")
  await guide.waitForText("Run npm test -- --runInBand.", "• Keep failure evidence.")
  expect(guide.text()).not.toContain("`npm test")
  expect(guide.text()).not.toContain("**Keep failure evidence")
  const beforeApproval = (await guide.events()).filter((event) => event.kind === "match")
  expect(beforeApproval.map((event) => event.intent)).toEqual([fixtureIntent, fixtureIntent + change])
  await guide.pressAndWait(down, "\u276f Revise")
  await guide.pressAndWait(enter, "feedback")
  const revision = "Include a repeatable regression example."
  await guide.pressAndWait(revision, revision)
  await guide.pressAndWait(enter, `Apply this revision: ${revision}?`)
  expect(guide.text()).not.toContain("Type your own")
  await guide.pressAndWait(enter, "Use goal", "Revise")
  await scrollUntil(guide, "4. VERIFY")
  await scrollUntil(guide, "5. DECIDE")
  await scrollUntil(guide, "Begin.")
  await guide.pressAndWait(enter, "Goal me is ready", "Enter replace current prompt")
  await guide.waitForText("Run npm test -- --runInBand.", "• Keep failure evidence.")
  expect(guide.text()).not.toContain("`npm test")
  expect(guide.text()).not.toContain("**Keep failure evidence")
  await guide.pressAndWait(enter, "Artifact:", goalArtifact, "e edit")
  await guide.pressAndWait(enter, "Profile recommendations")
  const intent = expectedGoalIntent(fixtureIntent, focus, revision)
  const events = await guide.events()
  expect(events.filter((event) => event.kind === "goal-start")).toEqual([
    { kind: "goal-start", sessionId: 1, intent: fixtureIntent, previousTurns: 0 },
  ])
  expect(events.filter((event) => event.kind === "goal-answer").map((event) => event.answer)).toEqual([
    { answer: goalArtifact, wasFreeform: false },
    { answer: focus, wasFreeform: true },
    { answer: "Apply this change", wasFreeform: false },
  ])
  expect(events.filter((event) => event.kind === "goal-review").map((event) => event.review)).toEqual([
    { decision: "revise", feedback: revision }, { decision: "use" },
  ])
  const goal = expectedPreparedGoal(fixtureIntent, focus, revision)
  const goalJob = goalSelection(goal, "planner", 0, 2)
  await selectGoalProfile(guide, goalJob)
  await enqueue(guide, 2)
  const queued: Selection = { id: 1, profileId: "planner", candidate: 0, intent: fixtureIntent, placement: panePlacement }
  expect(goal.prompt).toBe(intent)
  await assertDeferredLaunch(guide)
  const report = await guide.finish("L", 2)
  assertGoalBatch(guide, report, [queued, goalJob])
  assertDataflow(plainDataflowReport(report), [queued], [fixtureIntent, fixtureIntent + change])
  assertGoalDataflow(report, [goalJob], [{ goal, profiles: ["planner", "writer"] }])
}, 30_000)

it("accepts current and future recommendations after a, but keeps manual questions and goal approval interactive", async ({ guide }) => {
  await guide.start(FixtureMode.GoalRecommended)
  await enterIntent(guide)
  await guide.pressAndWait("p", fixtureIntent)
  await openGoalAugment(guide)
  await guide.waitForText("a accept all recommended answers", "smallest offline v1")
  expect((await guide.events()).filter((event) => event.kind === "goal-answer")).toHaveLength(0)
  await guide.pressAndWait("a", "Who will read this report?", "no single recommended choice")
  expect((await guide.events()).filter((event) => event.kind === "goal-answer").map((event) => event.answer)).toEqual([
    { answer: `${goalArtifact} (Recommended: smallest offline v1)`, wasFreeform: false },
    { answer: "Token expiry (Recommended)", wasFreeform: false },
  ])
  const audience = "a team of reviewers"
  await guide.pressAndWait(audience, audience)
  await guide.pressAndWait("\u001b", "Goal me needs an answer")
  await guide.pressAndWait("a", audience, "Your answer:")
  await guide.pressAndWait(enter, "Use goal", "a stop automatic answers")
  expect((await guide.events()).filter((event) => event.kind === "goal-review")).toHaveLength(0)
  await guide.pressAndWait(down, "❯ Revise")
  await guide.pressAndWait(enter, "Revision feedback:")
  const revision = "Add a regression example."
  await guide.pressAndWait(revision, revision)
  await guide.pressAndWait(enter, "Use goal", "a stop automatic answers")
  expect((await guide.events()).filter((event) => event.kind === "goal-review").map((event) => event.review))
    .toEqual([{ decision: "revise", feedback: revision }])
  await guide.pressAndWait("a", "Use goal")
  await expect.poll(() => guide.text()).not.toContain("a stop automatic answers")
  await guide.pressAndWait(enter, "Artifact:", goalArtifact, "e edit")
  await guide.pressAndWait(enter, "Profile recommendations")
  const report = await guide.finish("\u0003", 130)
  expect(report.events.filter((event) => event.kind === "goal-start")).toEqual([
    { kind: "goal-start", sessionId: 1, intent: fixtureIntent, previousTurns: 0 },
  ])
  expect(report.events.filter((event) => event.kind === "goal-answer").map((event) => event.answer)).toEqual([
    { answer: `${goalArtifact} (Recommended: smallest offline v1)`, wasFreeform: false },
    { answer: "Token expiry (Recommended)", wasFreeform: false },
    { answer: audience, wasFreeform: true },
    { answer: "Cite source lines (Recommended)", wasFreeform: false },
    { answer: "Apply this change (Recommended)", wasFreeform: false },
  ])
  expect(report.events.filter((event) => event.kind === "goal-review").map((event) => event.review)).toEqual([
    { decision: "revise", feedback: revision }, { decision: "use" },
  ])
  const finalProposal = report.events.filter((event) => event.kind === "goal-proposal").at(-1)?.proposal.prompt
  expect(finalProposal).toContain(`Audience: ${audience}`)
  const goal = expectedPreparedGoal(fixtureIntent, `Token expiry (Recommended)\nAudience: ${audience}`, revision)
  expect(finalProposal).toBe(goal.prompt)
  assertDataflow(plainDataflowReport(report), [])
  assertGoalDataflow(report, [], [{ goal, profiles: ["planner", "writer"] }])
  assertCancelledQueue(report)
}, 30_000)

it("keeps answers after a failed interview and retries only on request", async ({ guide }) => {
  await guide.start(FixtureMode.GoalFailure)
  await enterIntent(guide)
  await guide.pressAndWait("p", fixtureIntent)
  await openGoalAugment(guide)
  await guide.pressAndWait(enter, "Goal me failed", "Fixture goal connection failed.", `Your answer: ${goalArtifact}`)
  await guide.pressAndWait("r", `What must ${goalArtifact} cover?`)
  expect((await guide.events()).filter((event) => event.kind === "goal-start")).toEqual([
    { kind: "goal-start", sessionId: 1, intent: fixtureIntent, previousTurns: 0 },
    { kind: "goal-start", sessionId: 2, intent: fixtureIntent, previousTurns: 1 },
  ])
  const report = await guide.finish("\u0003", 130)
  expect(report.events.filter((event) => event.kind === "match").map((event) => event.intent)).toEqual([fixtureIntent])
  assertCancelledQueue(report)
}, 20_000)

it("keeps long questions and answer controls usable, then discards without applying", async ({ guide }) => {
  await guide.start(FixtureMode.GoalLongQuestion, 64, 20)
  await guide.pressAndWait(fixtureIntent, fixtureIntent)
  await guide.pressAndWait(enter, "p view prompt")
  await guide.pressAndWait("p", fixtureIntent, "e edit")
  await openGoalAugment(guide)
  await scrollUntil(guide, "End of question context.")
  await scrollUntil(guide, "Type your own")
  await guide.waitForText(goalArtifact, "Type your own")
  await guide.pressAndWait(enter, `What must ${goalArtifact} cover?`)
  await guide.pressAndWait("qxLpa19`", "qxLpa19`")
  await guide.pressAndWait("\u001b", "Goal me needs an answer")
  await guide.pressAndWait("a", "qxLpa19`")
  await guide.pressAndWait("\u0018", "Discard this interview?", "original prompt stays unchanged.")
  await guide.pressAndWait(down, "\u276f Discard interview")
  await guide.pressAndWait(enter, fixtureIntent)
  await expect.poll(async () => (await guide.events()).filter((event) => event.kind === "goal-stop"), {
    timeout: 5000,
  }).toEqual([{ kind: "goal-stop", sessionId: 1, cancelled: true }])
  await openGoalAugment(guide)
  const report = await guide.finish("\u0003", 130)
  expect(report.events.filter((event) => event.kind === "goal-start").map((event) => event.sessionId)).toEqual([1, 2])
  expect(report.events.filter((event) => event.kind === "goal-review")).toHaveLength(0)
  expect(report.events.filter((event) => event.kind === "match").map((event) => event.intent)).toEqual([fixtureIntent])
  assertCancelledQueue(report)
}, 20_000)

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
