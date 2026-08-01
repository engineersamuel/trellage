import { createHash } from "node:crypto"
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises"
import path from "node:path"

import { Data, Effect } from "effect"

export type InventoryEntry =
  | { readonly kind: "file"; readonly path: string; readonly sha256: string; readonly executable?: true | undefined }
  | { readonly kind: "symlink"; readonly path: string; readonly target: string }

export interface InventoryPolicy {
  readonly allowSymlinks?: boolean
  readonly verifyExecutableBits?: boolean
}

export class InventoryError extends Data.TaggedError("InventoryError")<{
  readonly message: string
}> {}

const sha256 = (content: Uint8Array): string => `sha256:${createHash("sha256").update(content).digest("hex")}`

interface CollectedSymlink {
  readonly absolute: string
  readonly path: string
}

const outside = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
}

const inventoryPath = (root: string, absolute: string): string =>
  path.relative(root, absolute).split(path.sep).join("/")

const collect = async (
  root: string,
  directory: string,
  policy: InventoryPolicy,
  symlinks: Array<CollectedSymlink>,
): Promise<Array<InventoryEntry>> => {
  const result: Array<InventoryEntry> = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"))
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    const relative = inventoryPath(root, absolute)
    const status = await lstat(absolute)
    if (status.isSymbolicLink()) {
      if (!policy.allowSymlinks) throw new InventoryError({ message: `symlink rejected: ${relative}` })
      const target = await readlink(absolute)
      if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
        throw new InventoryError({ message: `absolute symlink target rejected: ${relative}` })
      }
      const resolvedTarget = path.resolve(path.dirname(absolute), target)
      if (outside(root, resolvedTarget)) {
        throw new InventoryError({ message: `symlink target escapes inventory root: ${relative}` })
      }
      result.push({ kind: "symlink", path: relative, target })
      symlinks.push({ absolute, path: relative })
      continue
    }
    if (status.isDirectory()) {
      result.push(...(await collect(root, absolute, policy, symlinks)))
      continue
    }
    if (!status.isFile()) throw new InventoryError({ message: `non-regular asset rejected: ${relative}` })
    const file = { kind: "file" as const, path: relative, sha256: sha256(await readFile(absolute)) }
    result.push((status.mode & 0o111) === 0 ? file : { ...file, executable: true })
  }
  return result
}

const validateSymlinks = async (
  root: string,
  inventory: ReadonlyArray<InventoryEntry>,
  symlinks: ReadonlyArray<CollectedSymlink>,
): Promise<void> => {
  const realRoot = await realpath(root)
  for (const symlink of symlinks) {
    let realTarget: string
    try {
      realTarget = await realpath(symlink.absolute)
    } catch {
      throw new InventoryError({ message: `invalid symlink target (broken or cycle): ${symlink.path}` })
    }
    if (outside(realRoot, realTarget)) {
      throw new InventoryError({ message: `symlink target escapes real inventory root: ${symlink.path}` })
    }
    const targetPath = inventoryPath(realRoot, realTarget)
    const targetStatus = await stat(realTarget)
    const represented = targetStatus.isFile()
      ? inventory.some((entry) => entry.kind === "file" && entry.path === targetPath)
      : targetStatus.isDirectory() &&
        inventory.some((entry) => targetPath.length === 0 || entry.path.startsWith(`${targetPath}/`))
    if (!represented) {
      throw new InventoryError({ message: `symlink target is not represented by inventory: ${symlink.path}` })
    }
  }
}

export const inventoryDirectory = (
  root: string,
  policy: InventoryPolicy = {},
): Effect.Effect<ReadonlyArray<InventoryEntry>, InventoryError> =>
  Effect.tryPromise({
    try: async () => {
      const resolvedRoot = path.resolve(root)
      const symlinks: Array<CollectedSymlink> = []
      const inventory = await collect(resolvedRoot, resolvedRoot, policy, symlinks)
      inventory.sort((left, right) => left.path.localeCompare(right.path, "en"))
      await validateSymlinks(resolvedRoot, inventory, symlinks)
      return inventory
    },
    catch: (cause) =>
      cause instanceof InventoryError
        ? cause
        : new InventoryError({ message: `cannot inventory directory: ${String(cause)}` }),
  })

export const verifyInventory = (
  root: string,
  expected: ReadonlyArray<InventoryEntry>,
  policy: InventoryPolicy = {},
): Effect.Effect<void, InventoryError> =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    for (const entry of expected) {
      if (seen.has(entry.path)) {
        return yield* Effect.fail(new InventoryError({ message: `duplicate inventory path: ${entry.path}` }))
      }
      seen.add(entry.path)
    }
    if (!policy.allowSymlinks && expected.some((entry) => entry.kind === "symlink")) {
      return yield* Effect.fail(new InventoryError({ message: "symlink rejected by inventory policy" }))
    }
    const actual = yield* inventoryDirectory(root, policy)
    if (actual.length !== expected.length) {
      return yield* Effect.fail(
        new InventoryError({
          message: `inventory count mismatch: expected ${expected.length}, actual ${actual.length}`,
        }),
      )
    }
    for (let index = 0; index < expected.length; index += 1) {
      const expectedEntry = expected[index]!
      const actualEntry = actual[index]!
      if (actualEntry.path !== expectedEntry.path) {
        return yield* Effect.fail(
          new InventoryError({
            message: `inventory path mismatch: expected ${expectedEntry.path}, actual ${actualEntry.path}`,
          }),
        )
      }
      if (actualEntry.kind !== expectedEntry.kind) {
        return yield* Effect.fail(new InventoryError({ message: `inventory type mismatch: ${expectedEntry.path}` }))
      }
      if (actualEntry.kind === "file" && expectedEntry.kind === "file" && actualEntry.sha256 !== expectedEntry.sha256) {
        return yield* Effect.fail(new InventoryError({ message: `hash mismatch: ${expectedEntry.path}` }))
      }
      if (
        (policy.verifyExecutableBits ?? true) &&
        actualEntry.kind === "file" &&
        expectedEntry.kind === "file" &&
        (actualEntry.executable ?? false) !== (expectedEntry.executable ?? false)
      ) {
        return yield* Effect.fail(new InventoryError({ message: `executable bit mismatch: ${expectedEntry.path}` }))
      }
      if (
        actualEntry.kind === "symlink" &&
        expectedEntry.kind === "symlink" &&
        actualEntry.target !== expectedEntry.target
      ) {
        return yield* Effect.fail(new InventoryError({ message: `symlink target mismatch: ${expectedEntry.path}` }))
      }
    }
  })
