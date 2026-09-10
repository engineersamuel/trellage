import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ActionAccess,
  ActionImportance,
  ContinuationActionStatus,
  ContinuationOutcome,
  ContinuationPlacementKind,
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  conversationLimits,
  conversationSourceKey,
  type ContinuationActionDraft,
  type ContinuationDraft,
  type ContinuationPromptCandidate,
  type ConversationSnapshot,
} from "../../trellage-guide-core/dist/index.js"
import {
  ContinuationRevisionConflictError,
  ContinuationStore,
  ContinuationStoreErrorCode,
  type ContinuationLaunchEvent,
} from "../src/continuation-store.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...original,
    rename: vi.fn<typeof original.rename>(original.rename),
    open: vi.fn<typeof original.open>(original.open),
  }
})

enum PromiseStatus {
  Fulfilled = "fulfilled",
  Rejected = "rejected",
}

const roots: string[] = []
const privateText = "PRIVATE-CONVERSATION-AND-PROMPT"
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))

const snapshot = (): ConversationSnapshot => ({
  schemaVersion: 1,
  id: randomUUID(),
  source: {
    serverId: "server-1",
    surface: ConversationSurface.Host,
    agent: ConversationAgent.Copilot,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    paneId: "workspace-1:pane-1",
    tabId: "tab-1",
    cwd: "/work/search",
  },
  capturedAt: "2026-09-09T21:02:09.441Z",
  cutoff: { messageId: "message-2", recordIndex: 3 },
  revision: "a".repeat(64),
  messages: [
    { id: "message-1", role: ConversationRole.User, text: privateText, recordIndex: 0 },
    { id: "message-2", role: ConversationRole.Assistant, text: "The work is reported complete.", recordIndex: 3 },
  ],
  coverage: { complete: true, notices: [] },
})

const fixture = async () => {
  const directory = path.join(currentDirectory, `.continuation-state-${randomUUID()}`)
  roots.push(directory)
  await mkdir(directory, { mode: 0o700 })
  const root = path.join(directory, "state")
  await mkdir(root, { mode: 0o700 })
  return { directory, root, store: new ContinuationStore(root), snapshot: snapshot() }
}

const request = async (root: string, value: unknown): Promise<string> => {
  const continuation = path.join(root, "continuations")
  const requests = path.join(continuation, "requests")
  await mkdir(continuation, { recursive: true, mode: 0o700 })
  await mkdir(requests, { mode: 0o700 })
  const filename = path.join(requests, `${randomUUID()}.json`)
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 })
  return filename
}

const draftPath = (root: string, draftId: string) => path.join(root, "continuations", "drafts", `${draftId}.json`)
const sourcePath = (root: string, source: ConversationSnapshot["source"]) =>
  path.join(root, "continuations", "sources", `${conversationSourceKey(source)}.json`)
const journalPath = (root: string, draftId: string) =>
  path.join(root, "continuations", "launch-events", `${draftId}.jsonl`)

const assessed = (draft: ContinuationDraft): ContinuationDraft => {
  const assessment = {
    schemaVersion: 1 as const,
    outcome: ContinuationOutcome.Recommendations,
    goal: "Deliver the reported work.",
    reportedProgress: ["Implementation was reported complete."],
    unresolvedWork: ["A review remains."],
    blockers: [],
    questions: [],
    actions: Array.from({ length: 5 }, (_, index) => ({
      id: `action-${index + 1}`,
      rank: index + 1,
      title: `Review topic ${index + 1}`,
      brief: `${privateText} selected action ${index + 1}`,
      whyNow: "The work is ready.",
      expectedOutput: `Review report ${index + 1}`,
      evidenceIds: ["message-2"],
      importance: ActionImportance.Optional,
      profileRef: "native:cdx/default",
      workflowId: "review",
      dependsOn: [],
      access: ActionAccess.Unknown,
    })),
  }
  return {
    ...draft,
    assessment,
    actions: assessment.actions.map((action) => ({
      actionId: action.id,
      brief: action.brief,
      selected: false,
      status: ContinuationActionStatus.Draft,
    })),
  }
}

const launching = (draft: ContinuationDraft): ContinuationDraft => {
  const value = assessed(draft)
  return {
    ...value,
    actions: value.actions.map((action, index) =>
      index === 0
        ? {
            ...action,
            selected: true,
            status: ContinuationActionStatus.Launching,
            prompt: privateText,
            placement: { kind: ContinuationPlacementKind.NewTab },
            launch: { attemptId: randomUUID(), status: ContinuationActionStatus.Launching },
          }
        : action,
    ),
  }
}

const eventFor = (draft: ContinuationDraft): ContinuationLaunchEvent => {
  const action = draft.actions[0]!
  return { actionId: action.actionId, attemptId: action.launch!.attemptId, status: action.status }
}

const firstActionStatus = (draft: ContinuationDraft, status: ContinuationActionStatus): ContinuationDraft => ({
  ...draft,
  actions: draft.actions.map((action, index) =>
    index === 0
      ? {
          ...action,
          status,
          launch: { ...action.launch!, status },
        }
      : action,
  ),
})

const unsafeAttemptChanges: ReadonlyArray<{
  readonly name: string
  readonly change: (action: ContinuationActionDraft) => ContinuationActionDraft
}> = [
  {
    name: "clear the attempt",
    change: (action) => {
      const { launch: _launch, ...rest } = action
      return { ...rest, status: ContinuationActionStatus.Draft }
    },
  },
  {
    name: "replace the attempt",
    change: (action) => ({
      ...action,
      status: ContinuationActionStatus.Launching,
      launch: { ...action.launch!, attemptId: randomUUID(), status: ContinuationActionStatus.Launching },
    }),
  },
  {
    name: "resend the same attempt",
    change: (action) => ({
      ...action,
      status: ContinuationActionStatus.Launching,
      launch: { ...action.launch!, status: ContinuationActionStatus.Launching },
    }),
  },
  {
    name: "mark a retryable failure",
    change: (action) => ({
      ...action,
      status: ContinuationActionStatus.Failed,
      launch: { ...action.launch!, status: ContinuationActionStatus.Failed },
    }),
  },
  { name: "change the prompt", change: (action) => ({ ...action, prompt: "A replacement job." }) },
  { name: "change the brief", change: (action) => ({ ...action, brief: "A different task." }) },
  {
    name: "change the destination",
    change: (action) => ({
      ...action,
      placement: { kind: ContinuationPlacementKind.ExistingWorktree, path: "/work/different" },
    }),
  },
]

afterEach(async () => {
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof fs>("node:fs/promises")
  vi.mocked(fs.rename).mockImplementation(actual.rename)
  vi.mocked(fs.open).mockImplementation(actual.open)
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700)
    await rm(root, { recursive: true, force: true })
  }
})

describe("Sandbox domain snapshot identities", () => {
  it("retains the domain snapshot UUID independently of request and draft UUIDs", async () => {
    const state = await fixture()
    const exportedSnapshot: ConversationSnapshot = {
      ...state.snapshot,
      source: {
        ...state.snapshot.source,
        surface: ConversationSurface.Sandbox,
        profile: "claude-council",
        containerId: "b".repeat(64),
        invocationId: "invocation-1",
      },
    }
    const probePath = await state.store.stageRequest(exportedSnapshot)
    expect(path.basename(probePath)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u,
    )
    expect(path.basename(probePath, ".json")).not.toBe(exportedSnapshot.id)
    expect(await state.store.consumeRequest(probePath)).toEqual(exportedSnapshot)
    const created = await state.store.create(exportedSnapshot, "gpt-5.5", "high")
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(created.id).not.toBe(exportedSnapshot.id)
    expect(created.snapshot.id).toBe(exportedSnapshot.id)
    await state.store.acknowledgeRequest(probePath)
    expect((await new ContinuationStore(state.root).load(created.id)).snapshot).toEqual(exportedSnapshot)
    expect((await state.store.find(exportedSnapshot.source))?.id).toBe(created.id)
    await expect(state.store.load("d".repeat(64))).rejects.toThrow(/UUID/u)
  })

  it("rejects transport snapshot IDs without consuming requests or replacing a valid draft", async () => {
    const state = await fixture()
    const transportSnapshot = { ...state.snapshot, id: "d".repeat(64) }
    await expect(state.store.stageRequest(transportSnapshot)).rejects.toThrow(/UUID/u)
    await expect(state.store.create(transportSnapshot, "gpt-5.5", "high")).rejects.toThrow(/UUID/u)

    const filename = await request(state.root, transportSnapshot)
    const created = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const requestBytes = await readFile(filename)
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/UUID/u)
    await expect(state.store.acknowledgeRequest(filename)).rejects.toThrow(/UUID/u)
    expect((await readFile(filename)).equals(requestBytes)).toBe(true)

    const invalidDraft = { ...created, snapshot: transportSnapshot }
    await expect(state.store.save(invalidDraft, created.revision)).rejects.toThrow(/UUID/u)
    expect(await state.store.load(created.id)).toEqual(created)
    await writeFile(draftPath(state.root, created.id), JSON.stringify(invalidDraft))
    const restarted = new ContinuationStore(state.root)
    await expect(restarted.load(created.id)).rejects.toThrow(/UUID/u)
    await expect(restarted.find(state.snapshot.source)).rejects.toThrow(/UUID/u)
  })
})

describe("private freshness request staging", () => {
  it("stages an exact private snapshot that its creator can acknowledge before draft creation", async () => {
    const state = await fixture()
    const filename = await state.store.stageRequest(state.snapshot)
    expect(path.dirname(filename)).toBe(path.join(state.root, "continuations", "requests"))
    expect(path.basename(filename)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u,
    )
    const status = await lstat(filename)
    expect(status.isFile()).toBe(true)
    expect(status.mode & 0o7777).toBe(0o600)
    expect(status.uid).toBe(process.getuid!())
    expect(status.nlink).toBe(1)
    for (const directory of [state.root, path.dirname(path.dirname(filename)), path.dirname(filename)]) {
      expect((await lstat(directory)).mode & 0o7777).toBe(0o700)
    }
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(state.snapshot)
    expect(await state.store.consumeRequest(filename)).toEqual(state.snapshot)
    expect(await state.store.find(state.snapshot.source)).toBeUndefined()
    await state.store.acknowledgeRequest(filename)
    await expect(lstat(filename)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await state.store.find(state.snapshot.source)).toBeUndefined()
  })

  it("does not let a freshness probe consume its original user handoff", async () => {
    const state = await fixture()
    const original = await request(state.root, state.snapshot)
    await state.store.consumeRequest(original)
    const probe = await state.store.stageRequest(state.snapshot)
    expect(probe).not.toBe(original)
    await state.store.acknowledgeRequest(probe)
    await expect(state.store.acknowledgeRequest(original)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.MissingDraft,
    })
    expect(JSON.parse(await readFile(original, "utf8"))).toEqual(state.snapshot)
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    await state.store.acknowledgeRequest(original)
    await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not give another store the creator's no-draft acknowledgment capability", async () => {
    const state = await fixture()
    const probe = await state.store.stageRequest(state.snapshot)
    const other = new ContinuationStore(state.root)
    await other.consumeRequest(probe)
    await expect(other.acknowledgeRequest(probe)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.MissingDraft,
    })
    expect(JSON.parse(await readFile(probe, "utf8"))).toEqual(state.snapshot)
    await state.store.acknowledgeRequest(probe)
    await expect(lstat(probe)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects changed staged bytes on both repeated reads and acknowledgment", async () => {
    const state = await fixture()
    const probe = await state.store.stageRequest(state.snapshot)
    await state.store.consumeRequest(probe)
    const changed = { ...state.snapshot, revision: "b".repeat(64) }
    await writeFile(probe, JSON.stringify(changed))
    await expect(state.store.consumeRequest(probe)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.Changed,
    })
    await expect(state.store.acknowledgeRequest(probe)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.Changed,
    })
    expect(JSON.parse(await readFile(probe, "utf8"))).toEqual(changed)
  })

  it("keeps staging failures explicit and removes unpublished staging files", async () => {
    const state = await fixture()
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error(privateText), { code: "EACCES" }))
    await expect(state.store.stageRequest(state.snapshot)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.PermissionDenied,
      message: expect.not.stringContaining(privateText),
    })
    expect(await readdir(path.join(state.root, "continuations", "requests"))).toEqual([])
    expect(await state.store.find(state.snapshot.source)).toBeUndefined()
  })

  it("does not repair an unsafe root before staging a freshness probe", async () => {
    const state = await fixture()
    await chmod(state.root, 0o755)
    await expect(state.store.stageRequest(state.snapshot)).rejects.toThrow(/mode-0700/u)
    expect((await lstat(state.root)).mode & 0o7777).toBe(0o755)
    await expect(lstat(path.join(state.root, "continuations"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["not-a-hash", "A".repeat(64), "a".repeat(63)])(
    "rejects an invalid source revision before creating files %#",
    async (revision) => {
      const state = await fixture()
      await expect(state.store.stageRequest({ ...state.snapshot, revision })).rejects.toThrow(/SHA-256/u)
      await expect(lstat(path.join(state.root, "continuations"))).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it("gives concurrent freshness checks independent one-use paths", async () => {
    const state = await fixture()
    const [first, second] = await Promise.all([
      state.store.stageRequest(state.snapshot),
      state.store.stageRequest(state.snapshot),
    ])
    expect(first).not.toBe(second)
    await state.store.acknowledgeRequest(first)
    expect(JSON.parse(await readFile(second, "utf8"))).toEqual(state.snapshot)
    await state.store.acknowledgeRequest(second)
    expect(await readdir(path.join(state.root, "continuations", "requests"))).toEqual([])
  })
})

describe("private continuation request transport", () => {
  it("reads without consuming and acknowledges only after durable creation", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    expect(await state.store.consumeRequest(filename)).toEqual(state.snapshot)
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(state.snapshot)
    await expect(state.store.acknowledgeRequest(filename)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.MissingDraft,
    })
    expect(await readFile(filename, "utf8")).toContain(privateText)
    const draft = await state.store.create(state.snapshot, "gpt-5.5", "high")
    await state.store.acknowledgeRequest(filename)
    await expect(lstat(filename)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await new ContinuationStore(state.root).load(draft.id)).toEqual(draft)
    expect((await state.store.find(state.snapshot.source))?.snapshot).toEqual(state.snapshot)
  })

  it("accepts acknowledgment after externally validated refresh and durable create", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    await state.store.acknowledgeRequest(filename)
    await expect(lstat(filename)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("keeps a changed request instead of deleting a replacement", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    await state.store.consumeRequest(filename)
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    const updated = { ...state.snapshot, revision: "b".repeat(64) }
    await writeFile(filename, JSON.stringify(updated))
    await expect(state.store.consumeRequest(filename)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.Changed,
    })
    await expect(state.store.acknowledgeRequest(filename)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.Changed,
    })
    expect(JSON.parse(await readFile(filename, "utf8"))).toEqual(updated)
  })

  it("detects request growth between inspection and opening", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    const { open: originalOpen } = await vi.importActual<typeof fs>("node:fs/promises")
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (args[0] === filename) await fs.appendFile(filename, " ")
      return handle
    })
    await expect(state.store.consumeRequest(filename)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.Changed,
    })
    expect(await readFile(filename, "utf8")).toContain(privateText)
  })

  it("does not acknowledge a request using an unrelated source's draft", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    await state.store.create(
      { ...state.snapshot, source: { ...state.snapshot.source, sessionId: "other-session" } },
      "gpt-5.5",
      "high",
    )
    await expect(state.store.acknowledgeRequest(filename)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.MissingDraft,
    })
    expect(await readFile(filename, "utf8")).toContain(privateText)
  })

  it.each(["relative.json", "/outside.json", "/work/../outside.json"])(
    "rejects unbound request path %s",
    async (filename) => {
      const state = await fixture()
      await expect(state.store.consumeRequest(filename)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.UnsafePath,
      })
    },
  )

  it("rejects missing requests, arbitrary filenames, and sibling-directory requests", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    await expect(state.store.consumeRequest(path.join(path.dirname(filename), "read-me.json"))).rejects.toThrow(/UUID/u)
    await expect(state.store.consumeRequest(path.join(state.root, path.basename(filename)))).rejects.toThrow(/outside/u)
    await rm(filename)
    await expect(state.store.consumeRequest(filename)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.MissingRequest,
    })
  })

  it.each(["invalid JSON PRIVATE-CONTENT", '{"messages": [', "null", '{"command":"never execute"}'])(
    "keeps malformed request data and reports no private content %#",
    async (content) => {
      const state = await fixture()
      const filename = await request(state.root, state.snapshot)
      await writeFile(filename, content)
      await expect(state.store.consumeRequest(filename)).rejects.toThrow(/invalid JSON|snapshot:/u)
      expect(await readFile(filename, "utf8")).toBe(content)
    },
  )

  it("rejects invalid UTF-8 before JSON parsing", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    await writeFile(filename, Buffer.from([0xff, 0xfe]))
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/UTF-8/u)
  })

  it("checks request byte bounds before reading a sparse oversized file", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    const handle = await open(filename, "r+")
    try {
      await handle.truncate(conversationLimits.snapshotBytes + 1)
    } finally {
      await handle.close()
    }
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/byte limit/u)
    expect((await lstat(filename)).size).toBe(conversationLimits.snapshotBytes + 1)
  })
})

describe("private file ownership and containment", () => {
  it.each([undefined, "", ".", "relative/path", "/", "/work/../outside", "/work/\u0000state"])(
    "requires an explicit safe plugin state root %#",
    (root) => {
      expect(() => new ContinuationStore(root!)).toThrow(/HERDR_PLUGIN_STATE_DIR/u)
    },
  )

  it("creates private files and directories without a worktree cache", async () => {
    const state = await fixture()
    const draft = await state.store.create(state.snapshot, "gpt-5.5", "high")
    for (const directory of [
      "",
      "continuations",
      ...["requests", "drafts", "sources", "launch-events"].map((name) => `continuations/${name}`),
    ]) {
      const status = await lstat(path.join(state.root, directory))
      expect(status.mode & 0o7777).toBe(0o700)
      expect(status.uid).toBe(process.getuid!())
      expect(status.isSymbolicLink()).toBe(false)
    }
    for (const filename of [draftPath(state.root, draft.id), sourcePath(state.root, state.snapshot.source)]) {
      const status = await lstat(filename)
      expect(status.mode & 0o7777).toBe(0o600)
      expect(status.uid).toBe(process.getuid!())
      expect(status.nlink).toBe(1)
    }
    expect(await readdir(state.root)).toEqual(["continuations"])
    expect(await readdir(path.join(state.root, "continuations"))).not.toContain(".store.lock")
    await expect(lstat(path.join(state.directory, ".trx-guide"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each([0o644, 0o400, 0o660, 0o4600])("refuses unsafe request mode %i without repairing it", async (mode) => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    await chmod(filename, mode)
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/mode-0600/u)
    expect((await lstat(filename)).mode & 0o7777).toBe(mode)
  })

  it.each(["", "continuations", "continuations/requests"])("refuses a permissive directory %s", async (directory) => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    const target = path.join(state.root, directory)
    await chmod(target, 0o755)
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/mode-0700/u)
    expect((await lstat(target)).mode & 0o777).toBe(0o755)
  })

  it("requires the current owner rather than silently accepting another user's state", async () => {
    const state = await fixture()
    const uid = process.getuid!()
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1)
    await expect(new ContinuationStore(state.root).find(state.snapshot.source)).rejects.toThrow(/owner|owned/u)
  })

  it("rejects symbolic-link and multi-link requests without reading or deleting their targets", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    const target = path.join(state.directory, "target.json")
    await rename(filename, target)
    await symlink(target, filename)
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/single-link/u)
    expect(await readFile(target, "utf8")).toContain(privateText)
    await rm(filename)
    await link(target, filename)
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/single-link/u)
    expect((await lstat(target)).nlink).toBe(2)
  })

  it("rejects FIFO requests without waiting for a writer", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    await rm(filename)
    execFileSync("mkfifo", [filename])
    await chmod(filename, 0o600)
    await expect(state.store.consumeRequest(filename)).rejects.toThrow(/regular files/u)
  })

  it("rejects a symlinked state ancestor even if its target is private", async () => {
    const state = await fixture()
    const alias = path.join(state.directory, "alias")
    await symlink(state.root, alias)
    await expect(new ContinuationStore(path.join(alias, "nested-state")).find(state.snapshot.source)).rejects.toThrow(
      /symbolic links/u,
    )
    await expect(lstat(path.join(state.root, "nested-state"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["requests", "drafts", "sources", "launch-events"])("rejects a symlinked %s directory", async (name) => {
    const state = await fixture()
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    const original = path.join(state.root, "continuations", name)
    const target = path.join(state.directory, name)
    await rename(original, target)
    await symlink(target, original)
    await expect(state.store.find(state.snapshot.source)).rejects.toThrow(/symbolic links/u)
  })

  it("detects replacement by another private directory during a store's lifetime", async () => {
    const state = await fixture()
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    const original = path.join(state.root, "continuations", "drafts")
    await rename(original, path.join(state.directory, "old-drafts"))
    await mkdir(original, { mode: 0o700 })
    await expect(state.store.find(state.snapshot.source)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.Changed,
    })
  })

  it("does not recreate a known private directory after it disappears", async () => {
    const state = await fixture()
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    const original = path.join(state.root, "continuations", "drafts")
    await rename(original, path.join(state.directory, "old-drafts"))
    await expect(state.store.find(state.snapshot.source)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.Changed,
    })
    await expect(lstat(original)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects a symlink or permissive lock without repairing either", async () => {
    const state = await fixture()
    await state.store.find(state.snapshot.source)
    const lock = path.join(state.root, "continuations", ".store.lock")
    const target = path.join(state.directory, "lock-target")
    await mkdir(target, { mode: 0o700 })
    await symlink(target, lock)
    await expect(state.store.find(state.snapshot.source)).rejects.toThrow(/symbolic links/u)
    expect((await lstat(lock)).isSymbolicLink()).toBe(true)
    await rm(lock)
    await mkdir(lock, { mode: 0o755 })
    await expect(state.store.find(state.snapshot.source)).rejects.toThrow(/mode-0700/u)
    expect((await lstat(lock)).mode & 0o777).toBe(0o755)
  })

  it("recovers an owned stale lock using proper-lockfile", async () => {
    const state = await fixture()
    await state.store.find(state.snapshot.source)
    const lock = path.join(state.root, "continuations", ".store.lock")
    await mkdir(lock, { mode: 0o700 })
    const past = new Date(Date.now() - 60_000)
    await utimes(lock, past, past)
    await expect(state.store.find(state.snapshot.source)).resolves.toBeUndefined()
    await expect(lstat(lock)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("committed-only source acknowledgment", () => {
  it("defaults to unconfirmed and preserves explicit true/false without changing preparation status", async () => {
    const state = await fixture()
    const initial = assessed(await state.store.create(state.snapshot, "gpt-5.5", "high"))
    let current = await state.store.save(
      {
        ...initial,
        actions: initial.actions.map(
          (action, index): ContinuationActionDraft =>
            index === 0
              ? {
                  ...action,
                  status: ContinuationActionStatus.Prepared,
                  prompt: "Review the explicitly selected worktree contents.",
                  placement: { kind: ContinuationPlacementKind.NewWorktree, branch: "next/review", baseRef: "HEAD" },
                }
              : action,
        ),
      },
      initial.revision,
    )
    const unconfirmed = await new ContinuationStore(state.root).load(current.id)
    expect(unconfirmed.actions[0]).not.toHaveProperty("uncommittedChangesConfirmed")
    expect(unconfirmed.actions[0]?.uncommittedChangesConfirmed ?? false).toBe(false)
    for (const confirmed of [true, false]) {
      current = await state.store.save(
        {
          ...current,
          actions: current.actions.map((action, index) =>
            index === 0 ? { ...action, uncommittedChangesConfirmed: confirmed } : action,
          ),
        },
        current.revision,
      )
      const restored = await new ContinuationStore(state.root).load(current.id)
      expect(restored.actions[0]?.uncommittedChangesConfirmed).toBe(confirmed)
      expect(restored.actions[0]?.status).toBe(ContinuationActionStatus.Prepared)
      expect(restored.actions[0]?.prompt).toBe(unconfirmed.actions[0]?.prompt)
      expect(restored.actions.slice(1)).toEqual(unconfirmed.actions.slice(1))
    }
  })

  it.each(["true", "false", 1, 0, null])("rejects non-boolean confirmation on restore %#", async (confirmation) => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const current = await state.store.save(assessed(initial), initial.revision)
    await writeFile(
      draftPath(state.root, current.id),
      JSON.stringify({
        ...current,
        actions: current.actions.map((action, index) =>
          index === 0 ? { ...action, uncommittedChangesConfirmed: confirmation } : action,
        ),
      }),
    )
    await expect(new ContinuationStore(state.root).load(current.id)).rejects.toThrow(
      /uncommittedChangesConfirmed: must be a boolean/u,
    )
  })
})

describe("persisted independent prompt choices", () => {
  const promptChoices = (actionId: string): ReadonlyArray<ContinuationPromptCandidate> =>
    Array.from({ length: 3 }, (_, index) => ({
      id: `candidate-${index + 1}`,
      title: `Choice ${index + 1}`,
      prompt: `WORKFLOW START\n${actionId}: complete option ${index + 1}.\nWORKFLOW END`,
      notes: "Generated and optimized for this action.",
    }))

  const saveChosenDraft = async () => {
    const state = await fixture()
    const initial = assessed(await state.store.create(state.snapshot, "gpt-5.5", "high"))
    const candidates = promptChoices(initial.actions[0]!.actionId)
    const origin = candidates[0]!
    const draft = await state.store.save(
      {
        ...initial,
        actions: initial.actions.map((action, index) =>
          index === 0
            ? {
                ...action,
                candidates,
                selectedCandidateId: origin.id,
                prompt: origin.prompt,
                placement: { kind: ContinuationPlacementKind.NewTab },
                status: ContinuationActionStatus.Prepared,
              }
            : action,
        ),
      },
      initial.revision,
    )
    return { ...state, draft }
  }

  it("keeps three alternatives per action through explicit selection, manual editing, and restart", async () => {
    const state = await fixture()
    const initial = assessed(await state.store.create(state.snapshot, "gpt-5.5", "high"))
    const choices = initial.actions.slice(0, 2).map((action) => promptChoices(action.actionId))
    const withChoices: ContinuationDraft = {
      ...initial,
      actions: initial.actions.map(
        (action, index): ContinuationActionDraft =>
          index < 2
            ? {
                ...action,
                candidates: choices[index]!,
                placement: { kind: ContinuationPlacementKind.NewTab },
              }
            : action,
      ),
    }
    await state.store.save(withChoices, initial.revision)
    const pending = await new ContinuationStore(state.root).load(initial.id)
    for (const [index, action] of pending.actions.slice(0, 2).entries()) {
      expect(action.candidates).toEqual(choices[index])
      expect(action.candidates).toHaveLength(3)
      expect(action.status).toBe(ContinuationActionStatus.Draft)
      expect(action).not.toHaveProperty("prompt")
      expect(action).not.toHaveProperty("selectedCandidateId")
      expect(action.selected).toBe(false)
    }

    const choice = pending.actions[0]!.candidates![1]!
    const selected = await state.store.save(
      {
        ...pending,
        actions: pending.actions.map((action, index) =>
          index === 0
            ? {
                ...action,
                selectedCandidateId: choice.id,
                prompt: choice.prompt,
                status: ContinuationActionStatus.Prepared,
              }
            : action,
        ),
      },
      pending.revision,
    )
    const reopened = await new ContinuationStore(state.root).load(initial.id)
    expect(reopened).toEqual(selected)
    expect(reopened.actions[0]).toMatchObject({
      selectedCandidateId: "candidate-2",
      prompt: choice.prompt,
      status: ContinuationActionStatus.Prepared,
      selected: false,
      candidates: choices[0],
    })
    expect(reopened.actions[1]).toMatchObject({
      status: ContinuationActionStatus.Draft,
      candidates: choices[1],
    })
    expect(reopened.actions[1]).not.toHaveProperty("prompt")

    const edited = await state.store.save(
      {
        ...reopened,
        actions: reopened.actions.map((action, index) => {
          if (index !== 0) return action
          return { ...action, prompt: `${action.prompt}\nExplicit user clarification.` }
        }),
      },
      reopened.revision,
    )
    const restored = await new ContinuationStore(state.root).load(edited.id)
    expect(restored.actions[0]).toMatchObject({
      prompt: `${choice.prompt}\nExplicit user clarification.`,
      status: ContinuationActionStatus.Prepared,
      candidates: choices[0],
      selectedCandidateId: choice.id,
    })
    expect(restored.actions[1]).toEqual(reopened.actions[1])
  })

  it("rejects legacy edited candidates without choosing an origin or changing saved bytes", async () => {
    const state = await saveChosenDraft()
    const withoutOrigin = {
      ...state.draft,
      actions: state.draft.actions.map((action, index) => {
        if (index !== 0) return action
        const { selectedCandidateId: _origin, ...rest } = action
        return { ...rest, prompt: `${action.prompt}\nLegacy manual edit.` }
      }),
    }
    const filename = draftPath(state.root, state.draft.id)
    const savedBytes = await readFile(filename)
    await expect(state.store.save(withoutOrigin, state.draft.revision)).rejects.toThrow(/selectedCandidateId/u)
    expect((await readFile(filename)).equals(savedBytes)).toBe(true)
    expect(await state.store.load(state.draft.id)).toEqual(state.draft)

    await writeFile(filename, JSON.stringify(withoutOrigin))
    const legacyBytes = await readFile(filename)
    const restarted = new ContinuationStore(state.root)
    await expect(restarted.load(state.draft.id)).rejects.toThrow(/selectedCandidateId/u)
    await expect(restarted.find(state.snapshot.source)).rejects.toThrow(/selectedCandidateId/u)
    expect((await readFile(filename)).equals(legacyBytes)).toBe(true)
  })

  it.each([ContinuationActionStatus.Launching, ContinuationActionStatus.Launched, ContinuationActionStatus.Unknown])(
    "does not change candidate origin after a saved %s attempt",
    async (status) => {
      const state = await saveChosenDraft()
      const running = await state.store.save(
        {
          ...state.draft,
          actions: state.draft.actions.map((action, index) =>
            index === 0
              ? {
                  ...action,
                  status: ContinuationActionStatus.Launching,
                  launch: { attemptId: randomUUID(), status: ContinuationActionStatus.Launching },
                }
              : action,
          ),
        },
        state.draft.revision,
      )
      const outcome =
        status === ContinuationActionStatus.Launching
          ? running
          : await state.store.save(firstActionStatus(running, status), running.revision)
      const redirected = {
        ...outcome,
        actions: outcome.actions.map((action, index) =>
          index === 0 ? { ...action, selectedCandidateId: "candidate-2" } : action,
        ),
      }
      await expect(state.store.save(redirected, outcome.revision)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.AttemptProtected,
      })
      expect(await new ContinuationStore(state.root).load(outcome.id)).toEqual(outcome)
    },
  )
})

describe("durable source-bound drafts", () => {
  it("creates revision zero and preserves snapshots, models, summaries, and edits after restart", async () => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    expect(initial.revision).toBe(0)
    const edited = {
      ...assessed(initial),
      summaries: [{ key: "chunk-1", text: "A summary of reported work.", evidenceIds: ["message-1", "message-2"] }],
    }
    const saved = await state.store.save(edited, 0)
    expect(saved.revision).toBe(1)
    expect(edited.revision).toBe(0)
    expect(await new ContinuationStore(state.root).load(initial.id)).toEqual(saved)
    expect(await new ContinuationStore(state.root).find(state.snapshot.source)).toEqual(saved)
  })

  it.each(["sessionId", "serverId", "workspaceId", "paneId", "tabId", "cwd"] as const)(
    "never resumes a draft whose %s differs",
    async (field) => {
      const state = await fixture()
      await state.store.create(state.snapshot, "gpt-5.5", "high")
      const source = { ...state.snapshot.source, [field]: field === "cwd" ? "/work/other" : "different" }
      await expect(state.store.find(source)).resolves.toBeUndefined()
    },
  )

  it("binds Native profile and Sandbox invocation identities", async () => {
    const state = await fixture()
    const source = {
      ...state.snapshot.source,
      surface: ConversationSurface.Sandbox,
      profile: "default",
      containerId: "container-1",
      invocationId: "invocation-1",
    }
    await state.store.create({ ...state.snapshot, source }, "gpt-5.5", "high")
    for (const change of [{ profile: "other" }, { containerId: "container-2" }, { invocationId: "invocation-2" }]) {
      await expect(state.store.find({ ...source, ...change })).resolves.toBeUndefined()
    }
    const native = { ...state.snapshot.source, surface: ConversationSurface.Native, profile: "default" }
    await state.store.create({ ...state.snapshot, source: native }, "gpt-5.5", "high")
    await expect(state.store.find({ ...native, profile: "other" })).resolves.toBeUndefined()
  })

  it("selects the latest explicitly created draft without discarding earlier edits", async () => {
    const state = await fixture()
    const old = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const newerSnapshot = { ...state.snapshot, id: randomUUID(), revision: "b".repeat(64) }
    const latest = await state.store.create(newerSnapshot, "gpt-5.5", "medium")
    expect((await state.store.find(state.snapshot.source))?.id).toBe(latest.id)
    const oldSaved = await state.store.save({ ...old, effort: "low" }, 0)
    expect((await state.store.find(state.snapshot.source))?.id).toBe(latest.id)
    expect(await state.store.load(old.id)).toEqual(oldSaved)
  })

  it("serializes competing saves and rejects the stale revision", async () => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const other = new ContinuationStore(state.root)
    const results = await Promise.allSettled([
      state.store.save({ ...initial, effort: "low" }, 0),
      other.save({ ...initial, effort: "medium" }, 0),
    ])
    const success = results.filter((result) => result.status === PromiseStatus.Fulfilled)
    const rejected = results.filter((result) => result.status === PromiseStatus.Rejected)
    expect(success).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(ContinuationRevisionConflictError)
    expect((await state.store.load(initial.id)).revision).toBe(1)
    await expect(state.store.save(initial, 0)).rejects.toBeInstanceOf(ContinuationRevisionConflictError)
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1])(
    "rejects mismatched or unsafe expected revision %s",
    async (revision) => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      await expect(state.store.save(initial, revision)).rejects.toBeInstanceOf(ContinuationRevisionConflictError)
      expect((await state.store.load(initial.id)).revision).toBe(0)
    },
  )

  it("does not allow a save to replace or edit the immutable snapshot", async () => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const changed = { ...initial, snapshot: { ...initial.snapshot, revision: "b".repeat(64) } }
    await expect(state.store.save(changed, 0)).rejects.toThrow(/immutable/u)
    expect(await state.store.load(initial.id)).toEqual(initial)
  })

  it("surfaces missing, malformed, oversized, and command-bearing saved drafts", async () => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const filename = draftPath(state.root, initial.id)
    await writeFile(filename, JSON.stringify({ ...initial, command: "never restore" }))
    await expect(state.store.load(initial.id)).rejects.toThrow(/unsupported/u)
    await writeFile(filename, `{"private":"${privateText}"`)
    await expect(state.store.find(state.snapshot.source)).rejects.toThrow(/invalid JSON/u)
    const handle = await open(filename, "r+")
    try {
      await handle.truncate(conversationLimits.draftBytes + 1)
    } finally {
      await handle.close()
    }
    await expect(state.store.load(initial.id)).rejects.toThrow(/byte limit/u)
    await rm(filename)
    await expect(state.store.load(initial.id)).rejects.toMatchObject({ code: ContinuationStoreErrorCode.MissingDraft })
    await expect(state.store.find(state.snapshot.source)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.MissingDraft,
    })
  })

  it.each(["mode", "symlink", "hardlink"] as const)("refuses an unsafe saved draft: %s", async (attack) => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const filename = draftPath(state.root, initial.id)
    if (attack === "mode") await chmod(filename, 0o644)
    if (attack === "symlink") {
      const target = path.join(state.directory, "draft-target.json")
      await rename(filename, target)
      await symlink(target, filename)
    }
    if (attack === "hardlink") await link(filename, path.join(state.directory, "draft-link.json"))
    await expect(state.store.load(initial.id)).rejects.toThrow(/mode-0600/u)
    await expect(state.store.save(initial, 0)).rejects.toThrow(/mode-0600/u)
    await expect(state.store.discard(initial.id)).rejects.toThrow(/mode-0600/u)
  })

  it("rejects a source index pointing to another conversation", async () => {
    const state = await fixture()
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    const other = await state.store.create(
      { ...state.snapshot, source: { ...state.snapshot.source, sessionId: "other" } },
      "gpt-5.5",
      "high",
    )
    await writeFile(
      sourcePath(state.root, state.snapshot.source),
      JSON.stringify({
        schemaVersion: 1,
        sourceKey: conversationSourceKey(state.snapshot.source),
        draftId: other.id,
      }),
    )
    await expect(state.store.find(state.snapshot.source)).rejects.toThrow(/exact focused source/u)
  })

  it("does not mask permission errors or corrupt indexes as an absent draft", async () => {
    const state = await fixture()
    await state.store.create(state.snapshot, "gpt-5.5", "high")
    const filename = sourcePath(state.root, state.snapshot.source)
    await chmod(filename, 0o644)
    await expect(state.store.find(state.snapshot.source)).rejects.toThrow(/mode-0600/u)
    await expect(state.store.create(state.snapshot, "gpt-5.5", "high")).rejects.toThrow(/mode-0600/u)
    await chmod(filename, 0o600)
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, sourceKey: "wrong", draftId: randomUUID() }))
    await expect(state.store.find(state.snapshot.source)).rejects.toThrow(/exact source/u)
  })

  it("keeps the last durable revision and removes owned staging after an atomic publish failure", async () => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error(privateText), { code: "EACCES" }))
    await expect(state.store.save({ ...initial, effort: "low" }, 0)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.PermissionDenied,
      message: expect.not.stringContaining(privateText),
    })
    expect(await state.store.load(initial.id)).toEqual(initial)
    expect(await readdir(path.dirname(draftPath(state.root, initial.id)))).toEqual([`${initial.id}.json`])
  })

  it.each(["writeFile", "sync"] as const)(
    "keeps the last revision and removes staging after a failed %s",
    async (operation) => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const { open: originalOpen } = await vi.importActual<typeof fs>("node:fs/promises")
      vi.mocked(fs.open).mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        if (String(args[0]).includes(`${path.sep}.write-`)) {
          vi.spyOn(handle, operation).mockRejectedValueOnce(Object.assign(new Error(privateText), { code: "ENOSPC" }))
        }
        return handle
      })
      await expect(state.store.save({ ...initial, effort: "low" }, 0)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.IoFailure,
        message: expect.not.stringContaining(privateText),
      })
      expect(await state.store.load(initial.id)).toEqual(initial)
      expect(await readdir(path.dirname(draftPath(state.root, initial.id)))).toEqual([`${initial.id}.json`])
    },
  )

  it("preserves transport if index publication fails after writing the snapshot", async () => {
    const state = await fixture()
    const filename = await request(state.root, state.snapshot)
    const { rename: originalRename } = await vi.importActual<typeof fs>("node:fs/promises")
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (String(destination).includes(`${path.sep}sources${path.sep}`)) {
        throw Object.assign(new Error(privateText), { code: "EACCES" })
      }
      return originalRename(source, destination)
    })
    await state.store.consumeRequest(filename)
    await expect(state.store.create(state.snapshot, "gpt-5.5", "high")).rejects.toThrow(/permission denied/u)
    await expect(state.store.acknowledgeRequest(filename)).rejects.toThrow(/durable/u)
    expect(await readFile(filename, "utf8")).toContain(privateText)
    const saved = await readdir(path.join(state.root, "continuations", "drafts"))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatch(/^[0-9a-f-]+\.json$/u)
  })

  it("discards only the chosen owned draft and never resurrects an older draft", async () => {
    const state = await fixture()
    const old = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const latest = await state.store.create({ ...state.snapshot, id: randomUUID() }, "gpt-5.5", "high")
    await state.store.discard(old.id)
    expect((await state.store.find(state.snapshot.source))?.id).toBe(latest.id)
    await expect(state.store.load(old.id)).rejects.toMatchObject({ code: ContinuationStoreErrorCode.MissingDraft })
    await state.store.discard(latest.id)
    expect(await state.store.find(state.snapshot.source)).toBeUndefined()
    await expect(state.store.discard(latest.id)).rejects.toMatchObject({
      code: ContinuationStoreErrorCode.MissingDraft,
    })
  })
})

describe("append-only content-free launch journal", () => {
  it("appends only launch metadata and preserves the audit trail after discard", async () => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    let current = await state.store.save(launching(initial), 0)
    await state.store.appendLaunchEvent(current.id, eventFor(current))
    const filename = journalPath(state.root, current.id)
    const prefix = await readFile(filename, "utf8")
    current = await state.store.save(
      {
        ...current,
        actions: current.actions.map((action, index) =>
          index === 0
            ? {
                ...action,
                status: ContinuationActionStatus.Launched,
                launch: {
                  ...action.launch!,
                  status: ContinuationActionStatus.Launched,
                  paneId: "workspace-1:pane-2",
                  workspaceId: "workspace-1",
                  cwd: "/work/new-tree",
                  message: privateText,
                },
              }
            : action,
        ),
      },
      current.revision,
    )
    await state.store.appendLaunchEvent(current.id, {
      ...eventFor(current),
      paneId: "workspace-1:pane-2",
      workspaceId: "workspace-1",
      cwd: "/work/new-tree",
    })
    const journal = await readFile(filename, "utf8")
    expect(journal.startsWith(prefix)).toBe(true)
    expect(journal.trim().split("\n")).toHaveLength(2)
    expect(journal).not.toContain(privateText)
    expect(journal).not.toContain(state.snapshot.source.sessionId)
    expect((await lstat(filename)).mode & 0o7777).toBe(0o600)
    await state.store.discard(current.id)
    expect(await readFile(filename, "utf8")).toBe(journal)
  })

  describe("durable launch attempt protection", () => {
    it.each(
      [ContinuationActionStatus.Unknown, ContinuationActionStatus.Launched].flatMap((status) =>
        unsafeAttemptChanges.map((change) => ({ status, ...change })),
      ),
    )("does not $name after a saved $status outcome", async ({ status, change }) => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const started = await state.store.save(launching(initial), initial.revision)
      const outcome = await state.store.save(firstActionStatus(started, status), started.revision)
      const reopened = new ContinuationStore(state.root)
      const next = {
        ...outcome,
        actions: outcome.actions.map((action, index) => (index === 0 ? change(action) : action)),
      }
      await expect(reopened.save(next, outcome.revision)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.AttemptProtected,
      })
      expect(await reopened.load(outcome.id)).toEqual(outcome)
      expect((await reopened.find(outcome.snapshot.source))?.actions[0]?.status).toBe(status)
    })

    it("does not remove an unknown attempt by replacing the assessment", async () => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const started = await state.store.save(launching(initial), initial.revision)
      const unknown = await state.store.save(
        firstActionStatus(started, ContinuationActionStatus.Unknown),
        started.revision,
      )
      const erased: ContinuationDraft = {
        ...unknown,
        assessment: { ...unknown.assessment!, outcome: ContinuationOutcome.NoFurtherAction, actions: [] },
        actions: [],
      }
      await expect(state.store.save(erased, unknown.revision)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.AttemptProtected,
      })
      expect((await state.store.load(unknown.id)).actions[0]?.launch?.attemptId).toBe(
        unknown.actions[0]?.launch?.attemptId,
      )
    })

    it("permits selection, receipt metadata, and other action edits without making an unknown action runnable", async () => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const started = await state.store.save(launching(initial), initial.revision)
      const unknown = await state.store.save(
        firstActionStatus(started, ContinuationActionStatus.Unknown),
        started.revision,
      )
      const saved = await state.store.save(
        {
          ...unknown,
          actions: unknown.actions.map((action, index) =>
            index === 0
              ? {
                  ...action,
                  selected: false,
                  launch: {
                    ...action.launch!,
                    paneId: "workspace-1:pane-2",
                    message: "This pane still needs inspection.",
                  },
                }
              : { ...action, brief: `Independent action ${index + 1} remains editable.` },
          ),
        },
        unknown.revision,
      )
      expect(saved.actions[0]?.status).toBe(ContinuationActionStatus.Unknown)
      expect(saved.actions[0]?.selected).toBe(false)
      expect(saved.actions[0]?.prompt).toBe(unknown.actions[0]?.prompt)
      expect(saved.actions[0]?.launch?.attemptId).toBe(unknown.actions[0]?.launch?.attemptId)
      expect(saved.actions[1]?.brief).toBe("Independent action 2 remains editable.")
    })

    it("does not redirect a saved unknown receipt to another pane", async () => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const pending = launching(initial)
      const started = await state.store.save(
        {
          ...pending,
          actions: pending.actions.map((action, index) =>
            index === 0
              ? {
                  ...action,
                  launch: { ...action.launch!, paneId: "workspace-1:pane-2" },
                }
              : action,
          ),
        },
        initial.revision,
      )
      const unknown = await state.store.save(
        firstActionStatus(started, ContinuationActionStatus.Unknown),
        started.revision,
      )
      const redirected = {
        ...unknown,
        actions: unknown.actions.map((action, index) =>
          index === 0
            ? {
                ...action,
                launch: { ...action.launch!, paneId: "workspace-1:pane-3" },
              }
            : action,
        ),
      }
      await expect(state.store.save(redirected, unknown.revision)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.AttemptProtected,
      })
      expect((await state.store.load(unknown.id)).actions[0]?.launch?.paneId).toBe("workspace-1:pane-2")
    })

    it("allows allocation and interrupted-launch recovery but rejects resetting a running attempt", async () => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const started = await state.store.save(launching(initial), initial.revision)
      const allocated = await state.store.save(
        {
          ...started,
          actions: started.actions.map((action, index) =>
            index === 0
              ? {
                  ...action,
                  launch: { ...action.launch!, paneId: "workspace-1:pane-2", cwd: "/work/new" },
                }
              : action,
          ),
        },
        started.revision,
      )
      const reset = {
        ...allocated,
        actions: allocated.actions.map((action, index) =>
          index === 0 ? unsafeAttemptChanges[0]!.change(action) : action,
        ),
      }
      await expect(state.store.save(reset, allocated.revision)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.AttemptProtected,
      })
      const recovered = await state.store.save(
        firstActionStatus(allocated, ContinuationActionStatus.Unknown),
        allocated.revision,
      )
      expect(recovered.actions[0]?.launch).toEqual({
        ...allocated.actions[0]?.launch,
        status: ContinuationActionStatus.Unknown,
      })
    })

    it("requires a new attempt ID for retrying a confirmed failure", async () => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const started = await state.store.save(launching(initial), initial.revision)
      const failed = await state.store.save(
        firstActionStatus(started, ContinuationActionStatus.Failed),
        started.revision,
      )
      const sameAttempt = firstActionStatus(failed, ContinuationActionStatus.Launching)
      await expect(state.store.save(sameAttempt, failed.revision)).rejects.toMatchObject({
        code: ContinuationStoreErrorCode.AttemptProtected,
      })
      const next = {
        ...sameAttempt,
        actions: sameAttempt.actions.map((action, index) =>
          index === 0
            ? {
                ...action,
                launch: { ...action.launch!, attemptId: randomUUID() },
              }
            : action,
        ),
      }
      const retried = await state.store.save(next, failed.revision)
      expect(retried.actions[0]?.status).toBe(ContinuationActionStatus.Launching)
      expect(retried.actions[0]?.launch?.attemptId).not.toBe(started.actions[0]?.launch?.attemptId)
    })
  })

  it.each([
    { prompt: privateText },
    { brief: privateText },
    { text: privateText },
    { message: privateText },
    { command: "must not execute" },
    { argv: ["must-not-execute"] },
    { paneId: "invented-pane" },
    { actionId: "invented-action" },
    { attemptId: "bad-id" },
    { attemptId: "8605d637-60c0-4e18-858f-3df389514929" },
    { status: ContinuationActionStatus.Draft },
    { status: ContinuationActionStatus.Launched },
  ])("rejects non-metadata or unbound launch event %#", async (change) => {
    const state = await fixture()
    const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
    const current = await state.store.save(launching(initial), 0)
    await expect(state.store.appendLaunchEvent(current.id, { ...eventFor(current), ...change })).rejects.toThrow(
      /metadata|journal|UUID/u,
    )
    await expect(lstat(journalPath(state.root, current.id))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["symlink", "hardlink", "mode", "partial", "private-data", "bad-time", "oversized"] as const)(
    "preserves and rejects an unsafe existing journal: %s",
    async (attack) => {
      const state = await fixture()
      const initial = await state.store.create(state.snapshot, "gpt-5.5", "high")
      const current = await state.store.save(launching(initial), 0)
      const event = eventFor(current)
      await state.store.appendLaunchEvent(current.id, event)
      const filename = journalPath(state.root, current.id)
      if (attack === "symlink") {
        const target = path.join(state.directory, "journal-target.jsonl")
        await rename(filename, target)
        await symlink(target, filename)
      }
      if (attack === "hardlink") await link(filename, path.join(state.directory, "journal-link.jsonl"))
      if (attack === "mode") await chmod(filename, 0o644)
      if (attack === "partial") await writeFile(filename, '{"schemaVersion":1')
      if (attack === "private-data") await writeFile(filename, `${JSON.stringify({ prompt: privateText })}\n`)
      if (attack === "bad-time") {
        const record = JSON.parse(await readFile(filename, "utf8"))
        await writeFile(filename, `${JSON.stringify({ ...record, recordedAt: "2026-02-30T00:00:00.000Z" })}\n`)
      }
      if (attack === "oversized") {
        const handle = await open(filename, "r+")
        try {
          await handle.truncate(conversationLimits.journalBytes + 1)
        } finally {
          await handle.close()
        }
      }
      const before = await readFile(filename)
      await expect(state.store.appendLaunchEvent(current.id, event)).rejects.toThrow(
        /mode-0600|incomplete record|unsupported fields|byte limit|calendar time/u,
      )
      expect((await readFile(filename)).equals(before)).toBe(true)
    },
  )
})
