#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun --no-install --no-env-file --config=/dev/null

import fs from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import bunRuntime from "./bun-runtime.json" with { type: "json" }

enum Operation {
  Publish = "publish",
  RemoveOwned = "remove-owned",
  Journal = "journal",
  SyncFile = "sync-file",
  SyncDirectory = "sync-directory",
  Snapshot = "snapshot",
  Validate = "validate",
  VerifyOwned = "verify-owned",
}

interface SnapshotRecord {
  path: string
  size: string
  mtimeNs: string
  ctimeNs: string
  sha256: string
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

const report = (label: string, error: unknown): void => {
  process.stderr.write(`trellage-claude-entry: ${label}: ${message(error)}\n`)
  process.exitCode = 1
}

const required = (args: readonly string[], index: number): string => {
  const value = args[index]
  if (value === undefined) throw new Error(`missing managed-file argument ${index + 1}`)
  return value
}

const pathsFrom = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
const digest = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

const managedFile = (root: string, relative: string): string => {
  const candidate = path.resolve(root, relative)
  if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`unsafe managed path: ${relative}`)
  return candidate
}

const requireDirectory = (directory: string, label: string): void => {
  const status = fs.lstatSync(directory)
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`unsafe ${label}: ${directory}`)
}

const syncDirectory = (directory: string): void => {
  requireDirectory(directory, "synchronization directory")
  const descriptor = fs.openSync(directory, "r")
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

const syncFile = (file: string): void => {
  const status = fs.lstatSync(file)
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`unsafe synchronization file: ${file}`)
  const descriptor = fs.openSync(file, "r")
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  syncDirectory(path.dirname(file))
}

const ensureDirectory = (
  root: string,
  relative: string,
  label: string,
  sync: (directory: string) => void = syncDirectory,
): void => {
  let current = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      requireDirectory(current, `${label} directory`)
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error
      fs.mkdirSync(current, { mode: 0o700 })
      sync(path.dirname(current))
    }
  }
}

const sameOwnedFile = (candidate: fs.Stats | fs.BigIntStats, ownership: fs.Stats | fs.BigIntStats): boolean =>
  candidate.isFile() &&
  !candidate.isSymbolicLink() &&
  ownership.isFile() &&
  !ownership.isSymbolicLink() &&
  candidate.dev === ownership.dev &&
  candidate.ino === ownership.ino

const publish = (args: readonly string[]): void => {
  const stagingRoot = required(args, 0)
  const destinationRoot = required(args, 1)
  const pathsFile = required(args, 2)
  const ownershipRoot = required(args, 3)
  try {
    requireDirectory(destinationRoot, "destination root")
    if (ownershipRoot !== "") requireDirectory(ownershipRoot, "ownership root")
    for (const relative of pathsFrom(pathsFile)) {
      try {
        const staged = managedFile(stagingRoot, relative)
        const destination = managedFile(destinationRoot, relative)
        const status = fs.lstatSync(staged)
        if (!status.isFile() || status.isSymbolicLink()) throw new Error(`unsafe staged file: ${relative}`)
        if (ownershipRoot !== "") {
          const ownership = managedFile(ownershipRoot, relative)
          ensureDirectory(ownershipRoot, path.dirname(relative), "destination")
          fs.linkSync(staged, ownership)
        }
        ensureDirectory(destinationRoot, path.dirname(relative), "destination")
        fs.linkSync(staged, destination)
        fs.unlinkSync(staged)
      } catch (error) {
        report(`atomic publication failed for ${relative}`, error)
      }
    }
  } catch (error) {
    report("atomic publication failed", error)
  }
}

const snapshotRecord = (value: unknown): SnapshotRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid managed snapshot record")
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const string = (name: keyof SnapshotRecord): string => {
    const field = fields[name]
    if (typeof field !== "string") throw new Error(`invalid managed snapshot field: ${name}`)
    return field
  }
  return {
    path: string("path"),
    size: string("size"),
    mtimeNs: string("mtimeNs"),
    ctimeNs: string("ctimeNs"),
    sha256: string("sha256"),
  }
}

const readSnapshot = (file: string): Map<string, SnapshotRecord> => {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
  if (!Array.isArray(value)) throw new Error("invalid managed snapshot metadata")
  const records = new Map<string, SnapshotRecord>()
  for (const entry of value) {
    const record = snapshotRecord(entry)
    if (records.has(record.path)) throw new Error(`duplicate managed snapshot path: ${record.path}`)
    records.set(record.path, record)
  }
  return records
}

interface Removal {
  destinationRoot: string
  ownershipRoot: string
  quarantineRoot: string
  recoveryRoot: string
  retainMarker: string
  strict: boolean
  expected: ReadonlyMap<string, SnapshotRecord>
}

const matchesSnapshot = (
  removal: Removal,
  status: fs.BigIntStats,
  file: string,
  relative: string,
  includeChangeTime: boolean,
): boolean => {
  if (!removal.strict) return true
  const expected = removal.expected.get(relative)
  return (
    expected !== undefined &&
    status.size.toString() === expected.size &&
    status.mtimeNs.toString() === expected.mtimeNs &&
    (!includeChangeTime || status.ctimeNs.toString() === expected.ctimeNs) &&
    digest(file) === expected.sha256
  )
}

const retainTransaction = (marker: string, relative: string): void => {
  const descriptor = fs.openSync(marker, "a", 0o600)
  try {
    fs.writeFileSync(descriptor, `${relative}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  syncDirectory(path.dirname(marker))
}

const preserveUnexpectedFile = (
  removal: Removal,
  quarantined: string,
  destination: string,
  recovered: string,
  relative: string,
): void => {
  let restored = false
  try {
    fs.linkSync(quarantined, destination)
    restored = true
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      process.stderr.write(`trellage-claude-entry: could not restore concurrent path ${relative}: ${message(error)}\n`)
    }
  }
  try {
    try {
      requireDirectory(removal.recoveryRoot, "recovery root")
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error
      fs.mkdirSync(removal.recoveryRoot, { mode: 0o700 })
      syncDirectory(path.dirname(removal.recoveryRoot))
      requireDirectory(removal.recoveryRoot, "recovery root")
    }
    ensureDirectory(removal.recoveryRoot, path.dirname(relative), "rollback")
    fs.renameSync(quarantined, recovered)
    const status = fs.lstatSync(recovered)
    if (status.isFile() && !status.isSymbolicLink()) syncFile(recovered)
    else syncDirectory(path.dirname(recovered))
    if (restored) syncDirectory(path.dirname(destination))
    process.stderr.write(`trellage-claude-entry: preserved concurrent path ${relative} at ${recovered}\n`)
  } catch (error) {
    retainTransaction(removal.retainMarker, relative)
    throw new Error(`cannot preserve concurrent path ${relative}: ${message(error)}`, { cause: error })
  }
}

const removeOwnedFile = (removal: Removal, relative: string, quarantined: string): void => {
  const destination = managedFile(removal.destinationRoot, relative)
  const ownership = managedFile(removal.ownershipRoot, relative)
  const recovered = managedFile(removal.recoveryRoot, relative)
  const destinationStat = fs.lstatSync(destination, { bigint: true })
  const ownershipStat = fs.lstatSync(ownership, { bigint: true })
  if (
    !sameOwnedFile(destinationStat, ownershipStat) ||
    !matchesSnapshot(removal, destinationStat, destination, relative, true)
  ) {
    if (!removal.strict) return
    retainTransaction(removal.retainMarker, relative)
    throw new Error(`managed path ownership changed: ${relative}`)
  }
  ensureDirectory(removal.quarantineRoot, path.dirname(relative), "rollback")
  fs.renameSync(destination, quarantined)
  syncDirectory(path.dirname(destination))
  syncDirectory(path.dirname(quarantined))
  const quarantinedStat = fs.lstatSync(quarantined, { bigint: true })
  if (
    !sameOwnedFile(quarantinedStat, ownershipStat) ||
    !matchesSnapshot(removal, quarantinedStat, quarantined, relative, false)
  ) {
    preserveUnexpectedFile(removal, quarantined, destination, recovered, relative)
    if (removal.strict) {
      retainTransaction(removal.retainMarker, relative)
      process.exitCode = 1
    }
  }
}

const reportRemovalFailure = (
  removal: Removal,
  relative: string,
  quarantined: string | undefined,
  error: unknown,
): void => {
  if (hasCode(error, "ENOENT") && !removal.strict) return
  if (removal.strict || (quarantined !== undefined && fs.existsSync(quarantined))) {
    try {
      retainTransaction(removal.retainMarker, relative)
    } catch (retainError) {
      report(`cannot retain rollback for ${relative}`, retainError)
    }
  }
  report(`managed rollback failed for ${relative}`, error)
}

const removeOwned = (args: readonly string[]): void => {
  const strictFlag = required(args, 6)
  if (strictFlag !== "true" && strictFlag !== "false") throw new Error("strict removal must be true or false")
  const strict = strictFlag === "true"
  const metadata = required(args, 7)
  const removal: Removal = {
    destinationRoot: required(args, 0),
    ownershipRoot: required(args, 1),
    quarantineRoot: required(args, 2),
    recoveryRoot: required(args, 3),
    retainMarker: required(args, 4),
    strict,
    expected: strict && metadata !== "" ? readSnapshot(metadata) : new Map(),
  }
  for (const relative of pathsFrom(required(args, 5))) {
    let quarantined: string | undefined
    try {
      quarantined = managedFile(removal.quarantineRoot, relative)
      removeOwnedFile(removal, relative, quarantined)
    } catch (error) {
      reportRemovalFailure(removal, relative, quarantined, error)
    }
  }
}

const journal = (args: readonly string[]): void => {
  let descriptor: number | undefined
  try {
    syncDirectory(required(args, 0))
    descriptor = fs.openSync(required(args, 2), "wx", 0o600)
    fs.writeFileSync(descriptor, "managed-state transaction is active\n")
    fs.fsyncSync(descriptor)
    syncDirectory(required(args, 1))
  } catch (error) {
    report("cannot create transaction journal", error)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

const snapshotFile = (
  roots: readonly [source: string, ownership: string, backup: string],
  relative: string,
  sync: (directory: string) => void,
): SnapshotRecord => {
  const [sourceRoot, ownershipRoot, backupRoot] = roots
  const source = managedFile(sourceRoot, relative)
  const ownership = managedFile(ownershipRoot, relative)
  const backup = managedFile(backupRoot, relative)
  const original = fs.lstatSync(source, { bigint: true })
  if (!original.isFile() || original.isSymbolicLink()) throw new Error(`unsafe managed source: ${relative}`)
  ensureDirectory(ownershipRoot, path.dirname(relative), "snapshot", sync)
  ensureDirectory(backupRoot, path.dirname(relative), "snapshot", sync)
  fs.linkSync(source, ownership)
  const owned = fs.lstatSync(ownership, { bigint: true })
  const linked = fs.lstatSync(source, { bigint: true })
  if (!sameOwnedFile(original, owned) || !sameOwnedFile(original, linked)) {
    throw new Error(`managed source changed before snapshotting: ${relative}`)
  }
  fs.copyFileSync(ownership, backup, fs.constants.COPYFILE_FICLONE)
  fs.chmodSync(backup, Number(owned.mode & 0o777n))
  const current = fs.lstatSync(source, { bigint: true })
  const sourceDigest = digest(ownership)
  if (
    !sameOwnedFile(current, owned) ||
    current.size !== owned.size ||
    current.mtimeNs !== owned.mtimeNs ||
    current.ctimeNs !== owned.ctimeNs ||
    digest(backup) !== sourceDigest
  ) {
    throw new Error(`managed source changed while snapshotting: ${relative}`)
  }
  sync(path.dirname(ownership))
  sync(path.dirname(backup))
  return {
    path: relative,
    size: current.size.toString(),
    mtimeNs: current.mtimeNs.toString(),
    ctimeNs: current.ctimeNs.toString(),
    sha256: sourceDigest,
  }
}

const snapshot = (args: readonly string[]): void => {
  const roots: readonly [string, string, string] = [required(args, 0), required(args, 1), required(args, 2)]
  const synced = new Set<string>()
  const sync = (directory: string): void => {
    if (synced.has(directory)) return
    syncDirectory(directory)
    synced.add(directory)
  }
  const records: SnapshotRecord[] = []
  let failed = false
  for (const relative of pathsFrom(required(args, 3))) {
    try {
      records.push(snapshotFile(roots, relative, sync))
    } catch (error) {
      failed = true
      report(`managed snapshot failed for ${relative}`, error)
    }
  }
  if (failed) return
  const metadata = required(args, 4)
  const descriptor = fs.openSync(metadata, "wx", 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(records)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  sync(path.dirname(metadata))
}

const validate = (args: readonly string[]): void => {
  const root = required(args, 0)
  for (const relative of pathsFrom(required(args, 1))) {
    try {
      const status = fs.lstatSync(managedFile(root, relative))
      if (!status.isFile() || status.isSymbolicLink()) throw new Error(`unsafe managed file: ${relative}`)
    } catch (error) {
      report(`managed file validation failed for ${relative}`, error)
    }
  }
}

const verifyOwned = (args: readonly string[]): void => {
  const destinationRoot = required(args, 0)
  const ownershipRoot = required(args, 1)
  for (const relative of pathsFrom(required(args, 2))) {
    try {
      const destination = fs.lstatSync(managedFile(destinationRoot, relative))
      const ownership = fs.lstatSync(managedFile(ownershipRoot, relative))
      if (!sameOwnedFile(destination, ownership)) throw new Error(`restored file ownership does not match: ${relative}`)
    } catch (error) {
      report(`managed restore verification failed for ${relative}`, error)
    }
  }
}

interface Command {
  argumentCount: number
  execute: (args: readonly string[]) => void
}

const commands: Readonly<Record<Operation, Command>> = {
  [Operation.Publish]: { argumentCount: 4, execute: publish },
  [Operation.RemoveOwned]: { argumentCount: 8, execute: removeOwned },
  [Operation.Journal]: { argumentCount: 3, execute: journal },
  [Operation.SyncFile]: { argumentCount: 1, execute: (args) => syncFile(required(args, 0)) },
  [Operation.SyncDirectory]: { argumentCount: 1, execute: (args) => syncDirectory(required(args, 0)) },
  [Operation.Snapshot]: { argumentCount: 5, execute: snapshot },
  [Operation.Validate]: { argumentCount: 2, execute: validate },
  [Operation.VerifyOwned]: { argumentCount: 3, execute: verifyOwned },
}

if (import.meta.main) {
  try {
    if (process.versions.bun !== bunRuntime.version) throw new Error(`Bun ${bunRuntime.version} is required`)
    const [operation, ...args] = process.argv.slice(2)
    const command = Object.entries(commands).find(([name]) => name === operation)?.[1]
    if (command === undefined) throw new Error(`unknown managed-file command: ${operation ?? ""}`)
    if (args.length !== command.argumentCount) {
      throw new Error(`${operation} expects ${command.argumentCount} arguments`)
    }
    command.execute(args)
  } catch (error) {
    report("managed-file command failed", error)
  }
}
