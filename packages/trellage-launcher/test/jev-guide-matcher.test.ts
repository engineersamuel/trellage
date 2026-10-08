import { chmod, mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JevGuideMatcher, type JevSystemOneClient } from "../src/jev-guide-matcher.ts"
import { prepareGuideGoal } from "../src/guide-goal-execution.ts"
import type { GuideMatchInput } from "../src/guide-provider.ts"
import { GuideMatcherFallbackReason, validateGuideMatchResult } from "../src/guide-provider.ts"

const entry = (ref: string, workflows = ["one"]) => ({
  ref,
  surface: "sandbox" as const,
  name: ref.split(":").pop()!,
  description: `${ref} description`,
  sandbox: true,
  guide: {
    schemaVersion: 1 as const,
    capabilities: ["work"],
    bestFor: ["implementation"],
    avoidFor: ["unrelated work"],
    prerequisites: [{ id: "repo", description: "A repository" }],
    workflows: workflows.map((id) => ({ id, description: `${id} workflow`, examples: ["example"] })),
  },
})

const input = (entries: GuideMatchInput["entries"] = [entry("sandbox:a"), entry("sandbox:b"), entry("sandbox:c")]): GuideMatchInput => ({
  intent: "Implement this safely",
  entries,
})
const client = (answers: Record<string, unknown>): JevSystemOneClient & { request?: unknown } => ({
  systemOne: async (request) => {
    clientValue.request = request
    return { answers }
  },
})
const clientValue: { request?: unknown } = {}

const goal = prepareGuideGoal({
  prompt: "Ship the result",
  draft: {
    artifact: "A verified patch",
    task: "Implement the fix",
    criteria: ["Tests pass", "No secrets leak", "Deliver safely"],
  },
})

const tempRoots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("JevGuideMatcher", () => {
  it("sends one compact batch and maps stable noul ranking plus workflow choices", async () => {
    const sdk = client({
      p0: { type: "noul", noul: 0.7 },
      p1: { type: "noul", noul: 0.9 },
      p2: { type: "noul", noul: 0.9 },
    })
    const result = await new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match(input())
    expect(result.candidates.map(({ profileRef }) => profileRef)).toEqual(["sandbox:b", "sandbox:c", "sandbox:a"])
    validateGuideMatchResult(
      result,
      new Map(input().entries.map((item) => [item.ref, new Set(item.guide.workflows.map(({ id }) => id))])),
    )
    expect((clientValue.request as { questions: Record<string, unknown> }).questions).toHaveProperty("p0")
  })

  it("selects a multi-workflow choice and preserves explicit preferences", async () => {
    const entries = [
      entry("sandbox:a", ["first", "second"]),
      entry("sandbox:b"),
      entry("sandbox:c"),
      entry("sandbox:d"),
    ]
    const sdk = client({
      p0: { type: "noul", noul: 0.1 },
      p1: { type: "noul", noul: 0.9 },
      p2: { type: "noul", noul: 0.8 },
      p3: { type: "noul", noul: 0.7 },
      w0: { type: "choice", choice: "second", confidence: 0.8, probabilities: { first: 0.2, second: 0.8 } },
    })
    const result = await new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match({
      ...input(entries),
      preferredProfileRefs: ["sandbox:a"],
    })
    expect(result.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ profileRef: "sandbox:a", workflowId: "second" })]),
    )
  })

  it("rejects malformed answers with a sanitized error", async () => {
    const sdk = client({
      p0: { type: "noul", noul: 2 },
      p1: { type: "noul", noul: 0.5 },
      p2: { type: "noul", noul: 0.4 },
    })
    await expect(new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match(input())).rejects.toThrow(
      "Jev match unavailable",
    )
  })

  it("honors cancellation and does not mutate process credentials", async () => {
    const controller = new AbortController()
    const sdk: JevSystemOneClient = {
      systemOne: async (_request, options) =>
        await new Promise((_resolve, reject) =>
          options.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
            once: true,
          }),
        ),
    }
    const pending = new JevGuideMatcher({ cwd: "/tmp", env: { TYPESAFE_API_KEY: "test" }, client: sdk }).match(
      input(),
      controller.signal,
    )
    controller.abort()
    await expect(pending).rejects.toThrow()
  })

  it("removes only cross-cutting workflows, not every workflow on a pinned profile", async () => {
    const entries = [
      entry("sandbox:ordinary-1"),
      entry("sandbox:ordinary-2"),
      entry("sandbox:ordinary-3"),
      entry("sandbox:claude-council", ["run-council-deliberation"]),
      entry("native:copilot/hve"),
      entry("sandbox:claude-research"),
    ]
    const answers = Object.fromEntries(entries.map((_, index) => [`p${index}`, { type: "noul", noul: 0.9 }]))
    const sdk = client(answers)
    await new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match({ intent: "Investigate", entries })
    const questions = (clientValue.request as { questions: Record<string, unknown> }).questions
    expect(Object.keys(questions).filter((key) => key.startsWith("p"))).toHaveLength(entries.length - 1)
  })

  it("uses the direct environment key over a .env key and passes it only to the factory", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-env-test-"))
    tempRoots.push(cwd)
    await writeFile(path.join(cwd, ".env"), "TYPESAFE_API_KEY=dotenv-key\nOTHER=ignored\n")
    let received = ""
    const sdk = client({
      p0: { type: "noul", noul: 0.9 },
      p1: { type: "noul", noul: 0.8 },
      p2: { type: "noul", noul: 0.7 },
    })
    const result = await new JevGuideMatcher({
      cwd,
      env: { TYPESAFE_API_KEY: " direct-key " },
      clientFactory: (key) => {
        received = key
        return sdk
      },
    }).match(input())
    expect(result.candidates).toHaveLength(3)
    expect(received).toBe(" direct-key ")
  })

  it("loads only TYPESAFE_API_KEY from .env when no direct key is provided", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-env-test-"))
    tempRoots.push(cwd)
    await writeFile(path.join(cwd, ".env"), "OTHER=secret\nTYPESAFE_API_KEY=from-file\n")
    let received = ""
    const sdk = client({
      p0: { type: "noul", noul: 0.9 },
      p1: { type: "noul", noul: 0.8 },
      p2: { type: "noul", noul: 0.7 },
    })
    await new JevGuideMatcher({
      cwd,
      env: {},
      clientFactory: (key) => {
        received = key
        return sdk
      },
    }).match(input())
    expect(received).toBe("from-file")
  })

  describe("user environment directory", () => {
    const sdk = () =>
      client({ p0: { type: "noul", noul: 0.9 }, p1: { type: "noul", noul: 0.8 }, p2: { type: "noul", noul: 0.7 } })
    const setup = async (content: string, mode = 0o600) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "jev-user-env-"))
      tempRoots.push(root)
      const cwd = path.join(root, "worktree")
      const directory = path.join(root, "home", ".config", "trellage")
      await mkdir(cwd)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(path.join(directory, ".env.local"), content, { mode })
      await chmod(path.join(directory, ".env.local"), mode)
      return { root, cwd, directory, home: path.join(root, "home") }
    }
    const keyFor = async (cwd: string, env: Record<string, string>): Promise<string | undefined> => {
      let received: string | undefined
      await new JevGuideMatcher({
        cwd,
        env,
        clientFactory: (key) => {
          received = key
          return sdk()
        },
      })
        .match(input())
        .catch(() => undefined)
      return received
    }

    it("reads the key from ~/.config/trellage/.env.local when no other source has it", async () => {
      const { cwd, home } = await setup("TYPESAFE_API_KEY=user-key\n")
      expect(await keyFor(cwd, { HOME: home })).toBe("user-key")
    })

    it("prefers the shell and worktree .env, and honors XDG_CONFIG_HOME", async () => {
      const { root, cwd, home } = await setup("TYPESAFE_API_KEY=user-key\n")
      expect(await keyFor(cwd, { HOME: home, TYPESAFE_API_KEY: "shell-key" })).toBe("shell-key")
      await writeFile(path.join(cwd, ".env"), "TYPESAFE_API_KEY=worktree-key\n")
      expect(await keyFor(cwd, { HOME: home })).toBe("worktree-key")
      await rm(path.join(cwd, ".env"))
      await mkdir(path.join(root, "xdg", "trellage"), { recursive: true })
      await writeFile(path.join(root, "xdg", "trellage", ".env"), "TYPESAFE_API_KEY=xdg-key\n", { mode: 0o600 })
      expect(await keyFor(cwd, { HOME: home, XDG_CONFIG_HOME: path.join(root, "xdg") })).toBe("xdg-key")
    })

    it("skips the directory when disabled, shared, symlinked, or holding a Varlock function", async () => {
      const disabled = await setup("TYPESAFE_API_KEY=user-key\n")
      await expect(
        new JevGuideMatcher({ cwd: disabled.cwd, env: { HOME: disabled.home, TRELLAGE_ENVIRONMENT: "off" } }).match(
          input(),
        ),
      ).rejects.toMatchObject({ reason: GuideMatcherFallbackReason.MissingCredentials })
      const shared = await setup("TYPESAFE_API_KEY=user-key\n", 0o644)
      expect(await keyFor(shared.cwd, { HOME: shared.home })).toBeUndefined()
      const linked = await setup("")
      await writeFile(path.join(linked.root, "target"), "TYPESAFE_API_KEY=linked\n", { mode: 0o600 })
      await rm(path.join(linked.directory, ".env.local"))
      await symlink(path.join(linked.root, "target"), path.join(linked.directory, ".env.local"))
      expect(await keyFor(linked.cwd, { HOME: linked.home })).toBeUndefined()
      const encrypted = await setup('TYPESAFE_API_KEY=varlock("encrypted")\n')
      expect(await keyFor(encrypted.cwd, { HOME: encrypted.home })).toBeUndefined()
    })
  })

  it.each([
    ["wrong response type", null, "Jev match unavailable"],
    ["missing answers", {}, "Jev match unavailable"],
    [
      "wrong answer value",
      { answers: { p0: { type: "noul", noul: 2 }, p1: { type: "noul", noul: 0.8 }, p2: { type: "noul", noul: 0.7 } } },
      "Jev match unavailable",
    ],
  ])("rejects %s with the exact validation error", async (_name, response, message) => {
    const sdk: JevSystemOneClient = { systemOne: async () => response }
    const pending = new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match(input())
    await expect(pending).rejects.toThrow(message)
    await expect(pending).rejects.toMatchObject({ reason: GuideMatcherFallbackReason.InvalidResponse })
  })

  it("times out a client that never settles", async () => {
    vi.useFakeTimers()
    const sdk: JevSystemOneClient = { systemOne: async () => await new Promise(() => {}) }
    const pending = new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match(input())
    const failure = expect(pending).rejects.toMatchObject({
      message: "Jev match unavailable",
      reason: GuideMatcherFallbackReason.Timeout,
    })
    await vi.advanceTimersByTimeAsync(3_001)
    await failure
  })

  it("cancels a hanging client without invoking fallback behavior", async () => {
    const controller = new AbortController()
    let aborted = false
    const sdk: JevSystemOneClient = {
      systemOne: async (_request, options) =>
        await new Promise((_resolve, reject) =>
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new DOMException("cancelled", "AbortError"))
            },
            { once: true },
          ),
        ),
    }
    const pending = new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match(input(), controller.signal)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(aborted).toBe(true)
  })

  it("keeps the protected goal objective in the request state and question text", async () => {
    const sdk = client({
      p0: { type: "noul", noul: 0.9 },
      p1: { type: "noul", noul: 0.8 },
      p2: { type: "noul", noul: 0.7 },
    })
    const goalEntries = input().entries.map((item) => ({
      ...item,
      goalExecution: { controller: "codex-goal" as const, workflowIds: ["one"] },
    }))
    await new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match({
      intent: input().intent,
      entries: goalEntries,
      goal,
    })
    const request = clientValue.request as { state: string; questions: Record<string, unknown> }
    expect(JSON.parse(request.state).objective).toEqual({
      artifact: goal.draft.artifact,
      task: goal.draft.task,
      criteria: goal.draft.criteria,
    })
    expect(JSON.stringify(request.questions)).not.toContain("Implement this safely")
    expect(JSON.stringify(request)).not.toContain(goal.prompt)
  })

  it("reserves Headlong and Poteto when their policy fit is positive even below the top five", async () => {
    const headlong = {
      ...entry("sandbox:headlong"),
      guide: {
        ...entry("sandbox:headlong").guide,
        workflows: [{ id: "headlong", description: "Long running work", examples: ["research"] }],
      },
    }
    const poteto = {
      ...entry("native:codex/pstack", ["poteto-mode-entry-point", "other"]),
      guide: {
        ...entry("native:codex/pstack", ["poteto-mode-entry-point", "other"]).guide,
        workflows: [
          { id: "poteto-mode-entry-point", description: "Multi-stage engineering", examples: ["build"] },
          { id: "other", description: "Other", examples: ["other"] },
        ],
      },
    }
    const fillers = Array.from({ length: 6 }, (_, index) => entry(`sandbox:filler-${index}`))
    const entries = [...fillers, headlong, poteto]
    const answers: Record<string, unknown> = Object.fromEntries(
      entries.map((_, index) => [`p${index}`, { type: "noul", noul: 0.99 - index / 100 }]),
    )
    answers.policyHeadlong = { type: "noul", noul: 0.9 }
    answers.policyPoteto = { type: "noul", noul: 0.9 }
    answers.w6 = { type: "choice", choice: "headlong", confidence: 1, probabilities: { headlong: 1 } }
    answers.w7 = {
      type: "choice",
      choice: "poteto-mode-entry-point",
      confidence: 1,
      probabilities: { "poteto-mode-entry-point": 1, other: 0 },
    }
    const result = await new JevGuideMatcher({ cwd: "/tmp", client: client(answers) }).match({
      intent: "substantial work",
      entries,
    })
    expect(result.candidates.map(({ profileRef }) => profileRef)).toEqual(
      expect.arrayContaining(["sandbox:headlong", "native:codex/pstack"]),
    )
  })
  it("forces Poteto for an already-ranked profile and excludes unrequested pinned workflows", async () => {
    const entries = [
      entry("native:codex/pstack", ["other", "poteto-mode-entry-point"]),
      entry("sandbox:claude-council", ["run-council-deliberation"]),
      entry("sandbox:a"),
      entry("sandbox:b"),
      entry("sandbox:c"),
    ]
    const answers = {
      p0: { type: "noul", noul: 0.99 },
      p1: { type: "noul", noul: 1 },
      p2: { type: "noul", noul: 0.8 },
      p3: { type: "noul", noul: 0.7 },
      p4: { type: "noul", noul: 0.6 },
      w0: {
        type: "choice",
        choice: "other",
        confidence: 0.8,
        probabilities: { other: 0.8, "poteto-mode-entry-point": 0.2 },
      },
      policyPoteto: { type: "noul", noul: 0.9 },
    }
    const sdk: JevSystemOneClient = {
      systemOne: async (request) => {
        const { entries: supplied } = JSON.parse(request.state as string) as { entries: Array<{ ref: string }> }
        return { answers: {
          ...answers,
          ...Object.fromEntries(supplied.map(({ ref }, index) => [
            `p${index}`, { type: "noul", noul: ref === "sandbox:claude-council" ? 1 : ref === "native:codex/pstack" ? 0.99 : 0.5 },
          ])),
        } }
      },
    }
    const matcher = new JevGuideMatcher({ cwd: "/tmp", client: sdk })
    const result = await matcher.match(input(entries))
    expect(result.candidates[0]?.workflowId).toBe("poteto-mode-entry-point")
    expect(result.candidates.some(({ profileRef }) => profileRef === "sandbox:claude-council")).toBe(false)
    const explicit = await matcher.match({ ...input(entries), preferredProfileRefs: ["sandbox:claude-council"] })
    expect(explicit.candidates[0]?.profileRef).toBe("sandbox:claude-council")
  })

  it("can rank an HVE customer workflow without exposing the generic RPI pin", async () => {
    const entries = [
      entry("native:copilot/hve", ["rpi-agent-cycle", "customer-discovery"]),
      entry("sandbox:a"),
      entry("sandbox:b"),
    ]
    const sdk: JevSystemOneClient = {
      systemOne: async (request) => {
        const { entries: supplied } = JSON.parse(request.state as string) as { entries: GuideMatchInput["entries"] }
        expect(supplied[0]?.guide.workflows.map(({ id }) => id)).toEqual(["customer-discovery"])
        return { answers: {
          p0: { type: "noul", noul: 1 }, p1: { type: "noul", noul: 0.3 }, p2: { type: "noul", noul: 0.2 },
        } }
      },
    }
    const result = await new JevGuideMatcher({ cwd: "/tmp", client: sdk }).match({ intent: "Discover customer needs", entries })
    expect(result.candidates[0]).toMatchObject({ profileRef: "native:copilot/hve", workflowId: "customer-discovery" })
  })

  it("clears the deadline after success and aborts promptly when transport ignores cancellation", async () => {
    vi.useFakeTimers()
    const sdk = client({
      p0: { type: "noul", noul: 0.1 },
      p1: { type: "noul", noul: 0.1 },
      p2: { type: "noul", noul: 0.1 },
    })
    await new JevGuideMatcher({ cwd: "/tmp", env: { TYPESAFE_API_KEY: "test" }, client: sdk }).match(input())
    expect(vi.getTimerCount()).toBe(0)
    const controller = new AbortController()
    const pending = new JevGuideMatcher({
      cwd: "/tmp",
      env: { TYPESAFE_API_KEY: "test" },
      client: { systemOne: async () => new Promise(() => {}) },
    }).match(input(), controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" })
    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects missing credentials without creating a client, and hides transport secrets", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-no-key-"))
    tempRoots.push(cwd)
    let created = false
    await expect(
      new JevGuideMatcher({
        cwd,
        env: {},
        clientFactory: () => {
          created = true
          throw new Error("private")
        },
      }).match(input()),
    ).rejects.toMatchObject({
      message: "Jev match unavailable",
      reason: GuideMatcherFallbackReason.MissingCredentials,
    })
    expect(created).toBe(false)
    const failed = new JevGuideMatcher({
      cwd,
      env: { TYPESAFE_API_KEY: "private" },
      clientFactory: () => ({
        systemOne: async () => {
          throw new Error("private")
        },
      }),
    }).match(input())
    await expect(failed).rejects.toThrow(/^Jev match unavailable$/)
    await expect(failed).rejects.toMatchObject({ reason: GuideMatcherFallbackReason.RequestFailed })
  })

  it("bounds authored explanations and leaves unrelated dotenv variables untouched", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "jev-isolation-"))
    tempRoots.push(cwd)
    const previous = process.env.JEV_UNRELATED_TEST_VALUE
    await writeFile(path.join(cwd, ".env"), 'TYPESAFE_API_KEY="quoted#key"\nJEV_UNRELATED_TEST_VALUE=must-not-load\n')
    const entries = input().entries.map((entry) => ({
      ...entry,
      guide: {
        ...entry.guide,
        avoidFor: ["x".repeat(800)],
        workflows: entry.guide.workflows.map((workflow) => ({
          ...workflow,
          description: "Authored\n" + "y".repeat(800),
        })),
      },
    }))
    const result = await new JevGuideMatcher({
      cwd,
      env: {},
      clientFactory: (key) => {
        expect(key).toBe("quoted#key")
        return client({
          p0: { type: "noul", noul: 0.9 },
          p1: { type: "noul", noul: 0.8 },
          p2: { type: "noul", noul: 0.7 },
        })
      },
    }).match(input(entries))
    expect(process.env.JEV_UNRELATED_TEST_VALUE).toBe(previous)
    expect(result.candidates[0]?.reason).toHaveLength(500)
    expect(result.candidates[0]?.reason).toMatch(/^Authored y/)
    expect(result.candidates[0]?.tradeoff).toHaveLength(500)
  })
})
