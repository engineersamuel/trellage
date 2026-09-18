import { randomUUID } from "node:crypto"
import { constants, type PathLike, type Stats } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  firstmateSubmissionDigest,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  type FirstmateSubmissionRequestV1,
} from "@trellage/guide-core"
import {
  FIRSTMATE_JOURNAL_MAX_FILE_BYTES,
  FileFirstmateSubmissionJournal,
  FirstmateJournalErrorCode,
  defaultFirstmateJournalPath,
  type FirstmateJournalStatus,
} from "../src/guide-firstmate-journal.ts"
import { firstmateOutcomeFromReceipt, type FirstmateSubmissionOutcome } from "../src/guide-firstmate.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: vi.fn<typeof actual.rename>(actual.rename),
    open: vi.fn<typeof actual.open>(actual.open),
    lstat: vi.fn<typeof actual.lstat>(actual.lstat),
  }
})

const roots: string[] = []
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const privateText = "PRIVATE-FIRSTMATE-INTENT: café 😀\nKeep the original text and whitespace.  "
const request = (): FirstmateSubmissionRequestV1 => parseFirstmateSubmissionRequestV1({
  schemaVersion: 1,
  requestId: randomUUID(),
  expectedFleet: {
    profile: "default",
    instanceId: "20000000-0000-4000-8000-000000000002",
    home: "/home/owner/.local/share/trellage/firstmate/default",
    sourceRevision: "a".repeat(40),
  },
  originalIntent: privateText,
  generatedSpec: "Implement the approved fleet request.",
  workflowId: "fleet-work",
  projectTarget: null,
})
const accepted = (original: FirstmateSubmissionRequestV1, noteId = "note-1"): FirstmateSubmissionOutcome =>
  firstmateOutcomeFromReceipt(original, parseFirstmateSubmissionReceiptV1({
    schemaVersion: 1,
    requestId: original.requestId,
    digest: firstmateSubmissionDigest(original),
    fleet: original.expectedFleet,
    state: "saved",
    noteId,
    announcement: "pending",
    supervisorState: "stopped",
    error: null,
  }))
const missing = (original: FirstmateSubmissionRequestV1): FirstmateSubmissionOutcome =>
  firstmateOutcomeFromReceipt(original, parseFirstmateSubmissionReceiptV1({
    schemaVersion: 1,
    requestId: original.requestId,
    digest: null,
    fleet: original.expectedFleet,
    state: "not-found",
    noteId: null,
    announcement: "not-needed",
    supervisorState: "running",
    error: null,
  }))
const unknown: FirstmateSubmissionOutcome = {
  status: "unknown",
  message: "Transport stopped without a validated receipt. Inspect the same request ID.",
}
const rejected: FirstmateSubmissionOutcome = { status: "rejected", message: "Submission was refused before transport." }
const recordPath = (root: string, requestId: string): string => path.join(root, `${requestId}.json`)
const ioError = (): Error => Object.assign(new Error("Injected journal I/O failure."), { code: "EIO" })
const fixture = async () => {
  const directory = path.join(testDirectory, `.firstmate-journal-${randomUUID()}`)
  roots.push(directory)
  await fs.mkdir(directory, { mode: 0o700 })
  const root = path.join(directory, "state", "journal")
  return { directory, root, journal: new FileFirstmateSubmissionJournal(root), request: request() }
}

afterEach(async () => {
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof fs>("node:fs/promises")
  vi.mocked(fs.rename).mockImplementation(actual.rename)
  vi.mocked(fs.open).mockImplementation(actual.open)
  vi.mocked(fs.lstat).mockImplementation(actual.lstat)
  for (const root of roots.splice(0)) {
    await actual.chmod(root, 0o700)
    await actual.rm(root, { recursive: true, force: true })
  }
})

describe("Firstmate durable request journal", () => {
  it("persists the full request and digest privately before granting a transport attempt", async () => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    const filename = recordPath(state.root, state.request.requestId)
    expect(prepared).toMatchObject({
      request: state.request,
      digest: firstmateSubmissionDigest(state.request),
      status: "prepared",
      receipt: null,
    })
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual(prepared)
    expect((await fs.lstat(state.root)).mode & 0o7777).toBe(0o700)
    expect((await fs.lstat(path.dirname(state.root))).mode & 0o7777).toBe(0o700)
    expect((await fs.lstat(filename)).mode & 0o7777).toBe(0o600)
    expect((await fs.lstat(filename)).nlink).toBe(1)

    const reopened = new FileFirstmateSubmissionJournal(state.root)
    expect(await reopened.get(state.request.requestId)).toEqual(prepared)
    const sending = await reopened.begin(state.request)
    expect(sending.status).toBe("sending")
    expect(await new FileFirstmateSubmissionJournal(state.root).get(state.request.requestId)).toEqual(sending)
    expect((await fs.readdir(state.root)).sort()).toEqual([`${state.request.requestId}.json`])
  })

  it("reopens the same canonical payload without replacing its durable record", async () => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    const filename = recordPath(state.root, state.request.requestId)
    const before = await fs.lstat(filename)
    const reordered = Object.fromEntries(Object.entries(state.request).reverse()) as unknown as FirstmateSubmissionRequestV1
    expect(await new FileFirstmateSubmissionJournal(state.root).prepare(reordered)).toEqual(prepared)
    const after = await fs.lstat(filename)
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs })
  })

  it.each([
    ["intent", (value: FirstmateSubmissionRequestV1) => ({ ...value, originalIntent: "Changed intent." })],
    ["specification", (value: FirstmateSubmissionRequestV1) => ({ ...value, generatedSpec: "Changed specification." })],
    ["workflow", (value: FirstmateSubmissionRequestV1) => ({ ...value, workflowId: "other-work" })],
    ["fleet", (value: FirstmateSubmissionRequestV1) => ({ ...value, expectedFleet: { ...value.expectedFleet, home: "/other/fleet" } })],
    ["project", (value: FirstmateSubmissionRequestV1) => ({
      ...value,
      projectTarget: {
        schemaVersion: 1 as const,
        projectName: "registered-project",
        source: null,
        entryWorktree: null,
        baseRevision: null,
        dirty: null,
        dirtyChanges: "excluded" as const,
      },
    })],
  ] as const)("refuses changed %s content under the same request ID", async (_name, change) => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    await expect(new FileFirstmateSubmissionJournal(state.root).prepare(change(state.request)))
      .rejects.toMatchObject({ code: FirstmateJournalErrorCode.Conflict })
    expect(await state.journal.get(state.request.requestId)).toEqual(prepared)
  })

  it.each(["sending", "unknown", "accepted", "rejected"] as const)(
    "never grants another send or allows payload changes from %s",
    async (status) => {
      const state = await fixture()
      await state.journal.prepare(state.request)
      await state.journal.begin(state.request)
      if (status !== "sending") {
        const outcome = status === "accepted" ? accepted(state.request) : status === "rejected" ? rejected : unknown
        await state.journal.record(state.request, outcome)
      }
      const current = await state.journal.get(state.request.requestId)
      expect(current!.status).toBe(status)
      expect(await state.journal.prepare(state.request)).toEqual(current)
      await expect(state.journal.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.AttemptProtected })
      await expect(state.journal.prepare({ ...state.request, originalIntent: "Changed after transport." }))
        .rejects.toMatchObject({ code: FirstmateJournalErrorCode.Conflict })
      await expect(state.journal.record({ ...state.request, generatedSpec: "Changed specification." }, unknown))
        .rejects.toMatchObject({ code: FirstmateJournalErrorCode.Conflict })
      expect(await state.journal.get(state.request.requestId)).toEqual(current)
    },
  )

  it("requires durable preparation and rejects unsafe request filenames", async () => {
    const state = await fixture()
    await expect(state.journal.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.MissingRequest })
    await expect(state.journal.record(state.request, unknown)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.MissingRequest })
    expect(await state.journal.get(state.request.requestId)).toBeUndefined()
    await expect(state.journal.get("../other")).rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    await expect(state.journal.prepare({ ...state.request, requestId: "../other" }))
      .rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
  })

  it("records lookup absence as unknown, preserving evidence and preventing replay", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    await state.journal.begin(state.request)
    await state.journal.record(state.request, unknown)
    const notFound = missing(state.request)
    const stored = await state.journal.record(state.request, notFound)
    expect(stored).toMatchObject({ status: "unknown", receipt: notFound.receipt })
    const laterUnknown = await new FileFirstmateSubmissionJournal(state.root).record(state.request, unknown)
    expect(laterUnknown.receipt).toEqual(notFound.receipt)
    await expect(state.journal.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.AttemptProtected })
    expect(await state.journal.get(state.request.requestId)).toEqual(laterUnknown)
  })

  it("keeps accepted evidence through delayed unknown/refusal results and updates a handled receipt", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    await state.journal.begin(state.request)
    const saved = await state.journal.record(state.request, accepted(state.request))
    for (const outcome of [unknown, rejected, missing(state.request)]) {
      expect(await state.journal.record(state.request, outcome)).toEqual(saved)
    }
    const handled = firstmateOutcomeFromReceipt(state.request, { ...saved.receipt!, state: "handled", announcement: "not-needed" })
    expect((await state.journal.record(state.request, handled)).receipt!.state).toBe("handled")
    await expect(state.journal.record(state.request, accepted(state.request, "different-note")))
      .rejects.toMatchObject({ code: FirstmateJournalErrorCode.Conflict })
    expect((await state.journal.get(state.request.requestId))!.status).toBe("accepted")
  })

  it("preserves prior accepted bytes when a conflicting payload returns its own attempted digest", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    await state.journal.begin(state.request)
    const saved = await state.journal.record(state.request, accepted(state.request))
    const before = await fs.readFile(recordPath(state.root, state.request.requestId), "utf8")
    const attempted = { ...state.request, generatedSpec: "A different specification under the same request ID." }
    const conflict = firstmateOutcomeFromReceipt(attempted, {
      ...saved.receipt!,
      digest: firstmateSubmissionDigest(attempted),
      state: "rejected",
      noteId: null,
      announcement: "not-needed",
      error: { code: "conflict", message: "This request ID already has different accepted content." },
    })
    expect(conflict).toMatchObject({ status: "rejected", receipt: { digest: firstmateSubmissionDigest(attempted) } })
    await expect(state.journal.record(attempted, conflict))
      .rejects.toMatchObject({ code: FirstmateJournalErrorCode.Conflict })
    await expect(state.journal.record(state.request, conflict))
      .rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    expect(await fs.readFile(recordPath(state.root, state.request.requestId), "utf8")).toBe(before)
    expect(await new FileFirstmateSubmissionJournal(state.root).get(state.request.requestId)).toEqual(saved)
  })

  it("validates receipt binding instead of trusting a caller's accepted label", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    const sending = await state.journal.begin(state.request)
    const valid = accepted(state.request)
    for (const receipt of [
      { ...valid.receipt!, requestId: randomUUID() },
      { ...valid.receipt!, digest: "b".repeat(64) },
      { ...valid.receipt!, fleet: { ...state.request.expectedFleet, home: "/other/fleet" } },
    ]) {
      await expect(state.journal.record(state.request, { status: "accepted", receipt, message: "Accepted." }))
        .rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    }
    await expect(state.journal.record(state.request, { status: "unknown", receipt: valid.receipt!, message: "Unknown." }))
      .rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    expect(await state.journal.get(state.request.requestId)).toEqual(sending)
  })

  it("lists only prepared, sending, and unknown records for caller-controlled reconciliation", async () => {
    const state = await fixture()
    const pending: string[] = []
    for (const status of ["prepared", "sending", "unknown", "accepted", "rejected"] satisfies FirstmateJournalStatus[]) {
      const original = request()
      await state.journal.prepare(original)
      if (status !== "prepared") await state.journal.begin(original)
      if (status === "unknown") await state.journal.record(original, unknown)
      if (status === "accepted") await state.journal.record(original, accepted(original))
      if (status === "rejected") await state.journal.record(original, rejected)
      if (status === "prepared" || status === "sending" || status === "unknown") pending.push(original.requestId)
    }
    expect((await new FileFirstmateSubmissionJournal(state.root).listPending()).map(({ request }) => request.requestId))
      .toEqual(pending.sort())
  })
})

describe("Firstmate journal private path boundaries", () => {
  it("uses private XDG state by default, not the current project or a profile home", () => {
    expect(defaultFirstmateJournalPath({ XDG_STATE_HOME: "/users/test/state", HOME: "/users/test" }))
      .toBe("/users/test/state/trellage/firstmate-submissions")
    expect(defaultFirstmateJournalPath({ HOME: "/users/test" }))
      .toBe("/users/test/.local/state/trellage/firstmate-submissions")
    expect(() => defaultFirstmateJournalPath({ XDG_STATE_HOME: "relative" })).toThrow(/absolute/u)
    for (const invalid of ["relative", "/", "/home/user/../state", "/home/user/state\n"]) {
      expect(() => new FileFirstmateSubmissionJournal(invalid)).toThrow()
    }
  })

  it("refuses unsafe directory permissions without changing them", async () => {
    const state = await fixture()
    await fs.mkdir(state.root, { recursive: true, mode: 0o700 })
    await fs.chmod(state.root, 0o755)
    await expect(state.journal.prepare(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    expect((await fs.lstat(state.root)).mode & 0o7777).toBe(0o755)
    await fs.chmod(state.root, 0o700)
    await fs.chmod(state.directory, 0o777)
    await expect(state.journal.prepare(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    expect((await fs.lstat(state.directory)).mode & 0o7777).toBe(0o777)
  })

  it.each(["root", "ancestor"] as const)("refuses a symbolic-link %s without writing through it", async (which) => {
    const state = await fixture()
    const target = path.join(state.directory, "target")
    await fs.mkdir(target, { mode: 0o700 })
    if (which === "root") {
      await fs.mkdir(path.dirname(state.root), { mode: 0o700 })
      await fs.symlink(target, state.root)
    } else {
      await fs.symlink(target, path.dirname(state.root))
    }
    await expect(state.journal.prepare(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    expect(await fs.readdir(target)).toEqual([])
  })

  it("refuses symbolic-link records and locks without following or removing them", async () => {
    const state = await fixture()
    await state.journal.get(state.request.requestId)
    const target = path.join(state.directory, "target.json")
    await fs.writeFile(target, "unchanged", { mode: 0o600 })
    const filename = recordPath(state.root, state.request.requestId)
    await fs.symlink(target, filename)
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    await expect(state.journal.prepare(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    expect(await fs.readFile(target, "utf8")).toBe("unchanged")
    expect((await fs.lstat(filename)).isSymbolicLink()).toBe(true)
    await fs.symlink(state.directory, path.join(state.root, ".journal.lock"))
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    expect((await fs.lstat(path.join(state.root, ".journal.lock"))).isSymbolicLink()).toBe(true)
  })

  it("refuses nonregular records, public file modes, and hard links", async () => {
    const state = await fixture()
    await state.journal.get(state.request.requestId)
    const filename = recordPath(state.root, state.request.requestId)
    await fs.mkdir(filename, { mode: 0o700 })
    await expect(state.journal.prepare(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    await fs.rmdir(filename)
    await state.journal.prepare(state.request)
    await fs.chmod(filename, 0o644)
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    expect((await fs.lstat(filename)).mode & 0o7777).toBe(0o644)
    await fs.chmod(filename, 0o600)
    await fs.link(filename, path.join(state.directory, "extra-link.json"))
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
    expect((await fs.lstat(filename)).nlink).toBe(2)
  })

  it("refuses a record owned by another user", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    const filename = recordPath(state.root, state.request.requestId)
    const actual = await vi.importActual<typeof fs>("node:fs/promises")
    const originalStatus = await actual.lstat(filename)
    const foreignStatus: Stats = Object.assign(Object.create(Object.getPrototypeOf(originalStatus)), originalStatus, {
      uid: originalStatus.uid + 1,
    })
    vi.mocked(fs.lstat).mockImplementation(((candidate: PathLike) =>
      String(candidate) === filename ? Promise.resolve(foreignStatus) : actual.lstat(candidate)) as typeof fs.lstat)
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.UnsafePath })
  })

  it("detects a replaced journal directory instead of recreating its old state", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    const moved = path.join(state.directory, "old-journal")
    await fs.rename(state.root, moved)
    await fs.mkdir(state.root, { mode: 0o700 })
    await expect(state.journal.prepare(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.Changed })
    expect(await fs.readdir(state.root)).toEqual([])
    expect(JSON.parse(await fs.readFile(recordPath(moved, state.request.requestId), "utf8")).request).toEqual(state.request)
  })

  it("rejects oversized, invalid UTF-8, and digest-corrupt records without repair fallbacks", async () => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    const filename = recordPath(state.root, state.request.requestId)
    const handle = await fs.open(filename, "r+")
    await handle.truncate(FIRSTMATE_JOURNAL_MAX_FILE_BYTES + 1)
    await handle.close()
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    await fs.writeFile(filename, Buffer.from([0xff]))
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    const corrupt = JSON.stringify({ ...prepared, request: { ...prepared.request, originalIntent: "Changed on disk." } })
    await fs.writeFile(filename, corrupt)
    await expect(state.journal.prepare(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    expect(await fs.readFile(filename, "utf8")).toBe(corrupt)
  })

  it("does not accept an invalid saved receipt or unbounded journal message", async () => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    const filename = recordPath(state.root, state.request.requestId)
    await fs.writeFile(filename, JSON.stringify({ ...prepared, status: "accepted", receipt: null }))
    await expect(state.journal.get(state.request.requestId)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    await fs.writeFile(filename, JSON.stringify(prepared))
    await expect(state.journal.record(state.request, { status: "unknown", message: "x".repeat(64 * 1024) }))
      .rejects.toMatchObject({ code: FirstmateJournalErrorCode.InvalidData })
    expect(await state.journal.get(state.request.requestId)).toEqual(prepared)
  })
})

describe("Firstmate journal atomic writes and concurrency", () => {
  it("propagates publication errors, keeps the previous state, and cleans only its own staging file", async () => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    const foreignStage = path.join(state.root, `.write-${randomUUID()}.json`)
    await fs.writeFile(foreignStage, "another writer's retained evidence", { mode: 0o600 })
    vi.mocked(fs.rename).mockRejectedValueOnce(ioError())
    await expect(state.journal.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.IoFailure })
    expect(await state.journal.get(state.request.requestId)).toEqual(prepared)
    expect(await fs.readFile(foreignStage, "utf8")).toBe("another writer's retained evidence")
    expect((await fs.readdir(state.root)).sort()).toEqual([path.basename(foreignStage), `${state.request.requestId}.json`].sort())
    expect((await state.journal.begin(state.request)).status).toBe("sending")
  })

  it("never grants transport when staging fsync fails", async () => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    const actual = await vi.importActual<typeof fs>("node:fs/promises")
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]).includes(`${path.sep}.write-`)) vi.spyOn(handle, "sync").mockRejectedValue(ioError())
      return handle
    })
    await expect(state.journal.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.IoFailure })
    expect(await state.journal.get(state.request.requestId)).toEqual(prepared)
    expect(await fs.readdir(state.root)).toEqual([`${state.request.requestId}.json`])
  })

  it("reports a post-publication fsync failure without resetting an uncertain sending state", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    const actual = await vi.importActual<typeof fs>("node:fs/promises")
    let failed = false
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === state.root && typeof args[1] === "number" && (args[1] & constants.O_DIRECTORY) !== 0 && !failed) {
        failed = true
        vi.spyOn(handle, "sync").mockRejectedValueOnce(ioError())
      }
      return handle
    })
    await expect(state.journal.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.IoFailure })
    expect(failed).toBe(true)
    const reopened = new FileFirstmateSubmissionJournal(state.root)
    expect((await reopened.get(state.request.requestId))!.status).toBe("sending")
    await expect(reopened.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.AttemptProtected })
  })

  it("serializes same-content writers and grants exactly one sending transition", async () => {
    const state = await fixture()
    const other = new FileFirstmateSubmissionJournal(state.root)
    const prepared = await Promise.all([state.journal.prepare(state.request), other.prepare(state.request)])
    expect(prepared[0]).toEqual(prepared[1])
    const results = await Promise.allSettled([state.journal.begin(state.request), other.begin(state.request)])
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
    const failure = results.find(({ status }) => status === "rejected")
    expect(failure).toMatchObject({ status: "rejected", reason: { code: FirstmateJournalErrorCode.AttemptProtected } })
    expect((await state.journal.get(state.request.requestId))!.status).toBe("sending")
  })

  it("does not lose requests or overwrite a conflicting payload across concurrent instances", async () => {
    const state = await fixture()
    const different = { ...state.request, originalIntent: "Another payload for the same ID." }
    const raced = await Promise.allSettled([
      state.journal.prepare(state.request),
      new FileFirstmateSubmissionJournal(state.root).prepare(different),
    ])
    expect(raced.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
    expect(raced.find(({ status }) => status === "rejected"))
      .toMatchObject({ reason: { code: FirstmateJournalErrorCode.Conflict } })
    const saved = (await state.journal.get(state.request.requestId))!
    expect([state.request.originalIntent, different.originalIntent]).toContain(saved.request.originalIntent)
    expect(saved.digest).toBe(firstmateSubmissionDigest(saved.request))

    const independent = Array.from({ length: 6 }, request)
    await Promise.all(independent.map((original) => new FileFirstmateSubmissionJournal(state.root).prepare(original)))
    expect((await state.journal.listPending()).map(({ request }) => request.requestId))
      .toEqual([state.request.requestId, ...independent.map(({ requestId }) => requestId)].sort())
  })

  it("preserves accepted evidence when unknown and accepted results race", async () => {
    const state = await fixture()
    await state.journal.prepare(state.request)
    await state.journal.begin(state.request)
    await Promise.all([
      state.journal.record(state.request, accepted(state.request)),
      new FileFirstmateSubmissionJournal(state.root).record(state.request, unknown),
    ])
    expect((await new FileFirstmateSubmissionJournal(state.root).get(state.request.requestId))!.status).toBe("accepted")
  })

  it("never steals an aged or abandoned lock", async () => {
    const state = await fixture()
    const prepared = await state.journal.prepare(state.request)
    const lock = path.join(state.root, ".journal.lock")
    await fs.mkdir(lock, { mode: 0o700 })
    const old = new Date("2000-01-01T00:00:00.000Z")
    await fs.utimes(lock, old, old)
    const stamp = await fs.lstat(lock)
    await expect(state.journal.begin(state.request)).rejects.toMatchObject({ code: FirstmateJournalErrorCode.LockUnavailable })
    expect((await fs.lstat(lock)).ino).toBe(stamp.ino)
    expect((await fs.lstat(lock)).mtimeMs).toBe(stamp.mtimeMs)
    expect(JSON.parse(await fs.readFile(recordPath(state.root, state.request.requestId), "utf8"))).toEqual(prepared)
  }, 10_000)
})
