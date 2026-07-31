import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Data, Effect, Schema } from "effect"

import { githubRepositoryError } from "./github-repository.js"
import { inventoryDirectory, verifyInventory, type InventoryEntry, type InventoryPolicy } from "./inventory.js"

const execFilePromise = promisify(execFile)

export interface GitClient {
  readonly resolveRef: (repository: string, ref: string) => Effect.Effect<string, unknown>
  readonly checkout: (repository: string, commit: string, destination: string) => Effect.Effect<void, unknown>
}

export interface GitHubSourceRequest {
  readonly repository: string
  readonly ref: string
  readonly lockedCommit?: string
  readonly include?: ReadonlyArray<string>
  readonly inventoryPolicy?: InventoryPolicy
}

export interface CachedGitHubSource {
  readonly repository: string
  readonly ref: string
  readonly commit: string
  readonly directory: string
  readonly integrity: string
  readonly files: ReadonlyArray<InventoryEntry>
}

export interface CachePublisher {
  readonly writeMetadata: (metadataPath: string, files: ReadonlyArray<InventoryEntry>) => Promise<void>
  readonly publishBundle: (temporary: string, destination: string) => Promise<void>
}

export class CacheError extends Data.TaggedError("CacheError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const runGit = (...args: ReadonlyArray<string>): Effect.Effect<string, unknown> =>
  Effect.tryPromise({
    try: async () => (await execFilePromise("git", args, { encoding: "utf8" })).stdout.trim(),
    catch: (cause) => cause,
  })

export const selectCommitFromLsRemote = (output: string): string => {
  const lines = output.split("\n").filter((line) => line.length > 0)
  const peeled = lines.find((line) => line.split(/\s+/, 2)[1]?.endsWith("^{}"))
  return (peeled ?? lines[0] ?? "").split(/\s+/, 1)[0] ?? ""
}

export const NodeGitClient: GitClient = {
  resolveRef: (repository, ref) =>
    runGit("ls-remote", repository, ref, `${ref}^{}`).pipe(
      Effect.flatMap((output) => {
        const commit = selectCommitFromLsRemote(output)
        return /^[0-9a-f]{40}$/.test(commit) ? Effect.succeed(commit) : Effect.fail("ref did not resolve")
      }),
    ),
  checkout: (repository, commit, destination) =>
    Effect.gen(function* () {
      yield* runGit("-C", destination, "init", "--quiet")
      yield* runGit("-C", destination, "remote", "add", "origin", repository)
      yield* runGit("-C", destination, "fetch", "--quiet", "--depth", "1", "origin", commit)
      yield* runGit("-C", destination, "checkout", "--quiet", "--detach", "FETCH_HEAD")
      const actual = yield* runGit("-C", destination, "rev-parse", "HEAD")
      if (actual !== commit) return yield* Effect.fail(`checkout mismatch: ${actual}`)
      yield* Effect.tryPromise({
        try: () => rm(path.join(destination, ".git"), { recursive: true, force: true }),
        catch: (cause) => cause,
      })
    }),
}

const repositoryKey = (repository: string, include: ReadonlyArray<string>, policy: InventoryPolicy): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        inventoryFormat: 2,
        repository,
        include: [...include].sort(),
        allowSymlinks: policy.allowSymlinks === true,
      }),
    )
    .digest("hex")

const treeIntegrity = (files: ReadonlyArray<InventoryEntry>): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`

const NodeCachePublisher: CachePublisher = {
  writeMetadata: (metadataPath, files) =>
    writeFile(metadataPath, `${JSON.stringify(files, null, 2)}\n`, { flag: "wx" }),
  publishBundle: (temporary, destination) => rename(temporary, destination),
}

const scopeCheckout = async (root: string, include: ReadonlyArray<string>): Promise<void> => {
  if (include.length === 0) return
  const normalized = include.map((entry) => entry.split("/").filter(Boolean).join("/"))
  if (normalized.some((entry) => entry.length === 0 || entry === ".." || entry.startsWith("../"))) {
    throw new Error("unsafe included source path")
  }
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      const related = normalized.some(
        (allowed) => relative === allowed || relative.startsWith(`${allowed}/`) || allowed.startsWith(`${relative}/`),
      )
      if (!related) {
        await rm(absolute, { recursive: true, force: true })
        continue
      }
      if (entry.isDirectory()) await visit(absolute)
    }
  }
  await visit(root)
}

const MetadataText = Schema.String.pipe(Schema.minLength(1))
const InventoryMetadataSchema = Schema.Array(
  Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("file"),
      path: MetadataText,
      sha256: MetadataText,
      executable: Schema.optional(Schema.Literal(true)),
    }),
    Schema.Struct({ kind: Schema.Literal("symlink"), path: MetadataText, target: MetadataText }),
  ),
)

const readInventory = (metadataPath: string): Effect.Effect<ReadonlyArray<InventoryEntry>, CacheError> =>
  Effect.tryPromise({
    try: () => readFile(metadataPath, "utf8"),
    catch: (cause) => new CacheError({ message: "cache metadata is invalid", cause }),
  }).pipe(
    Effect.flatMap((source) =>
      Effect.try({
        try: () => JSON.parse(source),
        catch: (cause) => new CacheError({ message: "cache metadata is invalid", cause }),
      }),
    ),
    Effect.flatMap((value) => Schema.decodeUnknown(InventoryMetadataSchema)(value, { onExcessProperty: "error" })),
    Effect.mapError((cause) =>
      cause instanceof CacheError ? cause : new CacheError({ message: "cache metadata is invalid", cause }),
    ),
  )

const exists = (candidate: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      await import("node:fs/promises").then(({ access }) => access(candidate))
      return true
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))

export const resolveGitHubSource = (
  xdgCacheHome: string,
  request: GitHubSourceRequest,
  git: GitClient = NodeGitClient,
  publisher: CachePublisher = NodeCachePublisher,
): Effect.Effect<CachedGitHubSource, CacheError> =>
  Effect.gen(function* () {
    const repositoryError = githubRepositoryError(request.repository)
    if (repositoryError !== undefined) {
      return yield* Effect.fail(new CacheError({ message: `${repositoryError}: ${request.repository}` }))
    }
    if (
      /^[0-9a-f]{40}$/.test(request.ref) &&
      request.lockedCommit !== undefined &&
      request.ref !== request.lockedCommit
    ) {
      return yield* Effect.fail(new CacheError({ message: "exact ref does not match locked commit" }))
    }
    const commit =
      request.lockedCommit ??
      (/^[0-9a-f]{40}$/.test(request.ref)
        ? request.ref
        : yield* git
            .resolveRef(request.repository, request.ref)
            .pipe(
              Effect.mapError(
                (cause) => new CacheError({ message: `cannot resolve GitHub ref: ${request.ref}`, cause }),
              ),
            ))
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      return yield* Effect.fail(new CacheError({ message: `invalid Git commit: ${commit}` }))
    }

    const include = request.include ?? []
    const inventoryPolicy = request.inventoryPolicy ?? {}
    const parent = path.join(
      path.resolve(xdgCacheHome),
      "harness",
      "github",
      repositoryKey(request.repository, include, inventoryPolicy),
    )
    const bundle = path.join(parent, commit)
    const directory = path.join(bundle, "checkout")
    const metadataPath = path.join(bundle, "inventory.json")
    const legacyMetadataPath = path.join(parent, `${commit}.inventory.json`)
    yield* Effect.tryPromise({
      try: () => mkdir(parent, { recursive: true }),
      catch: (cause) => new CacheError({ message: "cannot create cache directory", cause }),
    })

    const cached = yield* readInventory(metadataPath).pipe(
      Effect.flatMap((files) => verifyInventory(directory, files, inventoryPolicy).pipe(Effect.as(files))),
      Effect.option,
    )

    if (cached._tag === "Some") {
      return {
        ...request,
        commit,
        directory,
        files: cached.value,
        integrity: treeIntegrity(cached.value),
      }
    }

    const [bundleExists, directoryExists, metadataExists, legacyMetadataExists] = yield* Effect.all([
      exists(bundle),
      exists(directory),
      exists(metadataPath),
      exists(legacyMetadataPath),
    ])
    if (bundleExists && !directoryExists && !metadataExists) {
      yield* Effect.tryPromise({
        try: async () => {
          await rm(bundle, { recursive: true, force: true })
          await rm(legacyMetadataPath, { force: true })
        },
        catch: (cause) => new CacheError({ message: "cannot clean legacy cache entry", cause }),
      })
    } else if (bundleExists || directoryExists || metadataExists) {
      return yield* Effect.fail(
        new CacheError({ message: `cache verification failed: ${request.repository}@${commit}` }),
      )
    } else if (legacyMetadataExists) {
      yield* Effect.tryPromise({
        try: () => rm(legacyMetadataPath, { force: true }),
        catch: (cause) => new CacheError({ message: "cannot clean legacy cache metadata", cause }),
      })
    }

    const temporaryBundle = yield* Effect.tryPromise({
      try: () => mkdtemp(path.join(parent, ".materialize-")),
      catch: (cause) => new CacheError({ message: "cannot create temporary cache directory", cause }),
    })
    const temporaryCheckout = path.join(temporaryBundle, "checkout")
    const temporaryMetadata = path.join(temporaryBundle, "inventory.json")
    const cleanup = Effect.tryPromise({
      try: () => rm(temporaryBundle, { recursive: true, force: true }),
      catch: () => undefined,
    }).pipe(Effect.ignore)

    const materializedFiles = yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(temporaryCheckout),
        catch: (cause) => new CacheError({ message: "cannot create temporary checkout directory", cause }),
      })
      yield* git
        .checkout(request.repository, commit, temporaryCheckout)
        .pipe(
          Effect.mapError((cause) => new CacheError({ message: `cannot checkout GitHub commit: ${commit}`, cause })),
        )
      yield* Effect.tryPromise({
        try: () => scopeCheckout(temporaryCheckout, include),
        catch: (cause) => new CacheError({ message: "cannot scope source checkout", cause }),
      })
      const files = yield* inventoryDirectory(temporaryCheckout, inventoryPolicy).pipe(
        Effect.mapError((cause) => new CacheError({ message: "source inventory failed", cause })),
      )
      const publishedFiles = yield* Effect.tryPromise({
        try: async () => {
          await publisher.writeMetadata(temporaryMetadata, files)
          await publisher.publishBundle(temporaryBundle, bundle)
        },
        catch: (cause) => new CacheError({ message: "cannot publish cache atomically", cause }),
      }).pipe(
        Effect.as(files),
        Effect.catchAll((publicationError) =>
          readInventory(metadataPath).pipe(
            Effect.flatMap((winnerFiles) => {
              if (JSON.stringify(winnerFiles) !== JSON.stringify(files)) {
                return Effect.fail(new CacheError({ message: "published cache inventory does not match" }))
              }
              return verifyInventory(directory, winnerFiles, inventoryPolicy).pipe(
                Effect.mapError((cause) => new CacheError({ message: "published cache verification failed", cause })),
                Effect.as(winnerFiles),
              )
            }),
            Effect.catchAll(() => Effect.fail(publicationError)),
          ),
        ),
      )
      return publishedFiles
    }).pipe(Effect.ensuring(cleanup))

    return {
      ...request,
      commit,
      directory,
      files: materializedFiles,
      integrity: treeIntegrity(materializedFiles),
    }
  })
