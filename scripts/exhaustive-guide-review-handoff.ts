import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  buildHerdrGuideLaunch, renderCommandPreview,
  type CommandRunner, type HerdrContext,
} from "../packages/trellage-launcher/src/guide-launch.ts"
import {
  buildGuideReviewPrompt, createGuideReviewServices, executeGuideReviewTerminal,
  reviewAgentProfiles, type GuideReviewRequest, type GuideReviewDependencies,
} from "../packages/trellage-launcher/src/review-services.ts"
import { ProfileReadinessKind } from "../packages/trellage-launcher/src/guide-preflight.ts"
import type { ReviewRun } from "../packages/trellage-launcher/src/review-contracts.ts"
import { SharedReviewStore } from "../packages/trellage-launcher/src/review-store.ts"
import type { createGuideWorld } from "./exhaustive-guide-world.ts"

export const assertGuideReviewHandoff = async (
  world: Awaited<ReturnType<typeof createGuideWorld>>,
  template: ReviewRun,
  gitRunner: CommandRunner,
  context: HerdrContext | null,
  id: string,
): Promise<void> => {
  const profiles = reviewAgentProfiles(world.catalog)
  assert(profiles.length > 0, id)
  const target = template.request.target
  const store = new SharedReviewStore(target.gitDirectory)
  const destinations = context === null ? ["terminal"] as const : ["pane", "tab"] as const
  for (const profile of profiles) for (const destination of destinations) for (const dispatchFails of [false, true]) for (const automatic of [false, true]) {
    const label = `${id}: handoff/${profile.ref}/${destination}/${dispatchFails}/${automatic}`
    const review: ReviewRun = { ...template, id: randomUUID(), approvedIds: [], execution: "not-started" }
    await store.save({ ...review, status: "running" })
    await store.save(review)
    const findings = review.results.flatMap((result) => result.findings).filter((finding) => finding.grounded)
    assert(findings.length > 0, label)
    const approval = await store.approve(review.id, findings.map((finding) => finding.id))
    const request: GuideReviewRequest = {
      target, paths: review.request.paths, approval, destination, otherEditorsStopped: true,
      ...(automatic ? { automatic: true } : {}),
      ...(review.request.originalIntent === undefined ? {} : { originalIntent: review.request.originalIntent }),
      ...(review.request.intent === undefined ? {} : { intent: review.request.intent }),
    }
    const prompt = buildGuideReviewPrompt(request)
    const expected = buildHerdrGuideLaunch(profile.profile, prompt)
    const expectedCommand = automatic ? {
      executable: expected.command.executable,
      args: [profile.profile.profile, "--plan", "--mode", "autopilot", "--allow-all", "--no-ask-user", "-i", prompt],
    } : expected.command
    const automaticRejected = automatic && (destination !== "tab" || profile.profile.launcher !== "copilot" || profile.profile.profile !== "hve")
    let busyWriter = false
    let allocations = 0
    let dispatches = 0
    let readinessChecks = 0
    let unexpectedCalls = 0
    const unexpected = (): never => {
      unexpectedCalls++
      throw new Error(`${label}: unexpected model boundary`)
    }
    const beforeDispatch = async () => {
      dispatches++
      assert.equal(dispatches, 1, label)
      assert.equal((await store.read(review.id)).execution, "launching", label)
      if (dispatchFails) throw new Error("Fixture dispatch acknowledgment lost")
    }
    const runner: CommandRunner = {
      run: async (executable, argv, options) => {
        if (executable === "git") return gitRunner.run(executable, argv, options)
        assert.equal(executable, "herdr", label)
        assert(context !== null, label)
        assert.equal(options?.cwd, target.cwd, label)
        if (argv[0] === "tab" || argv[1] === "split") {
          allocations++
          assert.equal(allocations, 1, label)
          assert.equal((await store.read(review.id)).execution, "not-started", label)
          assert.deepEqual(argv, destination === "tab"
            ? ["tab", "create", "--workspace", context.workspaceId, "--cwd", target.cwd, "--no-focus"]
            : ["pane", "split", "--pane", context.paneId, "--cwd", target.cwd, "--direction", "right", "--no-focus"], label)
          return { exitCode: 0, stderr: "", stdout: JSON.stringify({ result: destination === "tab"
            ? { root_pane: { pane_id: "fixture-review-destination" } }
            : { pane: { pane_id: "fixture-review-destination" } } }) }
        }
        assert.deepEqual(argv, ["pane", "run", "fixture-review-destination", `env TRELLAGE_AUTOMATION=1 ${renderCommandPreview(expectedCommand)}`], label)
        await beforeDispatch()
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    }
    const readiness: NonNullable<GuideReviewDependencies["readiness"]> = async (_runner, selected, cwd) => {
      assert.deepEqual(selected, profile.profile, label)
      assert.equal(cwd, target.cwd, label)
      readinessChecks++
      return { kind: ProfileReadinessKind.Ready as const, summary: "Explicit fixture readiness" }
    }
    const services = createGuideReviewServices({
      runner, cwd: target.cwd, context, catalog: world.catalog,
      env: { TRELLAGE_TEST_OFFLINE: "1", HERDR_SOCKET_PATH: "/fixture/unused-review-socket" },
      dependencies: {
        modelCall: unexpected, clientFactory: unexpected, readiness,
        listAgents: async () => busyWriter ? [{
          pane_id: "fixture-other-writer", agent: "copilot", agent_status: "working", cwd: target.cwd,
        }] : [],
        processReader: async (pane) => {
          assert(context?.surface === "pane", label)
          assert.equal(pane, context.paneId, label)
          return { pane_id: pane, foreground_processes: [{ pid: process.pid }] }
        },
      },
    })
    const execute = () => destination === "terminal"
      ? executeGuideReviewTerminal({ action: "review-terminal", request, selectedProfile: profile.profile }, {
          runner, readiness, context: null,
          runInteractive: async (command, options) => {
            assert.deepEqual(command, expectedCommand, label)
            assert.equal(options.cwd, target.cwd, label)
            assert.equal(options.env.TRELLAGE_AUTOMATION, "1", label)
            await beforeDispatch()
          },
        })
      : services.execute(request, profile.ref, new AbortController().signal)
    if (automaticRejected) {
      await assert.rejects(execute(), /Automatic/, label)
      assert.equal(allocations, 0, label)
      assert.equal(dispatches, 0, label)
      assert.equal(readinessChecks, 0, label)
      assert.equal((await store.read(review.id)).execution, "not-started", label)
      assert.equal(unexpectedCalls, 0, label)
      await rm(path.join(store.directory, `${review.id}.json`))
      continue
    }
    await assert.rejects(services.execute({ ...request, otherEditorsStopped: false }, profile.ref, new AbortController().signal), /Confirm that other agents/, label)
    assert.equal(allocations, 0, label)
    assert.equal(dispatches, 0, label)
    if (context !== null) {
      busyWriter = true
      await assert.rejects(execute(), /Agent in pane fixture-other-writer is working/, label)
      assert.equal(allocations, 0, label)
      assert.equal(dispatches, 0, label)
      assert.equal((await store.read(review.id)).execution, "not-started", label)
      busyWriter = false
    }
    const changedPath = target.changes.find((change) => change.kind === "file" && request.paths.includes(change.path))?.path
    assert(changedPath !== undefined, label)
    const changedFile = path.join(target.cwd, changedPath)
    const originalBytes = await readFile(changedFile)
    try {
      await writeFile(changedFile, Buffer.concat([originalBytes, Buffer.from("\nChanged after review.\n")]))
      await assert.rejects(execute(), /worktree or comparison base changed/, label)
      assert.equal(allocations, 0, label)
      assert.equal(dispatches, 0, label)
      assert.equal((await store.read(review.id)).execution, "not-started", label)
      assert.equal(readinessChecks, destination === "terminal" ? 1 : 0, label)
    } finally {
      await writeFile(changedFile, originalBytes)
    }
    if (dispatchFails) await assert.rejects(execute(), /Fixture dispatch acknowledgment lost/, label)
    else {
      const result = await execute()
      if (destination === "terminal") assert.equal(result, 0, label)
      else {
        assert(typeof result === "object", label)
        assert.equal(result.paneId, "fixture-review-destination", label)
      }
    }
    assert.equal((await store.read(review.id)).execution, dispatchFails ? "unknown" : "launched", label)
    assert.equal(dispatches, 1, label)
    assert.equal(allocations, destination === "terminal" ? 0 : 1, label)
    assert.equal(readinessChecks, destination === "terminal" ? 2 : 1, label)
    await assert.rejects(execute(), label)
    assert.equal(dispatches, 1, label)
    assert.equal(allocations, destination === "terminal" ? 0 : 1, label)
    assert.equal(unexpectedCalls, 0, label)
    await rm(path.join(store.directory, `${review.id}.json`))
  }
}
