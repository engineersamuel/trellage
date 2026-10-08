import { chmod, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { parseProfileGuide } from "@trellage/guide-core"
import { parseGuideCatalog } from "../src/guide-catalog.ts"
import { createNodeCommandRunner, type CommandRunner, type CommandSpec } from "../src/guide-launch.ts"
import * as launchTransport from "../src/guide-launch.ts"
import * as planningReadiness from "../src/guide-preflight.ts"
import { executeReviewPlanTerminal, executeReviewPlanWorktree } from "../src/review-planning.ts"
import {
  buildGuideOptimizePrompt,
  createGuideOptimizeServices,
  executeGuideOptimizeTerminal,
  runGuideOptimizeReview,
  type GuideOptimizeDependencies,
  type GuideOptimizeRequest,
} from "../src/guide-optimize.ts"
import { ProfileReadinessKind } from "../src/guide-preflight.ts"
import { fixtureProfile, guideSource } from "./fixtures/guide-integration-data.ts"
import { fixtureOptimizeModel } from "./fixtures/guide-optimize-model.ts"
import { SharedReviewStore as OptimizeReviewStore } from "../src/review-store.ts"
import { OptimizeReviewStore as LegacyStore } from "../src/guide-optimize-store.ts"
import { resolveGuideModelRouting } from "../src/guide-api.ts"
import { optimizeApproval, optimizeReviewDocument, sharedReviewDocument } from "../src/guide-optimize-review.ts"
import { reviewAuthority } from "../src/review-view-model.ts"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const catalog = parseGuideCatalog(
  JSON.stringify({
    schemaVersion: 1,
    sandboxCommandPath: "/fixture/trellage",
    sandbox: [],
    native: [
      {
        launcher: "copilot",
        name: "reviewer",
        harness: "copilot",
        description: "Fixture reviewer",
        commandPath: "/fixture/trx",
        sandbox: false,
        herdrCompatibility: { status: "supported" },
        guide: parseProfileGuide("native/copilot/reviewer.md", guideSource(fixtureProfile("reviewer"))).guide,
        headless: {
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
        },
      },
    ],
  }),
)

const fixture = async (namespace: "legacy" | "shared" = "shared") => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "guide-optimize-execution-")))
  roots.push(root)
  const realRunner = createNodeCommandRunner()
  const calls: { executable: string; args: ReadonlyArray<string>; cwd?: string }[] = []
  const split = vi.fn<() => Promise<void>>(async () => {})
  const launch = vi.fn<() => Promise<void>>(async () => {})
  const runner: CommandRunner = {
    async run(executable, args, options) {
      calls.push({ executable, args, ...(options?.cwd === undefined ? {} : { cwd: options.cwd }) })
      if (executable !== "herdr") return realRunner.run(executable, args, options)
      if (args[0] === "pane" && args[1] === "split") {
        await split()
        return { stdout: JSON.stringify({ result: { pane: { pane_id: "w1:new" } } }), stderr: "", exitCode: 0 }
      }
      if (args[0] === "tab" && args[1] === "create") {
        await split()
        return { stdout: JSON.stringify({ result: { root_pane: { pane_id: "w1:tab" } } }), stderr: "", exitCode: 0 }
      }
      if (args[0] === "pane" && args[1] === "run") {
        await launch()
        return { stdout: "", stderr: "", exitCode: 0 }
      }
      throw new Error(`Optimize must not inspect or prompt an existing agent: ${args.join(" ")}`)
    },
  }
  const git = async (...args: string[]) => (await runner.run("git", args, { cwd: root })).stdout
  await git("init", "--quiet", "-b", "main")
  await git("config", "user.name", "Fixture")
  await git("config", "user.email", "fixture@example.invalid")
  await git("config", "commit.gpgsign", "false")
  await git("config", "core.hooksPath", "/dev/null")
  await writeFile(path.join(root, "code.ts"), "before\n")
  await git("add", ".")
  await git("commit", "--quiet", "-m", "Fixture baseline")
  await git("branch", "base")
  await writeFile(path.join(root, "code.ts"), "committed\n")
  await git("commit", "--quiet", "-am", "Committed task change")
  await writeFile(path.join(root, "code.ts"), "staged\n")
  await git("add", "code.ts")
  await writeFile(path.join(root, "code.ts"), "after\n")
  const list = vi.fn<NonNullable<GuideOptimizeDependencies["listAgents"]>>(async () => [])
  const readiness = vi.fn<NonNullable<GuideOptimizeDependencies["readiness"]>>(async () => ({
    kind: ProfileReadinessKind.Ready,
    summary: "Ready",
  }))
  const modelCall = vi.fn<typeof fixtureOptimizeModel>(fixtureOptimizeModel)
  const processReader = vi.fn<NonNullable<GuideOptimizeDependencies["processReader"]>>(async () => ({
    pane_id: "w1:origin",
    foreground_processes: [{ pid: process.pid }],
  }))
  const options = {
    runner,
    cwd: root,
    context: {
      surface: "popup" as const,
      workspaceId: "w1",
      paneId: "w1:origin",
      cwd: "/not-the-target",
      capture: { source: "conversation-transcript" as const, confidence: "exact" as const, sessionId: "unavailable" },
    },
    catalog,
    dependencies: { listAgents: list, readiness, modelCall, processReader },
    env: { HERDR_SOCKET_PATH: "/fixture/unavailable-socket" },
  }
  const services = createGuideOptimizeServices(options)
  const signal = new AbortController().signal
  const approve = async (): Promise<GuideOptimizeRequest> => {
    const input = {
      target: await services.inspect({ kind: "branch", baseRef: "base" }, signal),
      paths: ["code.ts"],
      reviewerIds: ["first-principles", "behavior-preservation"],
      originalIntent: "  Preserve behavior.\r\nDo not remove the retry bound.  ",
      intent: "Approved goal: at most three attempts.",
    }
    const review = namespace === "shared"
      ? await services.review(input, signal, () => {})
      : await runGuideOptimizeReview(options, resolveGuideModelRouting({}, {}), input, signal, () => {})
    if (review.status !== "complete") throw new Error(review.error ?? "Review did not complete.")
    const approval = await services.approve(review.id, ["first-principles:1"], signal)
    return { ...input, approval, destination: "pane", otherEditorsStopped: true }
  }
  const request = await approve()
  return {
    root,
    git,
    runner,
    calls,
    split,
    launch,
    list,
    readiness,
    modelCall,
    processReader,
    options,
    services,
    signal,
    request,
    approve,
  }
}

describe("worktree-first Optimize execution", { timeout: 15_000 }, () => {
  it.each(["legacy", "shared"] as const)(
    "keeps %s history, display, planning and one-use execution bound to its saved authority", async (namespace) => {
      const f = await fixture(namespace)
      const id = f.request.approval.reviewId
      const authority = await reviewAuthority(f.request.target.gitDirectory, id)
      expect(authority.namespace).toBe(namespace)
      expect(await f.services.history(f.signal)).toEqual(expect.arrayContaining([expect.objectContaining({ id })]))
      const reopened = await f.services.readReview(id, f.signal)
      expect(reopened.schemaVersion).toBe(2)
      expect(reopened).not.toHaveProperty("shared")
      expect(reopened).not.toHaveProperty("reports")
      if (namespace === "legacy") {
        const original = await new LegacyStore(f.request.target.gitDirectory).read(id)
        expect(f.request.approval.reviewDigest).toBe(optimizeApproval(original, original.approvedIds).reviewDigest)
        expect(sharedReviewDocument(reopened)).toBe(optimizeReviewDocument(original))
      } else {
        expect(reopened).toEqual(await new OptimizeReviewStore(f.request.target.gitDirectory).read(id))
        expect(reopened.artifacts.some((artifact) => artifact.id === "synthesis:legacy-document")).toBe(false)
      }
      const services = createGuideOptimizeServices({
        ...f.options, catalog: { ...catalog, native: catalog.native.map((entry) => ({ ...entry, name: "hve" })) },
      })
      const result = await services.plan!(reopened, "terminal", f.signal)
      if (!("action" in result)) throw new Error("Expected terminal planning.")
      expect(result.namespace).toBe(namespace)
      const readiness = vi.spyOn(planningReadiness, "checkSelectedProfileReadiness").mockResolvedValue({
        kind: ProfileReadinessKind.Ready, summary: "Ready",
      })
      const interactive = vi.spyOn(launchTransport, "runInteractiveTerminalCommand").mockResolvedValue()
      try {
        await executeReviewPlanTerminal(result, f.runner)
        expect(interactive.mock.calls[0]![0].args.join(" "))
          .toContain(namespace === "legacy" ? "trellage-optimize-reviews" : "trellage-reviews")
      } finally { readiness.mockRestore(); interactive.mockRestore() }
      const tampered = { ...f.request.approval,
        findings: f.request.approval.findings.map((finding) => ({ ...finding, proposal: "Unauthorized change" })) }
      await expect(f.services.execute({ ...f.request, approval: tampered }, "native:cpx/reviewer", f.signal))
        .rejects.toThrow(/approval/iu)
      expect(f.launch).not.toHaveBeenCalled()
      await f.services.execute(f.request, "native:cpx/reviewer", f.signal)
      await expect(f.services.execute(f.request, "native:cpx/reviewer", f.signal)).rejects.toThrow(/launch|execution/u)
      expect(f.launch).toHaveBeenCalledOnce()
      expect((await f.services.readReview(id, f.signal)).execution).toBe("launched")
    },
  )

  it("rejects ambiguous record IDs and never falls back from a malformed shared record", async () => {
    const f = await fixture("legacy")
    const id = f.request.approval.reviewId
    const directory = f.request.target.gitDirectory
    const shared = await f.services.review({ ...f.request, reviewerIds: ["first-principles"] }, f.signal, () => {})
    const sharedDirectory = path.join(directory, "trellage-reviews")
    const store = new OptimizeReviewStore(directory)
    await store.save({ ...shared, id, status: "running", results: [], artifacts: [], challenges: [],
      decisions: [], approvedIds: [], execution: "not-started", synthesisStatus: "queued" })
    await expect(f.services.readReview(id, f.signal)).rejects.toThrow("ambiguous")
    expect((await new LegacyStore(directory).read(id)).schemaVersion).toBe(1)
    await rm(path.join(directory, "trellage-optimize-reviews", `${id}.snapshot.json`))
    await expect(f.services.readReview(id, f.signal)).rejects.toThrow("ambiguous")
    await rm(path.join(sharedDirectory, `${id}.json`))
    await expect(f.services.readReview(id, f.signal)).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(path.join(sharedDirectory, `${shared.id}.json`), "{invalid", { mode: 0o600 })
    await expect(f.services.readReview(shared.id, f.signal)).rejects.toThrow()
  })

  it("plans incomplete reports in the terminal but never copies dirty changes to a new worktree", async () => {
    const f = await fixture()
    const store = new OptimizeReviewStore(f.request.target.gitDirectory)
    const saved = await store.read(f.request.approval.reviewId)
    const incomplete = { ...saved, id: crypto.randomUUID(), status: "incomplete" as const, approvedIds: [],
      error: "One check did not finish." }
    await store.save({ ...incomplete, status: "running" })
    await store.save(incomplete)
    const services = createGuideOptimizeServices({
      ...f.options, catalog: { ...catalog, native: catalog.native.map((entry) => ({ ...entry, name: "hve" })) },
    })
    const result = await services.plan!(incomplete, "terminal", f.signal)
    if (!("action" in result)) throw new Error("Expected a terminal planning handoff.")
    const readiness = vi.spyOn(planningReadiness, "checkSelectedProfileReadiness").mockResolvedValue({
      kind: ProfileReadinessKind.Ready, summary: "Ready",
    })
    const interactive = vi.spyOn(launchTransport, "runInteractiveTerminalCommand").mockResolvedValue()
    try {
      await executeReviewPlanTerminal(result, f.runner)
      const command = interactive.mock.calls[0]![0]
      expect(command.args).toContain("--plan")
      expect(command.args.join(" ")).toContain("Plan fixes only. Do not edit")
      expect(command.args.join(" ")).toContain("incomplete")
      expect(command.args).not.toContain("--allow-all")
      await expect(executeReviewPlanWorktree(result, f.runner, f.options.context, f.signal))
        .rejects.toThrow("clean source")
      expect(f.calls.filter((call) => call.executable === "herdr")).toEqual([])
      expect((await store.read(incomplete.id)).execution).toBe("not-started")
    } finally {
      readiness.mockRestore()
      interactive.mockRestore()
    }
  })

  it("does not discover optional Native profiles until a handoff is requested", async () => {
    const discover = vi.fn<CommandRunner["run"]>(async () => ({
      stdout: JSON.stringify(catalog), stderr: "", exitCode: 0,
    }))
    const services = createGuideOptimizeServices({
      cwd: process.cwd(), context: null, runner: { run: discover },
      catalog: { ...catalog, native: [] },
      env: { TRELLAGE_REVIEW_PROFILE_COMMAND: "/fixture/trx" },
    })
    expect(services.profiles).toEqual([])
    expect(discover).not.toHaveBeenCalled()
    await services.refreshProfiles?.(new AbortController().signal)
    expect(discover).toHaveBeenCalledWith("/fixture/trx", ["guide", "--review"],
      expect.objectContaining({ env: expect.objectContaining({ TRELLAGE_REVIEW_PROFILES_ONLY: "1" }) }))
    expect(services.profiles.map((entry) => entry.ref)).toEqual(["native:cpx/reviewer"])
  })

  it("requires saved approval for automatic hve and reserves its same-worktree tab once", async () => {
    const f = await fixture()
    const services = createGuideOptimizeServices({
      ...f.options,
      catalog: { ...catalog, native: catalog.native.map((entry) => ({ ...entry, name: "hve" })) },
    })
    const request = { ...f.request, automatic: true as const, destination: "tab" as const }
    await expect(services.execute({ ...request, destination: "pane" }, "native:cpx/hve", f.signal))
      .rejects.toThrow(/tab/u)
    await expect(services.execute({ ...request, approval: { ...request.approval, reviewDigest: "0".repeat(64) } },
      "native:cpx/hve", f.signal)).rejects.toThrow(/approval/iu)
    expect(f.calls.filter((call) => call.executable === "herdr")).toEqual([])
    await services.execute(request, "native:cpx/hve", f.signal)
    const launch = f.calls.find((call) => call.executable === "herdr" && call.args[1] === "run")
    expect(launch?.args.join(" ")).toContain("autopilot")
    expect(launch?.args.join(" ")).toContain("--allow-all")
    expect(launch?.args.join(" ")).toContain("approved findings")
    await expect(services.execute(request, "native:cpx/hve", f.signal)).rejects.toThrow(/launch|execution/u)
    expect(f.launch).toHaveBeenCalledTimes(1)
  })

  it("binds the approved findings to committed and current work without source-session identity", async () => {
    const f = await fixture()
    expect(f.request.target.cwd).toBe(f.root)
    expect(f.request.target.changes).toEqual([
      expect.objectContaining({ path: "code.ts", committed: true, staged: true, unstaged: true }),
    ])
    expect(f.list).not.toHaveBeenCalled()
    expect(f.readiness).not.toHaveBeenCalled()
    expect(f.calls.filter((call) => call.executable === "herdr")).toEqual([])
    const prompt = buildGuideOptimizePrompt(f.request)
    expect(prompt).toContain("Implement only the explicitly approved")
    expect(prompt).toContain("Remove the redundant wrapper")
    expect(prompt).toContain(`## Original task (unchanged)\n${f.request.originalIntent}`)
    expect(prompt).toContain("Approved goal: at most three attempts.")
    expect(prompt).toContain('"selectedPaths": [\n    "code.ts"\n  ]')
    expect(prompt).toContain("Do not stage, commit, stash, reset, or discard changes.")
    expect(prompt).not.toContain("sessionId")
    expect(() => buildGuideOptimizePrompt({ ...f.request, paths: ["outside.ts"] })).toThrow("not part")
  })

  it("starts a fresh agent through normal argv delivery in the same worktree and preserves staging", async () => {
    const f = await fixture()
    const index = await f.git("diff", "--cached")
    const receipt = await f.services.execute(f.request, "native:copilot/reviewer", f.signal)
    expect(receipt.paneId).toBe("w1:new")
    const commands = f.calls.filter((call) => call.executable === "herdr")
    expect(commands[0]).toEqual({
      executable: "herdr",
      cwd: f.root,
      args: ["pane", "split", "--pane", "w1:origin", "--cwd", f.root, "--direction", "right", "--no-focus"],
    })
    expect(commands).toHaveLength(2)
    expect(commands[1]?.cwd).toBe(f.root)
    expect(commands[1]?.args.slice(0, 3)).toEqual(["pane", "run", "w1:new"])
    expect(commands[1]?.args[3]).toContain("env TRELLAGE_AUTOMATION=1 /fixture/trx run copilot reviewer -i ")
    expect(commands[1]?.args[3]).toContain('"selectedPaths"')
    expect(commands[1]?.args[3]).toContain("Do not remove the retry bound.")
    expect(await f.git("diff", "--cached")).toBe(index)
    expect(f.launch).toHaveBeenCalledOnce()
  })

  it("requires confirmation and refuses another active writer without allocating a pane", async () => {
    const f = await fixture()
    await expect(
      f.services.execute({ ...f.request, otherEditorsStopped: false }, "native:copilot/reviewer", f.signal),
    ).rejects.toThrow("Confirm")
    f.list.mockResolvedValue([{ pane_id: "other", agent: "copilot", agent_status: "working", cwd: f.root }])
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("Stop or finish")
    f.list.mockResolvedValue([{ pane_id: "other", agent: "copilot", agent_status: "working" }])
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      "no verified working directory",
    )
    expect(f.split).not.toHaveBeenCalled()
  })

  it("does not mistake its verified foreground Guide process for a writer during profile checks", async () => {
    const f = await fixture()
    const caller = { pane_id: "w1:origin", agent: "copilot", agent_status: "unknown", cwd: f.root }
    f.list.mockResolvedValue([caller])
    f.split.mockImplementationOnce(async () => {
      f.list.mockResolvedValue([caller, { pane_id: "w1:new", agent: "copilot", agent_status: "unknown", cwd: f.root }])
    })
    const services = createGuideOptimizeServices({
      ...f.options,
      context: { ...f.options.context, surface: "pane" },
    })
    expect((await services.execute(f.request, "native:copilot/reviewer", f.signal)).paneId).toBe("w1:new")
    expect(f.processReader).toHaveBeenCalledWith("w1:origin", {
      socketPath: "/fixture/unavailable-socket",
      signal: f.signal,
    })
    expect(f.launch).toHaveBeenCalledOnce()
  })

  it("still blocks other writers when the Guide owns its foreground pane", async () => {
    const f = await fixture()
    f.list.mockResolvedValue([
      { pane_id: "w1:origin", agent: "copilot", agent_status: "unknown", cwd: f.root },
      { pane_id: "w1:other", agent: "copilot", agent_status: "working", cwd: f.root },
    ])
    const services = createGuideOptimizeServices({
      ...f.options,
      context: { ...f.options.context, surface: "pane" },
    })
    await expect(services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("w1:other")
    expect(f.split).not.toHaveBeenCalled()
  })

  it("does not exempt a borrowed pane or the agent underneath a popup", async () => {
    const f = await fixture()
    f.list.mockResolvedValue([{ pane_id: "w1:origin", agent: "copilot", agent_status: "working", cwd: f.root }])
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("Stop or finish")
    expect(f.processReader).not.toHaveBeenCalled()
    f.processReader.mockResolvedValue({
      pane_id: "w1:origin",
      foreground_processes: [{ pid: process.pid + 1 }],
    })
    const services = createGuideOptimizeServices({
      ...f.options,
      context: { ...f.options.context, surface: "pane" },
    })
    await expect(services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("Stop or finish")
    expect(f.split).not.toHaveBeenCalled()
  })

  it("fails closed when foreground process ownership cannot be verified", async () => {
    const f = await fixture()
    const services = createGuideOptimizeServices({
      ...f.options,
      context: { ...f.options.context, surface: "pane" },
    })
    f.processReader.mockResolvedValueOnce({
      pane_id: "w1:other",
      foreground_processes: [{ pid: process.pid }],
    })
    await expect(services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("different Guide pane")
    f.processReader.mockResolvedValueOnce({ pane_id: "w1:origin" })
    await expect(services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("must be an array")
    f.processReader.mockRejectedValueOnce(new Error("Process metadata unavailable"))
    await expect(services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      "Process metadata unavailable",
    )
    expect(f.split).not.toHaveBeenCalled()
  })

  it("preserves metadata lookup failures instead of treating writer status as safe", async () => {
    const f = await fixture()
    f.list.mockRejectedValue(new Error("Herdr unavailable"))
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("Herdr unavailable")
    expect(f.split).not.toHaveBeenCalled()
  })

  it("rejects stale files, index, or base before launching", async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, "code.ts"), "changed after confirmation\n")
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      "worktree or comparison base changed",
    )
    expect(f.launch).not.toHaveBeenCalled()
  })

  it("rechecks after preparation and after pane allocation without retrying", async () => {
    const f = await fixture()
    f.readiness.mockImplementationOnce(async () => {
      await writeFile(path.join(f.root, "code.ts"), "changed during preparation\n")
      return { kind: ProfileReadinessKind.Ready, summary: "Ready" }
    })
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      "worktree or comparison base changed",
    )
    expect(f.split).not.toHaveBeenCalled()
    const request = await f.approve()
    f.split.mockImplementationOnce(async () => {
      await writeFile(path.join(f.root, "code.ts"), "changed during allocation\n")
    })
    await expect(f.services.execute(request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      "New agent pane w1:new remains open",
    )
    expect(f.split).toHaveBeenCalledOnce()
    expect(f.launch).not.toHaveBeenCalled()
  })

  it("does not allocate a pane for an invalid profile or changed approval context", async () => {
    const f = await fixture()
    await expect(f.services.execute(f.request, "native:firstmate/default", f.signal)).rejects.toThrow("no longer available")
    await expect(
      f.services.execute({ ...f.request, originalIntent: "x".repeat(60_000) }, "native:copilot/reviewer", f.signal),
    ).rejects.toThrow(/prompt limit|context differs/u)
    expect(f.split).not.toHaveBeenCalled()
  })

  it("preserves an unsafe lock path rather than following or replacing it", async () => {
    const f = await fixture()
    const lock = path.join(f.request.target.gitDirectory, "trellage-optimize.lock")
    await symlink("/does/not/exist/foreign-lock", lock)
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("lock path is unsafe")
    expect(await readlink(lock)).toBe("/does/not/exist/foreign-lock")
  })

  it("serializes submissions and never retries an uncertain launch", async () => {
    const f = await fixture()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.launch.mockImplementationOnce(async () => {
      entered()
      return waiting
    })
    const first = f.services.execute(f.request, "native:copilot/reviewer", f.signal)
    try {
      await Promise.race([started, first])
      expect(f.launch).toHaveBeenCalledOnce()
      await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
        /already|held|unlaunched/u,
      )
    } finally {
      release()
      await first
    }
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("unlaunched")
    const another = await f.approve()
    f.launch.mockRejectedValueOnce(new Error("Launch acknowledgment lost"))
    await expect(f.services.execute(another, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      "Inspect it before retrying; no automatic resend",
    )
    await expect(f.services.execute(another, "native:copilot/reviewer", f.signal)).rejects.toThrow("unlaunched")
    expect((await f.services.readReview(another.approval.reviewId, f.signal)).execution).toBe("unknown")
    expect(f.launch).toHaveBeenCalledTimes(2)
  })

  it.each([
    ["copilot", false, "-i"],
    ["copilot", true, "-i"],
    ["codex", false, "--"],
    ["codex", true, "--"],
    ["claude", false, "--"],
    ["claude", true, "--"],
  ] as const)(
    "starts %s interactively with headlessPrompt=%s and preserves the scope and index",
    async (launcher, headlessPrompt, promptFlag) => {
      const f = await fixture()
      const profile = f.services.profiles[0]
      if (profile === undefined) throw new Error("Fixture profile is missing")
      const runs: { command: CommandSpec; cwd: string }[] = []
      const index = await f.git("diff", "--cached")
      const transport = vi
        .spyOn(launchTransport, "runInteractiveTerminalCommand")
        .mockImplementation(async (command, options) => {
          if (options?.cwd === undefined) throw new Error("Missing reviewed worktree")
          runs.push({ command, cwd: options.cwd })
        })
      try {
        const result = await executeGuideOptimizeTerminal(
          {
            action: "optimize-terminal",
            request: { ...f.request, destination: "terminal" },
            selectedProfile: {
              ...profile.profile,
              launcher,
              commandPath: `/fixture/${launcher}`,
              headlessPrompt,
            },
          },
          {
            runner: f.runner,
            readiness: f.readiness,
            context: null,
          },
        )
        expect(result).toBe(0)
        expect(runs).toEqual([
          {
            command: {
              executable: `/fixture/${launcher}`,
              args: ["run", launcher, "reviewer", promptFlag, buildGuideOptimizePrompt(f.request)],
            },
            cwd: f.root,
          },
        ])
        expect(await f.git("diff", "--cached")).toBe(index)
        expect(f.list).not.toHaveBeenCalled()
        expect(transport).toHaveBeenCalledOnce()
        expect(
          (await new OptimizeReviewStore(f.request.target.gitDirectory).read(f.request.approval.reviewId)).execution,
        ).toBe("launched")
      } finally {
        transport.mockRestore()
      }
    },
  )

  it("requires the persisted human approval and rejects altered findings", async () => {
    const f = await fixture()
    const store = new OptimizeReviewStore(f.request.target.gitDirectory)
    const saved = await store.read(f.request.approval.reviewId)
    const altered = {
      ...f.request,
      approval: {
        ...f.request.approval,
        findings: f.request.approval.findings.map((entry) => ({ ...entry, proposal: "Do unrelated work." })),
      },
    }
    await expect(f.services.execute(altered, "native:copilot/reviewer", f.signal)).rejects.toThrow("Approval differs")
    expect(saved.approvedIds).toEqual(["first-principles:1"])
    expect(f.launch).not.toHaveBeenCalled()
  })

  it("reports the allocated pane and blocks resubmission if saving its receipt fails", async () => {
    const f = await fixture()
    const store = new OptimizeReviewStore(f.request.target.gitDirectory)
    f.launch.mockImplementationOnce(async () => {
      await chmod(store.directory, 0o500)
    })
    try {
      await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
        "New agent pane w1:new remains open",
      )
    } finally {
      await chmod(store.directory, 0o700)
    }
    expect((await store.read(f.request.approval.reviewId)).execution).toBe("launching")
    await expect(f.services.execute(f.request, "native:copilot/reviewer", f.signal)).rejects.toThrow("unlaunched")
    expect(f.launch).toHaveBeenCalledOnce()
  })

  it("supports a same-worktree Herdr tab without making a clean worktree copy", async () => {
    const f = await fixture()
    const receipt = await f.services.execute({ ...f.request, destination: "tab" }, "native:copilot/reviewer", f.signal)
    expect(receipt.paneId).toBe("w1:tab")
    expect(f.calls.filter((entry) => entry.executable === "herdr").map((entry) => entry.args.slice(0, 2))).toEqual([
      ["tab", "create"],
      ["pane", "run"],
    ])
  })

  it.each(["pane", "tab"] as const)("rechecks hidden related context after %s allocation", async (destination) => {
    const f = await fixture()
    await writeFile(path.join(f.root, "context.ts"), "original context\n")
    await f.git("add", "context.ts")
    await f.git("commit", "--quiet", "-m", "Context")
    await f.git("branch", "-f", "base", "HEAD")
    await f.git("update-index", "--assume-unchanged", "context.ts")
    const request = { ...(await f.approve()), destination }
    f.split.mockImplementationOnce(async () => {
      await writeFile(path.join(f.root, "context.ts"), "unreviewed context\n")
    })
    const paneId = destination === "pane" ? "w1:new" : "w1:tab"
    await expect(f.services.execute(request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      `New agent pane ${paneId} remains open. Review context changed. Run a new review before implementation. Inspect it before retrying; no automatic resend.`,
    )
    expect(f.split).toHaveBeenCalledOnce()
    expect(f.launch).not.toHaveBeenCalled()
    expect(
      f.calls.some((call) => call.executable === "herdr" && call.args[0] === "pane" && call.args[1] === "run"),
    ).toBe(false)
    expect((await f.services.readReview(request.approval.reviewId, f.signal)).execution).toBe("not-started")
  })

  it("detects changed related context even when Git hides its worktree changes", async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, "context.ts"), "original context\n")
    await f.git("add", "context.ts")
    await f.git("commit", "--quiet", "-m", "Context")
    const request = await f.approve()
    await f.git("update-index", "--assume-unchanged", "context.ts")
    await writeFile(path.join(f.root, "context.ts"), "unreviewed context\n")
    await expect(f.services.execute(request, "native:copilot/reviewer", f.signal)).rejects.toThrow(
      /Review context changed|worktree or comparison base changed/u,
    )
    expect(f.launch).not.toHaveBeenCalled()
  })
})
