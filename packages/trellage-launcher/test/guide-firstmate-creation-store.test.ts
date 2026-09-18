import { randomUUID } from "node:crypto"
import { constants, type PathLike } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { canonicalFirstmateInstanceJson } from "@trellage/guide-core"
import { FileFirstmateCreationPlanStore } from "../src/guide-firstmate-creation-store.ts"
import { initialFirstmateInstanceMenu, runFirstmateInstanceMenuOperation } from "../src/guide-firstmate-instance-menu.ts"
import { alpha, instancePlan, instanceProfile, InstanceRunner } from "./helpers/firstmate-instance-flow.ts"

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) }
})

const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
const roots: string[] = []
const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const restoreIo = (): void => {
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open)
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link)
}
beforeEach(restoreIo)
afterEach(async () => {
  vi.restoreAllMocks()
  restoreIo()
  for (const root of roots.splice(0)) await actual.rm(root, { recursive: true, force: true })
})
const fixture = async () => {
  const root = path.join(testDirectory, `.fmi-creation-${randomUUID()}`)
  await actual.mkdir(root, { mode: 0o700 })
  roots.push(root)
  const store = new FileFirstmateCreationPlanStore(path.join(root, "plans"))
  const plan = instancePlan()
  const directory = path.join(store.root, plan.reference.profile)
  const filename = path.join(directory, `${plan.reference.instanceId}.json`)
  return { store, plan, directory, filename }
}
const failure = (code: string): Error => Object.assign(new Error(`Injected ${code}`), { code })

const failFile = (kind: "write" | "short-write" | "file-sync"): void => {
  let injected = false
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args)
    if (!injected && typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0) {
      injected = true
      if (kind === "file-sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(failure("EIO"))
      else {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await write("{", "utf8")
          if (kind === "write") throw failure("ENOSPC")
        })
      }
    }
    return handle
  })
}

describe("atomic private creation approvals", () => {
  it("refuses a symlinked ancestor even when its target is private", async () => {
    const f = await fixture()
    const root = path.dirname(f.store.root)
    const linked = path.join(root, "linked")
    await actual.symlink(root, linked)
    const redirected = new FileFirstmateCreationPlanStore(path.join(linked, "plans"))
    await expect(redirected.save(f.plan)).rejects.toThrow("safe ownership and no links")
    await expect(actual.lstat(f.filename)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await f.store.list("default")).toEqual([])
  })

  it.each([0o770, 0o777])("refuses writable ancestors with mode %i without changing their permissions", async (mode) => {
    const f = await fixture()
    const root = path.dirname(f.store.root)
    await actual.mkdir(f.store.root, { mode: 0o700 })
    await actual.chmod(root, mode)
    try {
      await expect(f.store.save(f.plan)).rejects.toThrow("safe ownership and no links")
      expect((await actual.lstat(root)).mode & 0o7777).toBe(mode)
      await expect(actual.lstat(f.filename)).rejects.toMatchObject({ code: "ENOENT" })
    } finally { await actual.chmod(root, 0o700) }
    expect(await f.store.list("default")).toEqual([])
  })

  it.each(["write", "file-sync"] as const)("does not publish the UUID record while %s is still pending", async (phase) => {
    const f = await fixture()
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let intercepted = false
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (!intercepted && typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0) {
        intercepted = true
        if (phase === "write") {
          const write = handle.writeFile.bind(handle)
          vi.spyOn(handle, "writeFile").mockImplementationOnce(async (...data) => {
            entered()
            await waiting
            await write(...data)
          })
        } else {
          const sync = handle.sync.bind(handle)
          vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
            entered()
            await waiting
            await sync()
          })
        }
      }
      return handle
    })
    const saving = f.store.save(f.plan)
    try {
      await Promise.race([
        started,
        saving.then(() => { throw new Error(`Save completed without entering the ${phase} phase.`) }),
      ])
      await expect(actual.lstat(f.filename)).rejects.toMatchObject({ code: "ENOENT" })
    } finally { release(); await saving }
    expect(await f.store.list("default")).toEqual([f.plan])
  })

  it.each(["write", "short-write", "file-sync", "publication"] as const)(
    "does not expose an incomplete plan after %s failure and permits the same UUID retry",
    async (kind) => {
      const f = await fixture()
      if (kind === "publication") vi.mocked(fs.link).mockRejectedValueOnce(failure("EIO"))
      else failFile(kind)
      await expect(f.store.save(f.plan)).rejects.toThrow()
      expect(await new FileFirstmateCreationPlanStore(f.store.root).list("default")).toEqual([])
      expect(await actual.readdir(f.directory)).not.toContain(path.basename(f.filename))
      restoreIo()
      await f.store.save(f.plan)
      expect(await new FileFirstmateCreationPlanStore(f.store.root).list("default")).toEqual([f.plan])
      expect((await actual.lstat(f.filename)).nlink).toBe(1)
    },
  )

  it("retains a complete plan if publication succeeds before its error is reported", async () => {
    const f = await fixture()
    vi.mocked(fs.link).mockImplementationOnce(async (source, destination) => {
      await actual.link(source, destination)
      throw failure("EIO")
    })
    await expect(f.store.save(f.plan)).rejects.toThrow("Injected EIO")
    expect(await f.store.list("default")).toEqual([f.plan])
    expect((await actual.lstat(f.filename)).nlink).toBe(1)
    await f.store.save(f.plan)
    expect(await f.store.list("default")).toEqual([f.plan])
  })

  it("keeps published data readable after directory fsync fails and resynchronizes an identical retry", async () => {
    const f = await fixture()
    let injected = false
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[0] === f.directory) {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          const published = await actual.lstat(f.filename).then(() => true, () => false)
          if (published && !injected) {
            injected = true
            throw failure("EIO")
          }
          await sync()
        })
      }
      return handle
    })
    await expect(f.store.save(f.plan)).rejects.toThrow("Injected EIO")
    expect(await f.store.list("default")).toEqual([f.plan])
    await f.store.save(f.plan)
    expect(await f.store.list("default")).toEqual([f.plan])
  })

  it("is idempotent for concurrent identical plans across separate store objects", async () => {
    const f = await fixture()
    const second = new FileFirstmateCreationPlanStore(f.store.root)
    await Promise.all([f.store.save(f.plan), second.save(f.plan), f.store.save(f.plan)])
    expect(await second.list("default")).toEqual([f.plan])
    expect((await actual.lstat(f.filename)).nlink).toBe(1)
    expect((await actual.lstat(f.filename)).mode & 0o777).toBe(0o600)
    await Promise.all([f.store.complete(f.plan), second.complete(f.plan)])
    expect(await second.list("default")).toEqual([])
  })

  it("publishes only one of two conflicting concurrent approvals for the same UUID", async () => {
    const f = await fixture()
    const other = instancePlan({ ...alpha, name: "other-name" })
    const second = new FileFirstmateCreationPlanStore(f.store.root)
    const outcomes = await Promise.allSettled([f.store.save(f.plan), second.save(other)])
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
    const refused = outcomes.find((outcome) => outcome.status === "rejected")
    expect(refused?.status === "rejected" ? String(refused.reason) : "").toContain("cannot be replaced")
    const winner = outcomes[0]?.status === "fulfilled" ? f.plan : other
    expect(await second.list("default")).toEqual([winner])
    await expect(second.complete(winner === f.plan ? other : f.plan)).rejects.toThrow("cannot be replaced")
    expect(await second.list("default")).toEqual([winner])
  })

  it("does not replace a conflicting record that arrives immediately before publication", async () => {
    const f = await fixture()
    const other = instancePlan({ ...alpha, name: "other-name" })
    vi.mocked(fs.link).mockImplementationOnce(async (source, destination) => {
      await actual.writeFile(destination, canonicalFirstmateInstanceJson(other), { flag: "wx", mode: 0o600 })
      await actual.link(source, destination)
    })
    await expect(f.store.save(f.plan)).rejects.toThrow("cannot be replaced")
    expect(await f.store.list("default")).toEqual([other])
  })

  it("does not delete or treat another writer's staging file as a recovery plan", async () => {
    const f = await fixture()
    await f.store.save(f.plan)
    await f.store.complete(f.plan)
    const otherStage = path.join(f.directory, `.write-${randomUUID()}.json`)
    await actual.writeFile(otherStage, "{", { mode: 0o600 })
    failFile("write")
    await expect(f.store.save(f.plan)).rejects.toThrow("ENOSPC")
    expect(await f.store.list("default")).toEqual([])
    expect(await actual.readFile(otherStage, "utf8")).toBe("{")
  })

  it("does not remove another writer's file after the owned staging path is replaced", async () => {
    const f = await fixture()
    let replacement: PathLike | undefined
    let injected = false
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (!injected && typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0) {
        injected = true
        replacement = args[0]
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await actual.unlink(args[0])
          await actual.writeFile(args[0], "Other writer's staging.", { flag: "wx", mode: 0o600 })
          throw failure("ENOSPC")
        })
      }
      return handle
    })
    await expect(f.store.save(f.plan)).rejects.toThrow("No other writer's staging was removed")
    if (replacement === undefined) throw new Error("The fixture did not intercept a staged write.")
    expect(await actual.readFile(replacement, "utf8")).toBe("Other writer's staging.")
    expect(await f.store.list("default")).toEqual([])
  })

  it.each(["write", "file-sync", "publication"] as const)("does not invoke Native creation after an approval %s failure", async (kind) => {
    const f = await fixture()
    const runner = new InstanceRunner()
    if (kind === "publication") vi.mocked(fs.link).mockRejectedValueOnce(failure("EIO"))
    else failFile(kind)
    const result = await runFirstmateInstanceMenuOperation({
      profile: instanceProfile(), runner, cwd: "/work/alpha", creationStore: f.store,
    }, {
      ...initialFirstmateInstanceMenu("/work/alpha"),
      screen: "creation", approvedPlan: f.plan, creationUncertain: true, operation: { kind: "create", plan: f.plan },
    }, new AbortController().signal)
    expect(result.type).toBe("failed")
    expect(runner.calls).toEqual([])
    expect(await f.store.list("default")).toEqual([])
  })
})
