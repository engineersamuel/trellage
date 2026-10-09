import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { NativeSource } from "../native-config.ts"
import { NativeRunError, type NativeRunPaths } from "./paths.ts"

const execFilePromise = promisify(execFile)

export interface SourceTransport {
  readonly listTags?: (repository: string) => Promise<readonly string[]>
  /** Resolve a ref (HEAD or a tag) to a full commit ID. Rejects when the remote is unreachable. */
  readonly resolveRef: (repository: string, ref: string) => Promise<string>
  /** Materialize the exact commit into an empty destination directory without Git metadata. */
  readonly fetchCommit: (repository: string, commit: string, destination: string) => Promise<void>
}

export type SourceSelector =
  | { readonly kind: "default" }
  | { readonly kind: "tag"; readonly value: string }
  | { readonly kind: "commit"; readonly value: string }

export interface ResolvedSource {
  readonly sourceId: string
  readonly repository: string
  readonly selector: SourceSelector
  readonly commit: string
  readonly directory: string
  readonly digest: string
  readonly warning?: string | undefined
}

interface ReceiptFile {
  readonly version: 1
  readonly pins: Readonly<Record<string, string>>
  readonly floating: Readonly<Record<string, { readonly commit: string; readonly checkedAt: string }>>
}

const emptyReceipts: ReceiptFile = { version: 1, pins: {}, floating: {} }
const fullCommit = /^[a-f0-9]{40}$/

export const selectorOf = (source: NativeSource): SourceSelector =>
  source.commit !== undefined
    ? { kind: "commit", value: source.commit }
    : source.tag !== undefined
      ? { kind: "tag", value: source.tag }
      : { kind: "default" }

const run = async (cwd: string, args: ReadonlyArray<string>, timeout: number): Promise<string> =>
  (
    await execFilePromise("git", args, {
      cwd,
      encoding: "utf8",
      timeout,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    })
  ).stdout

export const githubUrl = (repository: string): string => `https://github.com/${repository}.git`

const REFRESH_TIMEOUT_MS = 2_000

export const gitSourceTransport = (remoteUrl: (repository: string) => string = githubUrl): SourceTransport => ({
  listTags: async (repository) =>
    (await run(process.cwd(), ["ls-remote", "--tags", "--refs", remoteUrl(repository)], 30_000))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1]!.replace(/^refs\/tags\//, "")),
  resolveRef: async (repository, ref) => {
    const refs = ref === "HEAD" ? ["HEAD"] : [`refs/tags/${ref}`, `refs/tags/${ref}^{}`]
    const output = await run(process.cwd(), ["ls-remote", remoteUrl(repository), ...refs], REFRESH_TIMEOUT_MS)
    const lines = output.split("\n").filter((line) => line.length > 0)
    const peeled = lines.find((line) => line.split(/\s+/)[1]?.endsWith("^{}"))
    const commit = (peeled ?? lines[0] ?? "").split(/\s+/)[0] ?? ""
    if (!fullCommit.test(commit)) throw new Error(`ref ${ref} not found`)
    return commit
  },
  fetchCommit: async (repository, commit, destination) => {
    await run(destination, ["init", "-q"], 30_000)
    await run(destination, ["fetch", "-q", "--depth", "1", remoteUrl(repository), commit], 120_000)
    await run(destination, ["-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"], 30_000)
    await rm(path.join(destination, ".git"), { recursive: true, force: true })
  },
})

/**
 * Digest of a tree: relative path, mode class and bytes. Symlinks are refused unless
 * `recordSymlinks` is set, which hashes their targets (whole-repository cache entries only).
 */
export const digestDirectory = async (directory: string, recordSymlinks = false): Promise<string> => {
  const hash = createHash("sha256")
  const walk = async (relative: string): Promise<void> => {
    const entries = (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    for (const entry of entries) {
      const child = path.join(relative, entry.name)
      if (relative === "" && entry.name === ".trellage-receipt") continue
      if (entry.isSymbolicLink()) {
        if (!recordSymlinks) throw new NativeRunError("unsafe-path", `symbolic link in source content: ${child}`)
        hash.update(`l:${child}:${await readlink(path.join(directory, child))}\0`)
        continue
      }
      if (entry.isDirectory()) {
        hash.update(`d:${child}\0`)
        await walk(child)
      } else if (entry.isFile()) {
        const info = await lstat(path.join(directory, child))
        hash.update(`f:${child}:${info.mode & 0o111 ? "x" : "-"}\0`)
        hash.update(await readFile(path.join(directory, child)))
        hash.update("\0")
      } else throw new NativeRunError("unsafe-path", `unsupported file type in source content: ${child}`)
    }
  }
  await walk("")
  return hash.digest("hex")
}

const receiptName = ".trellage-receipt"

/** Cheap change detector: paths, sizes and mtimes, no file reads. A mismatch triggers the full digest. */
const statSignature = async (directory: string): Promise<string> => {
  const lines: string[] = []
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry) => {
        if (relative === "" && entry.name === receiptName) return
        if (entry.isDirectory()) return walk(path.join(relative, entry.name))
        const info = await lstat(path.join(directory, relative, entry.name))
        lines.push(`${relative}/${entry.name}:${info.size}:${info.mtimeMs}:${info.mode}`)
      }),
    )
  }
  await walk("")
  return createHash("sha256").update(lines.sort().join("\0")).digest("hex")
}

export interface SourceResolverOptions {
  readonly paths: NativeRunPaths
  readonly transport: SourceTransport
  readonly now?: () => Date
  /** Deprecated compatibility input; floating sources always refresh on load. */
  readonly ttlSeconds?: number
  readonly readOnly?: boolean
}

export interface SourceResolver {
  readonly resolve: (sourceId: string, source: NativeSource) => Promise<ResolvedSource>
  /** Advance the last-good floating receipt after selected content validated. */
  readonly markGood: (resolved: ResolvedSource) => Promise<void>
}

export const createSourceResolver = (options: SourceResolverOptions): SourceResolver => {
  const { paths, transport } = options
  const now = options.now ?? (() => new Date())
  const receiptsPath = path.join(paths.state, "receipts.json")
  const inflight = new Map<string, Promise<string>>()
  const references = new Map<string, Promise<string>>()
  const resolveRef = (repository: string, ref: string): Promise<string> => {
    const key = `${repository}|${ref}`
    const existing = references.get(key)
    if (existing) return existing
    const task = transport.resolveRef(repository, ref).finally(() => references.delete(key))
    references.set(key, task)
    return task
  }

  const readReceipts = async (): Promise<ReceiptFile> => {
    try {
      const parsed = JSON.parse(await readFile(receiptsPath, "utf8")) as ReceiptFile
      return parsed.version === 1 ? parsed : emptyReceipts
    } catch {
      return emptyReceipts
    }
  }
  const withReceiptLock = async <T>(operation: () => Promise<T>, lock = `${receiptsPath}.lock`): Promise<T> => {
    for (let attempt = 0; attempt < 600; attempt++) {
      try {
        await mkdir(lock)
        await writeFile(path.join(lock, "pid"), String(process.pid))
        try {
          return await operation()
        } finally {
          await rm(lock, { recursive: true, force: true })
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
        const pid = Number(await readFile(path.join(lock, "pid"), "utf8").catch(() => ""))
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
              await rm(lock, { recursive: true, force: true })
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    throw new NativeRunError("source-unavailable", "timed out waiting for source receipt writer")
  }

  let receiptWrites = Promise.resolve()
  const writeReceipts = (update: (current: ReceiptFile) => ReceiptFile): Promise<void> => {
    const operation = receiptWrites.then(async () => {
      if (options.readOnly) return
      await mkdir(paths.state, { recursive: true })
      await withReceiptLock(async () => {
        const next = update(await readReceipts())
        const temporary = `${receiptsPath}.${process.pid}.${Math.random().toString(36).slice(2)}`
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
        await rename(temporary, receiptsPath)
      })
    })
    receiptWrites = operation.catch(() => {})
    return operation
  }

  const cacheDirectory = (repository: string, commit: string): string =>
    path.join(paths.cache, "sources", repository.replace("/", "__"), commit)

  /** Returns the cached directory only when its recorded digest still matches its bytes. */
  const validCache = async (
    repository: string,
    commit: string,
  ): Promise<{ directory: string; digest: string } | null> => {
    const directory = cacheDirectory(repository, commit)
    try {
      const [recorded, recordedSignature] = (await readFile(path.join(directory, receiptName), "utf8"))
        .trim()
        .split("\n")
      const signature = await statSignature(directory)
      if (recordedSignature === signature) return { directory, digest: recorded! }
      const digest = await digestDirectory(directory, true)
      if (recorded !== digest) return null
      if (!options.readOnly) await writeFile(path.join(directory, receiptName), `${digest}\n${signature}\n`)
      return { directory, digest }
    } catch {
      return null
    }
  }

  const ensureCommit = (repository: string, commit: string): Promise<string> => {
    const key = `${repository}@${commit}`
    const existing = inflight.get(key)
    if (existing) return existing
    const task = (async () => {
      const destination = cacheDirectory(repository, commit)
      await mkdir(path.dirname(destination), { recursive: true })
      return withReceiptLock(async () => {
        if (await validCache(repository, commit)) return destination
        const staging = await mkdtemp(path.join(path.dirname(destination), `.stage-${commit.slice(0, 8)}-`))
        try {
          await transport.fetchCommit(repository, commit, staging)
          const digest = await digestDirectory(staging, true)
          await writeFile(path.join(staging, receiptName), `${digest}\n${await statSignature(staging)}\n`)
          await rm(destination, { recursive: true, force: true })
          try {
            await rename(staging, destination)
          } catch (error) {
            // A concurrent launch published the same verified commit first.
            if (!(await validCache(repository, commit))) throw error
          }
          return destination
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      }, `${destination}.lock`)
    })().finally(() => inflight.delete(key))
    inflight.set(key, task)
    return task
  }

  const describe = (error: unknown): string => (error instanceof Error ? error.message.split("\n")[0]! : String(error))

  const resolveCommitSource = async (
    sourceId: string,
    repository: string,
    selector: SourceSelector,
    commit: string,
    warning?: string,
  ): Promise<ResolvedSource> => {
    let cached = await validCache(repository, commit)
    if (!cached) {
      try {
        await ensureCommit(repository, commit)
      } catch (error) {
        throw new NativeRunError(
          "source-unavailable",
          `source ${sourceId} (${repository}@${commit.slice(0, 12)}) is not cached and could not be fetched: ${describe(error)}`,
        )
      }
      cached = await validCache(repository, commit)
      if (!cached)
        throw new NativeRunError("source-unavailable", `source ${sourceId} failed integrity validation after fetch`)
    }
    return { sourceId, repository, selector, commit, directory: cached.directory, digest: cached.digest, warning }
  }

  return {
    resolve: async (sourceId, source) => {
      const repository = source.repository
      const selector = selectorOf(source)
      if (selector.kind === "commit") return resolveCommitSource(sourceId, repository, selector, selector.value)

      if (selector.kind === "tag") {
        const key = `${repository}|tag|${selector.value}`
        let bound = (await readReceipts()).pins[key]
        if (!bound) {
          try {
            bound = await resolveRef(repository, selector.value)
          } catch (error) {
            throw new NativeRunError(
              "source-unavailable",
              `source ${sourceId}: tag ${selector.value} of ${repository} cannot be resolved and has no recorded binding: ${describe(error)}`,
            )
          }
          const commit = bound
          await writeReceipts((current) => ({
            ...current,
            pins: { ...current.pins, [key]: current.pins[key] ?? commit },
          }))
          bound = (await readReceipts()).pins[key] ?? commit
        }
        return resolveCommitSource(sourceId, repository, selector, bound)
      }

      // Resolve on every load; only validated content may be used offline.
      try {
        const latest = await resolveRef(repository, "HEAD")
        return await resolveCommitSource(sourceId, repository, selector, latest)
      } catch (error) {
        const last = (await readReceipts()).floating[repository]
        const cached = last ? await validCache(repository, last.commit) : null
        if (last && cached) {
          return {
            sourceId,
            repository,
            selector,
            commit: last.commit,
            directory: cached.directory,
            digest: cached.digest,
            warning: `source ${sourceId} (${repository}) could not be refreshed (${describe(error)}); using cached ${last.commit.slice(0, 12)} last checked ${last.checkedAt}`,
          }
        }
        if (error instanceof NativeRunError) throw error
        throw new NativeRunError(
          "source-unavailable",
          `source ${sourceId} (${repository}) cannot be refreshed and has no cached content: ${describe(error)}`,
        )
      }
    },
    markGood: async (resolved) => {
      if (resolved.selector.kind !== "default" || resolved.warning) return
      await writeReceipts((current) => ({
        ...current,
        floating: {
          ...current.floating,
          [resolved.repository]: { commit: resolved.commit, checkedAt: now().toISOString() },
        },
      }))
    },
  }
}
