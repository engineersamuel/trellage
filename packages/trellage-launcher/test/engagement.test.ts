import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ModelInfo } from "@github/copilot-sdk"
import type { RestrictedGuideModelRequest } from "../src/copilot-guide-provider.ts"
import {
  assertEngagementSnapshotCurrent,
  captureEngagementSnapshot,
  defaultEngagementSources,
  engagementDefaultIntent,
  engagementLimits,
  engagementPath,
  inspectEngagementRepository,
  parseEngagementSnapshot,
  readEngagementFile,
} from "../src/engagement-context.ts"
import {
  createEngagementAssessor,
  EngagementAssessmentResponseError,
  engagementWorkflows,
  parseEngagementAssessment,
} from "../src/engagement-assessment.ts"
import { EngagementWorkStore, engagementLaunchPlan, engagementResultDocument } from "../src/engagement-work.ts"
import { executeEngagementWork } from "../src/engagement-execution.ts"
import { CommandRunnerError } from "../src/guide-launch.ts"
import { ProfileReadinessKind } from "../src/guide-preflight.ts"
import { parseGuideHeadlessArgv } from "../src/guide-api.ts"
import {
  createEngagementFixture,
  engagementAssessment,
  engagementCitation,
  engagementGuideRoot,
  engagementSource,
  engagementSourcePath,
} from "./helpers/engagement-fixtures.ts"

let root: string
let fixture: Awaited<ReturnType<typeof createEngagementFixture>>
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "trellage-engagement-"))
  fixture = await createEngagementFixture(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("repository engagement evidence", () => {
  it("opens read-only, preserves existing paths, and discovers ignored canonical HVE state", async () => {
    const statePath = ".copilot-tracking/dt/existing/coaching-state.md"
    const state = "project: existing\ncurrent:\n  method: 2\nextension:\n  customer-field: retained\n"
    await mkdir(path.dirname(path.join(root, statePath)), { recursive: true })
    await writeFile(path.join(root, statePath), state)
    await writeFile(path.join(root, ".gitignore"), ".copilot-tracking/\n")
    await writeFile(path.join(root, "secret.env"), "not selected")
    const repository = await inspectEngagementRepository(fixture.runner, root)
    expect(repository.selected).toEqual([statePath, engagementSourcePath])
    const snapshot = await captureEngagementSnapshot(fixture.runner, repository.root, repository.selected, "")
    expect(snapshot.sources[0]).toMatchObject({ path: statePath, content: state, tracked: false })
    expect(await readdir(root)).not.toContain("engagement")
    expect(snapshot.sources.some((source) => source.content.includes("not selected"))).toBe(false)
    expect(await readFile(path.join(root, statePath), "utf8")).toBe(state)
  })

  it("uses explicit source mapping without moving files or assuming a folder layout", async () => {
    await mkdir(path.join(root, "ExistingNotes"))
    await writeFile(path.join(root, "ExistingNotes/customer.txt"), "Existing customer evidence.")
    await mkdir(path.join(root, "engagement"))
    await writeFile(
      path.join(root, "engagement/guide.json"),
      JSON.stringify({
        schemaVersion: 1,
        sources: ["ExistingNotes/customer.txt"],
      }),
    )
    expect((await inspectEngagementRepository(fixture.runner, root)).selected).toEqual(["ExistingNotes/customer.txt"])
    await writeFile(path.join(root, "engagement/guide.json"), JSON.stringify({ schemaVersion: 2, sources: [] }))
    await expect(inspectEngagementRepository(fixture.runner, root)).rejects.toThrow("schemaVersion")
  })

  it("prefers project status and decision documents when no engagement folder exists", () => {
    expect(
      defaultEngagementSources([
        "AGENTS.md",
        "README.md",
        "architecture/README.md",
        "architecture/decisions/ADR-0001-platform.md",
        "docs/decision-intelligence-architecture-recommendations.md",
        "docs/open-questions.md",
        "docs/pfizer-case-lifecycle-clarification.md",
        "docs/unrelated.md",
      ]),
    ).toEqual([
      "README.md",
      "docs/open-questions.md",
      "docs/decision-intelligence-architecture-recommendations.md",
      "docs/pfizer-case-lifecycle-clarification.md",
      "architecture/README.md",
    ])
  })

  it("rejects path escapes, symlinks, hard links, invalid UTF-8, and terminal control text", async () => {
    for (const filename of [
      "../outside.md",
      "/outside.md",
      ".git/config",
      ".GIT/config",
      ".SSH/key.md",
      "docs/../outside.md",
      "docs\\outside.md",
      ".env",
      ".ENV.local",
    ]) {
      expect(() => engagementPath(filename)).toThrow("Unsafe")
    }
    await symlink(path.join(root, engagementSourcePath), path.join(root, "link.md"))
    await link(path.join(root, engagementSourcePath), path.join(root, "hard.md"))
    await expect(readEngagementFile(root, "link.md")).rejects.toThrow("regular")
    await expect(readEngagementFile(root, "hard.md")).rejects.toThrow("single-link")
    await symlink(path.join(root, "docs"), path.join(root, "linked"))
    await expect(readEngagementFile(root, "linked/engagement/overview.md")).rejects.toThrow("real directories")
    await writeFile(path.join(root, "invalid.md"), Buffer.from([0xff]))
    await expect(readEngagementFile(root, "invalid.md")).rejects.toThrow(TypeError)
    await writeFile(path.join(root, "controls.md"), "\u001b]52;c;payload\u0007")
    await expect(readEngagementFile(root, "controls.md")).rejects.toThrow("control")
  })

  it("enforces exact byte and aggregate limits without truncating evidence", async () => {
    for (const filename of ["one.md", "two.md", "three.md"])
      await writeFile(path.join(root, filename), "a".repeat(engagementLimits.fileBytes))
    expect((await readEngagementFile(root, "one.md")).length).toBe(engagementLimits.fileBytes)
    const full = await captureEngagementSnapshot(fixture.runner, fixture.repository.root, ["one.md", "two.md"], "")
    expect(full.sources.reduce((total, source) => total + Buffer.byteLength(source.content), 0)).toBe(
      engagementLimits.snapshotBytes,
    )
    await expect(
      captureEngagementSnapshot(fixture.runner, fixture.repository.root, ["one.md", "two.md", "three.md"], ""),
    ).rejects.toThrow("nothing was truncated")
    await writeFile(path.join(root, "one.md"), "a".repeat(engagementLimits.fileBytes + 1))
    await expect(readEngagementFile(root, "one.md")).rejects.toThrow("64000 bytes")
    await writeFile(path.join(root, "one.md"), "😀".repeat(16_001))
    await expect(readEngagementFile(root, "one.md")).rejects.toThrow("64000 bytes")
  })

  it("uses current dirty content but refuses stale snapshots and altered stored bytes", async () => {
    const snapshot = fixture.snapshot
    expect(parseEngagementSnapshot(snapshot)).toEqual(snapshot)
    await writeFile(path.join(root, engagementSourcePath), `${engagementSource}A new interview has occurred.\n`)
    await expect(assertEngagementSnapshotCurrent(fixture.runner, fixture.repository.root, snapshot)).rejects.toThrow(
      "changed",
    )
    const dirty = await captureEngagementSnapshot(
      fixture.runner,
      fixture.repository.root,
      [engagementSourcePath],
      "Human clarification",
    )
    expect(dirty.sources[0]?.content).toContain("A new interview")
    expect(() =>
      parseEngagementSnapshot({
        ...snapshot,
        sources: snapshot.sources.map((source) => ({ ...source, content: "replaced" })),
      }),
    ).toThrow("digest")
    await expect(fixture.prepare()).rejects.toThrow("changed")
    expect(await fixture.store.list()).toEqual([])
  })
})

describe("evidence-backed engagement assessment", () => {
  it("validates exact citations and allows multiple actions on one HVE profile", () => {
    const first = engagementAssessment.actions[0]!
    const result = parseEngagementAssessment(
      {
        ...engagementAssessment,
        actions: [
          first,
          {
            ...first,
            title: "Test the uncertainty",
            workflow: { profileRef: "native:cpx/hve", workflowId: "test-assumption" },
          },
        ],
      },
      fixture.snapshot,
      engagementWorkflows(fixture.catalog),
    )
    expect(result.actions).toHaveLength(2)
    expect(result.actions.map((action) => action.workflow?.profileRef)).toEqual(["native:cpx/hve", "native:cpx/hve"])
    for (const [citation, message] of [
      [{ ...engagementCitation, path: "not-shared.md" }, "not shared"],
      [{ ...engagementCitation, startLine: 1.5 }, "integers"],
      [{ ...engagementCitation, endLine: 100 }, "must be between"],
      [{ ...engagementCitation, quote: "Invented customer signoff" }, "does not occur"],
    ] as const) {
      expect(() =>
        parseEngagementAssessment(
          {
            ...engagementAssessment,
            actions: [{ ...first, citations: [citation] }],
          },
          fixture.snapshot,
          engagementWorkflows(fixture.catalog),
        ),
      ).toThrow(message)
    }
    for (const [action, message] of [
      [{ ...first, command: "untrusted command" }, "unsupported keys"],
      [{ ...first, workflow: { profileRef: "native:cpx/hve", workflowId: "invented" } }, "unavailable"],
    ] as const) {
      expect(() =>
        parseEngagementAssessment(
          { ...engagementAssessment, actions: [action] },
          fixture.snapshot,
          engagementWorkflows(fixture.catalog),
        ),
      ).toThrow(message)
    }
  })

  it("supports one material question, human-only actions, and no further action", () => {
    for (const outcome of ["needs-clarification", "no-action"] as const) {
      const assessment = {
        ...engagementAssessment,
        outcome,
        actions: [],
        question: outcome === "needs-clarification" ? "Which decision must the workshop support?" : null,
      }
      expect(parseEngagementAssessment(assessment, fixture.snapshot, engagementWorkflows(fixture.catalog))).toEqual(
        assessment,
      )
    }
    const human = { ...engagementAssessment, actions: [{ ...engagementAssessment.actions[0]!, workflow: null }] }
    expect(parseEngagementAssessment(human, fixture.snapshot, [])).toEqual(human)
    expect(() =>
      parseEngagementAssessment(
        { ...engagementAssessment, question: "Unrelated question?" },
        fixture.snapshot,
        engagementWorkflows(fixture.catalog),
      ),
    ).toThrow("outcome")
  })

  it("keeps human clarification distinct from repository evidence", async () => {
    const snapshot = await captureEngagementSnapshot(
      fixture.runner,
      fixture.repository.root,
      [engagementSourcePath],
      "The workshop must select interview participants.",
    )
    const assessment = {
      ...engagementAssessment,
      actions: [
        {
          ...engagementAssessment.actions[0]!,
          citations: [{ path: "@user-context", startLine: 1, endLine: 1, quote: "select interview participants" }],
        },
      ],
    }
    expect(
      parseEngagementAssessment(assessment, snapshot, engagementWorkflows(fixture.catalog)).actions[0]?.citations[0]
        ?.path,
    ).toBe("@user-context")
    expect(() => parseEngagementAssessment(assessment, fixture.snapshot, engagementWorkflows(fixture.catalog))).toThrow(
      "not shared",
    )
  })

  it("sends only the selected evidence in a tool-restricted request and never silently retries bad output", async () => {
    const model: ModelInfo = {
      id: "fixture-model",
      name: "Fixture model",
      capabilities: {
        supports: { vision: false, reasoningEffort: true },
        limits: { max_context_window_tokens: 128_000 },
      },
    }
    const request = vi.fn<(options: RestrictedGuideModelRequest) => Promise<string>>(async (options) => {
      options.inspectModel(model)
      expect(JSON.parse(options.prompt).untrustedData.snapshot).toEqual(fixture.snapshot)
      expect(options.systemPrompt).toContain("untrusted data")
      expect(options).not.toHaveProperty("workingDirectory")
      return JSON.stringify(engagementAssessment)
    })
    const assessor = createEngagementAssessor(fixture.catalog, { model: "fixture-model", effort: "high" }, request)
    expect(request).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    expect(await assessor(fixture.snapshot, engagementDefaultIntent, signal)).toEqual(engagementAssessment)
    expect(request.mock.calls[0]?.[0].signal).toBe(signal)
    request.mockImplementationOnce(async () => "not JSON")
    const invalidResponse = await assessor(fixture.snapshot, engagementDefaultIntent, signal).catch((error) => error)
    expect(invalidResponse).toBeInstanceOf(EngagementAssessmentResponseError)
    expect(invalidResponse).toHaveProperty("cause", expect.any(SyntaxError))
    expect(invalidResponse).toHaveProperty("message", expect.stringContaining("no recommendation was accepted"))
    expect(request).toHaveBeenCalledTimes(2)
    request.mockImplementationOnce(async (options) => {
      options.inspectModel({
        ...model,
        capabilities: { ...model.capabilities, limits: { max_context_window_tokens: 1000 } },
      })
      throw new Error("Must stop before inference")
    })
    await expect(assessor(fixture.snapshot, engagementDefaultIntent, signal)).rejects.toThrow("nothing was omitted")
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(assessor(fixture.snapshot, engagementDefaultIntent, cancelled.signal)).rejects.toThrow(/aborted/iu)
    expect(request).toHaveBeenCalledTimes(3)
  })
})

describe("reviewed assignment lifecycle", () => {
  const readiness = async () => ({ kind: ProfileReadinessKind.Ready, summary: "Fixture ready" }) as const

  it("saves one exact assignment, launches only its authored interactive workflow, and awaits human review", async () => {
    const work = await fixture.prepare()
    expect(work.status).toBe("prepared")
    expect(work.request.prompt).toContain("engagement/work/")
    expect(work.request.prompt.startsWith("Work with me as DT Coach.")).toBe(true)
    const reopened = new EngagementWorkStore(fixture.repository.root, fixture.catalog, fixture.runner)
    expect(await reopened.list()).toEqual([work])
    const otherCatalog = { ...fixture.catalog, native: [] }
    expect(await new EngagementWorkStore(fixture.repository.root, otherCatalog, fixture.runner).list()).toEqual([work])
    await expect(
      engagementLaunchPlan(work, reopened, otherCatalog, engagementGuideRoot, fixture.runner),
    ).rejects.toThrow("Unknown profile")
    const runInteractive = vi.fn<() => Promise<void>>(async () => {
      expect((await reopened.read(work.request.id)).status).toBe("launching")
      await writeFile(path.join(root, "docs/engagement/workshop.md"), "Draft activities; customer review pending.\n")
    })
    const launch = await engagementLaunchPlan(work, reopened, fixture.catalog, engagementGuideRoot, fixture.runner)
    const result = await executeEngagementWork(work, reopened, fixture.catalog, engagementGuideRoot, {
      runner: fixture.runner,
      write: () => {},
      checkReadiness: readiness,
      runInteractive,
    })
    expect(result.work).toMatchObject({ status: "returned", exitCode: 0, review: null })
    expect(runInteractive).toHaveBeenCalledOnce()
    expect(launch.command.args.slice(0, 4)).toEqual(["interactive", "hve", "--agent", "hve-core:dt-coach"])
    expect(launch.command.args).not.toContain("--autopilot")
    expect(await engagementResultDocument(result.work, reopened, fixture.runner)).toContain("workshop.md")
    await expect(
      engagementLaunchPlan(result.work, reopened, fixture.catalog, engagementGuideRoot, fixture.runner),
    ).rejects.toThrow("unlaunched")
    const reviewed = await reopened.review(
      result.work,
      "Reviewed docs/engagement/workshop.md. Customer availability remains unknown.",
      "recorded",
    )
    await reopened.exportReview(reviewed)
    const repository = await inspectEngagementRepository(fixture.runner, root)
    expect(repository.selected).toContain(`engagement/work/${work.request.id}.md`)
    expect(await readFile(path.join(root, `engagement/work/${work.request.id}.md`), "utf8")).toContain(
      "not customer signoff",
    )
    expect((await reopened.read(work.request.id)).request).toEqual(work.request)
  })

  it("rechecks sources after readiness and does not launch or automatically retry uncertain work", async () => {
    const work = await fixture.prepare()
    const runInteractive = vi.fn<() => Promise<void>>(async () => {})
    const result = await executeEngagementWork(work, fixture.store, fixture.catalog, engagementGuideRoot, {
      runner: fixture.runner,
      write: () => {},
      runInteractive,
      checkReadiness: async () => {
        await writeFile(path.join(root, engagementSourcePath), "Source changed during readiness.")
        return readiness()
      },
    })
    expect(result.work.status).toBe("unknown")
    expect(result.notice).toContain("changed")
    expect(runInteractive).not.toHaveBeenCalled()
    await expect(
      executeEngagementWork(result.work, fixture.store, fixture.catalog, engagementGuideRoot, {
        runner: fixture.runner,
        write: () => {},
        checkReadiness: readiness,
        runInteractive,
      }),
    ).rejects.toThrow("unlaunched")
  })

  it("records nonzero exits without approval and preserves transport failures as unknown", async () => {
    const work = await fixture.prepare()
    const result = await executeEngagementWork(work, fixture.store, fixture.catalog, engagementGuideRoot, {
      runner: fixture.runner,
      write: () => {},
      checkReadiness: readiness,
      runInteractive: async () => {
        throw new CommandRunnerError({
          kind: "exited",
          executable: "/fixture/cpx",
          args: [],
          exitCode: 42,
          message: "fixture failed",
        })
      },
    })
    expect(result.work).toMatchObject({ status: "returned", exitCode: 42, review: null })
    const another = await fixture.prepare()
    const failed = await executeEngagementWork(another, fixture.store, fixture.catalog, engagementGuideRoot, {
      runner: fixture.runner,
      write: () => {},
      checkReadiness: readiness,
      runInteractive: async () => {
        throw new Error("fixture disconnected")
      },
    })
    expect(failed.work.status).toBe("unknown")
    expect(failed.notice).toContain("fixture disconnected")
    const blocked = await fixture.prepare()
    await expect(fixture.store.update(blocked, { status: "launching", exitCode: null, review: null })).rejects.toThrow(
      "unresolved",
    )
    const reviewed = await fixture.store.review(
      failed.work,
      "No live agent remains. The result could not be established.",
      "rejected",
    )
    expect(reviewed.review?.executionStatus).toBe("unknown")
  })

  it("keeps human assignments launch-free and records explicit rejected results", async () => {
    const work = await fixture.prepare({
      ...engagementAssessment,
      actions: [{ ...engagementAssessment.actions[0]!, workflow: null }],
    })
    await expect(
      engagementLaunchPlan(work, fixture.store, fixture.catalog, engagementGuideRoot, fixture.runner),
    ).rejects.toThrow("human action")
    const reviewed = await fixture.store.review(work, "The draft did not answer the workshop question.", "rejected")
    expect(reviewed).toMatchObject({ status: "reviewed", exitCode: null, review: { disposition: "rejected" } })
    await expect(fixture.store.review(work, "Stale second review", "recorded")).rejects.toThrow("changed")
  })

  it("rejects altered assignments, unsafe store paths, and ignored persistent records", async () => {
    const work = await fixture.prepare()
    const filename = path.join(root, `engagement/work/${work.request.id}.json`)
    await writeFile(filename, JSON.stringify({ ...work, request: { ...work.request, prompt: "Replaced instruction" } }))
    await expect(fixture.store.read(work.request.id)).rejects.toThrow("changed")
    await writeFile(path.join(root, ".gitignore"), "engagement/work/*.md\n")
    await expect(fixture.prepare()).rejects.toThrow("ignored by Git")
    await rm(path.join(root, "engagement/work"), { recursive: true })
    await symlink(path.join(root, "docs"), path.join(root, "engagement/work"))
    await expect(fixture.store.list()).rejects.toThrow("real directories")
  })

  it("allows only one concurrent launch claim and removes its write lock", async () => {
    const work = await fixture.prepare()
    const results = await Promise.allSettled([
      fixture.store.update(work, { status: "launching", exitCode: null, review: null }),
      fixture.store.update(work, { status: "launching", exitCode: null, review: null }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect((await fixture.store.read(work.request.id)).status).toBe("launching")
    expect(await readdir(path.join(root, "engagement/work"))).toEqual([`${work.request.id}.json`])
  })

  it("refuses a case-only managed-directory collision without renaming existing engagement data", async () => {
    await mkdir(path.join(root, "Engagement"))
    await writeFile(path.join(root, "Engagement/existing.md"), "Preserve this existing knowledge.")
    await expect(fixture.prepare()).rejects.toThrow("Case-only path collision")
    expect(await readFile(path.join(root, "Engagement/existing.md"), "utf8")).toBe("Preserve this existing knowledge.")
    expect(await readdir(root)).not.toContain("engagement")
  })
})

describe("engagement CLI mode separation", () => {
  it("preserves ordinary Guide while accepting both engagement questions", () => {
    expect(parseGuideHeadlessArgv([])).not.toHaveProperty("engagement")
    expect(parseGuideHeadlessArgv(["--engagement"])).toMatchObject({ engagement: true, intent: undefined })
    for (const intent of ["Prepare the next customer workshop", engagementDefaultIntent]) {
      expect(parseGuideHeadlessArgv(["--engagement", "--intent", intent])).toMatchObject({ engagement: true, intent })
    }
    for (const args of [
      ["--json"],
      ["--next-steps"],
      ["--profile", "native:cpx/hve"],
      ["--ui-variant", "pager"],
      ["--engagement"],
    ]) {
      expect(() => parseGuideHeadlessArgv(["--engagement", ...args])).toThrow(/--engagement|Duplicate flag/u)
    }
  })
})
