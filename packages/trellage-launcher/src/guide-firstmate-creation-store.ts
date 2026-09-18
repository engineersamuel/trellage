import { randomUUID } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  canonicalFirstmateInstanceJson, parseFirstmateInstanceCreationPlanV1,
  type FirstmateInstanceCreationPlanV1,
} from "@trellage/guide-core"

export interface FirstmateCreationPlanStore {
  list(profile: string): Promise<ReadonlyArray<FirstmateInstanceCreationPlanV1>>
  save(plan: FirstmateInstanceCreationPlanV1): Promise<void>
  complete(plan: FirstmateInstanceCreationPlanV1): Promise<void>
}

const missing = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"
const exists = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "EEXIST"
const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
const lockName = ".creation.lock"
const stagingName = /^\.write-[a-f0-9-]{36}\.json$/u
type AssertHeld = () => Promise<void>
const uid = (): number => {
  if (process.getuid === undefined) throw new Error("Creation-plan ownership cannot be verified on this host.")
  return process.getuid()
}
const profileName = (profile: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(profile)) throw new Error("Invalid creation-plan profile.")
  return profile
}
const privateFile = (stamp: Stats): void => {
  if (!stamp.isFile() || stamp.isSymbolicLink() || stamp.uid !== uid() ||
      stamp.nlink !== 1 || (stamp.mode & 0o7777) !== 0o600 || stamp.size > 64 * 1024) {
    throw new Error("Creation plans require owned, single-link, mode-0600 regular files within the wire limit.")
  }
}
const directoryChain = (directory: string): ReadonlyArray<string> => {
  const root = path.parse(directory).root
  const result = [root]
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) result.push(path.join(result.at(-1)!, part))
  return result
}

/** Private recovery evidence, never a model artifact or a fresh installation approval. */
export class FileFirstmateCreationPlanStore implements FirstmateCreationPlanStore {
  constructor(readonly root = path.join(homedir(), ".local", "state", "trellage", "firstmate-instance-creations")) {
    if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error("Creation-plan root must be an absolute normalized path.")
  }

  private async directory(profile: string, create: boolean): Promise<Stats | undefined> {
    const location = path.join(this.root, profileName(profile))
    let previous: { path: string; stamp: Stats } | undefined
    let stamp: Stats | undefined
    for (const directory of directoryChain(location)) {
      if (previous !== undefined && !sameIdentity(previous.stamp, await lstat(previous.path))) {
        throw new Error("Creation-plan directory changed during inspection.")
      }
      stamp = await this.directoryEntry(directory, create)
      if (stamp === undefined) return undefined
      previous = { path: directory, stamp }
    }
    return stamp
  }

  private async directoryEntry(directory: string, create: boolean): Promise<Stats | undefined> {
    let created = false
    if (create) {
      try { await mkdir(directory, { mode: 0o700 }); created = true } catch (cause) { if (!exists(cause)) throw cause }
    }
    let stamp: Stats
    try { stamp = await lstat(directory) } catch (cause) { if (missing(cause)) return undefined; throw cause }
    this.checkDirectory(directory, stamp)
    if (created) await this.syncPath(path.dirname(directory))
    return stamp
  }

  private checkDirectory(directory: string, stamp: Stats): void {
    const privateMode = directory === this.root || directory.startsWith(`${this.root}${path.sep}`)
    const ownerUnsafe = privateMode ? stamp.uid !== uid() : stamp.uid !== uid() && stamp.uid !== 0
    const modeUnsafe = privateMode ? (stamp.mode & 0o7777) !== 0o700 : (stamp.mode & 0o022) !== 0
    if (!stamp.isDirectory() || stamp.isSymbolicLink() || ownerUnsafe || modeUnsafe) {
      throw new Error("Creation-plan directories must have safe ownership and no links; private roots require mode 0700.")
    }
  }

  private async assertDirectory(profile: string, expected: Stats): Promise<void> {
    const current = await this.directory(profile, false)
    if (current === undefined || !sameIdentity(expected, current)) {
      throw new Error("Creation-plan directory changed during the operation.")
    }
  }

  private async acquireLock(profile: string, directory: Stats): Promise<{ assertHeld: AssertHeld; release: AssertHeld }> {
    const location = path.join(this.root, profile, lockName)
    for (let attempt = 0; attempt <= 100; attempt += 1) {
      await this.assertDirectory(profile, directory)
      let created = false
      try { await mkdir(location, { mode: 0o700 }); created = true } catch (cause) { if (!exists(cause)) throw cause }
      const held = await this.directoryEntry(location, false)
      if (created && held !== undefined) return this.ownedLock(profile, directory, location, held)
      if (attempt < 100) await delay(25)
    }
    throw new Error("Another writer or an abandoned creation-plan lock blocks this operation. The lock was not stolen; inspect it before retrying.")
  }

  private ownedLock(profile: string, directory: Stats, location: string, held: Stats) {
    const assertHeld = async (): Promise<void> => {
      await this.assertDirectory(profile, directory)
      const current = await this.directoryEntry(location, false)
      if (current === undefined || !sameIdentity(held, current)) throw new Error("The creation-plan lock changed or disappeared.")
    }
    return {
      assertHeld,
      release: async () => {
        await assertHeld()
        await rmdir(location)
        await this.syncDirectory(profile)
      },
    }
  }

  // Readers wait until link publication has removed the writer's staging link.
  private async locked<T>(profile: string, directory: Stats, operation: (assertHeld: AssertHeld) => Promise<T>): Promise<T> {
    const lock = await this.acquireLock(profile, directory)
    try { await lock.assertHeld(); return await operation(lock.assertHeld) }
    finally { await lock.release() }
  }

  private async assertFileUnchanged(location: string, expected: Stats): Promise<void> {
    const current = await lstat(location)
    privateFile(current)
    if (!sameFile(expected, current)) throw new Error("Creation-plan evidence changed during synchronization.")
  }

  private async read(profile: string, filename: string, synchronize = false): Promise<FirstmateInstanceCreationPlanV1> {
    const directory = await this.directory(profile, false)
    if (directory === undefined) throw new Error("The approved creation plan is missing.")
    const location = path.join(this.root, profileName(profile), filename)
    const before = await lstat(location)
    privateFile(before)
    const handle = await open(location, (synchronize ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      privateFile(opened)
      if (!sameFile(before, opened)) throw new Error("Creation-plan file changed before reading.")
      const buffer = Buffer.alloc(64 * 1024 + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const bytes = buffer.subarray(0, bytesRead)
      if (bytesRead !== opened.size || bytes.length > 64 * 1024 || !sameFile(opened, await handle.stat()) ||
          !sameFile(opened, await lstat(location)) ||
          !sameIdentity(directory, (await this.directory(profile, false))!)) {
        throw new Error("Creation-plan evidence changed during reading.")
      }
      const text = bytes.toString("utf8")
      if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Creation-plan data is not valid UTF-8.")
      const plan = parseFirstmateInstanceCreationPlanV1(JSON.parse(text))
      if (plan.reference.profile !== profile || filename !== `${plan.reference.instanceId}.json`) {
        throw new Error("Creation plan belongs to another instance.")
      }
      if (synchronize) {
        await handle.sync()
        await this.assertFileUnchanged(location, opened)
      }
      return plan
    } finally { await handle.close() }
  }

  async list(profile: string): Promise<ReadonlyArray<FirstmateInstanceCreationPlanV1>> {
    const directory = await this.directory(profile, false)
    if (directory === undefined) return []
    return this.locked(profile, directory, async (assertHeld) => {
      const plans = await this.listPlans(profile)
      await assertHeld()
      return plans
    })
  }

  private async listPlans(profile: string): Promise<ReadonlyArray<FirstmateInstanceCreationPlanV1>> {
    const entries = await readdir(path.join(this.root, profile))
    if (entries.length > 2049) throw new Error("Too many private creation-plan entries. Inspect pending plans and staging files.")
    const plans: FirstmateInstanceCreationPlanV1[] = []
    for (const filename of entries.sort()) {
      if (filename === lockName) continue
      if (stagingName.test(filename)) {
        privateFile(await lstat(path.join(this.root, profile, filename)))
        continue
      }
      if (!/^[0-9a-f-]{36}\.json$/u.test(filename)) throw new Error("Unexpected private creation-plan entry.")
      if (plans.length === 1024) throw new Error("Too many pending creation plans. Resolve them before creating another instance.")
      plans.push(await this.read(profile, filename))
    }
    return plans
  }

  async save(value: FirstmateInstanceCreationPlanV1): Promise<void> {
    const plan = parseFirstmateInstanceCreationPlanV1(value)
    const text = canonicalFirstmateInstanceJson(plan)
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("Creation plan exceeds the private file limit.")
    const directory = await this.directory(plan.reference.profile, true)
    if (directory === undefined) throw new Error("The private creation-plan directory is missing.")
    await this.locked(plan.reference.profile, directory, async (assertHeld) => {
      const existing = await this.existing(plan)
      if (existing !== undefined) this.requireSamePlan(plan, existing)
      else await this.publish(plan, text, assertHeld)
      await assertHeld()
      await this.syncDirectory(plan.reference.profile)
    })
  }

  private async existing(plan: FirstmateInstanceCreationPlanV1, synchronize = true): Promise<FirstmateInstanceCreationPlanV1 | undefined> {
    try { return await this.read(plan.reference.profile, `${plan.reference.instanceId}.json`, synchronize) }
    catch (cause) { if (missing(cause)) return undefined; throw cause }
  }

  private requireSamePlan(expected: FirstmateInstanceCreationPlanV1, saved: FirstmateInstanceCreationPlanV1): void {
    if (canonicalFirstmateInstanceJson(saved) !== canonicalFirstmateInstanceJson(expected)) {
      throw new Error("The saved creation UUID already has another approved plan. It cannot be replaced.")
    }
  }

  private async writeStaged(location: string, text: string, created: (stamp: Stats) => void): Promise<Stats> {
    const handle = await open(location, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      const initial = await handle.stat()
      privateFile(initial)
      created(initial)
      await handle.writeFile(text, "utf8")
      await handle.sync()
      const written = await handle.stat()
      privateFile(written)
      if (written.size !== Buffer.byteLength(text, "utf8") || !sameFile(written, await lstat(location))) {
        throw new Error("Creation-plan staging is incomplete or changed before publication.")
      }
      return written
    } finally { await handle.close() }
  }

  private async removeOwnedStage(location: string, owned: Stats, assertHeld: AssertHeld): Promise<void> {
    await assertHeld()
    let current: Stats
    try { current = await lstat(location) } catch (cause) { if (missing(cause)) return; throw cause }
    if (!current.isFile() || current.isSymbolicLink() || current.uid !== uid() ||
        (current.mode & 0o7777) !== 0o600 || !sameIdentity(owned, current)) {
      throw new Error("The owned staging file changed. No other writer's staging was removed.")
    }
    await unlink(location)
  }

  private async publish(plan: FirstmateInstanceCreationPlanV1, text: string, assertHeld: AssertHeld): Promise<void> {
    const filename = `${plan.reference.instanceId}.json`
    const location = path.join(this.root, plan.reference.profile, filename)
    const staged = path.join(this.root, plan.reference.profile, `.write-${randomUUID()}.json`)
    let owned: Stats | undefined
    try {
      const written = await this.writeStaged(staged, text, (stamp) => { owned = stamp })
      await assertHeld()
      if (!sameFile(written, await lstat(staged))) throw new Error("The staged creation plan changed before publication.")
      try {
        // link is atomic and refuses an existing destination; rename could overwrite another approval.
        await link(staged, location)
      } catch (cause) {
        if (!exists(cause)) throw cause
        this.requireSamePlan(plan, await this.read(plan.reference.profile, filename, true))
      }
    } finally {
      if (owned !== undefined) await this.removeOwnedStage(staged, owned, assertHeld)
    }
    this.requireSamePlan(plan, await this.read(plan.reference.profile, filename, true))
  }

  async complete(value: FirstmateInstanceCreationPlanV1): Promise<void> {
    const plan = parseFirstmateInstanceCreationPlanV1(value)
    const directory = await this.directory(plan.reference.profile, false)
    if (directory === undefined) return
    const filename = `${plan.reference.instanceId}.json`
    await this.locked(plan.reference.profile, directory, async (assertHeld) => {
      const saved = await this.existing(plan, false)
      if (saved === undefined) return
      this.requireSamePlan(plan, saved)
      await assertHeld()
      await unlink(path.join(this.root, plan.reference.profile, filename))
      await this.syncDirectory(plan.reference.profile)
    })
  }

  private syncDirectory(profile: string): Promise<void> {
    return this.syncPath(path.join(this.root, profile))
  }

  private async syncPath(directory: string): Promise<void> {
    const expected = await this.directoryEntry(directory, false)
    if (expected === undefined) throw new Error("A creation-plan directory is missing before synchronization.")
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      if (!sameIdentity(expected, await handle.stat())) throw new Error("A creation-plan directory changed before synchronization.")
      await handle.sync()
      const current = await this.directoryEntry(directory, false)
      if (current === undefined || !sameIdentity(expected, current)) throw new Error("A creation-plan directory changed during synchronization.")
    } finally { await handle.close() }
  }
}
