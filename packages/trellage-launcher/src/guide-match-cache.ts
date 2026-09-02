import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"

import type { GuideModelRouting } from "./guide-model-routing.js"
import type { GuideModelPrompts } from "./guide-prompts.js"
import type {
  GuideGenerateCandidate,
  GuideGenerateResult,
  GuideMatchResult,
  GuideRefineResult,
} from "./guide-provider.js"
import { validateGuideGenerateResult, validateGuideMatchResult, validateGuideRefineResult } from "./guide-provider.js"

const maximumArtifactBytes = 256 * 1024
const maximumOptimizationSkillBytes = 1024 * 1024
const artifactHeader = /^<!-- trx-guide-artifact:v1:([A-Za-z0-9_-]+) -->$/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")
const keyFor = (value: unknown): string => sha256(JSON.stringify(value))

export const guidePromptSlug = (intent: string): string => {
  const ascii = intent
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
  const words = ascii.match(/[a-z0-9]+/gu) ?? []
  const joined = words.join("-").slice(0, 7).replace(/-+$/u, "")
  return joined.length > 0 ? joined : sha256(intent).slice(0, 7)
}

const filenameSlug = (value: string, fallback: string): string => {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
  return (normalized.length > 0 ? normalized : fallback).slice(0, 48).replace(/-+$/u, "")
}

type ArtifactKind = "match" | "generation" | "refinement"

interface ArtifactEnvelope {
  readonly schemaVersion: 1
  readonly kind: ArtifactKind
  readonly key: string
  readonly result: unknown
}

interface ArtifactSpec<Result> {
  readonly kind: ArtifactKind
  readonly intent: string
  readonly key: string
  readonly filename: string
  readonly render: (result: Result) => string
  readonly validate: (value: unknown) => Result
}

export interface GuideArtifactCacheOptions {
  readonly cwd: string
  readonly routing: GuideModelRouting
  readonly prompts: GuideModelPrompts
  readonly promptMasterSkillDirectory?: string
  readonly onWarning?: (message: string) => void
}

interface MatchCacheInput {
  readonly intent: string
  readonly entries: ReadonlyArray<{
    readonly ref: string
    readonly guide: { readonly workflows: ReadonlyArray<{ readonly id: string }> }
  }>
}

interface GenerationCacheInput {
  readonly intent: string
  readonly profileRef: string
  readonly workflowId: string
  readonly guide: unknown
  readonly guideBody: string
  readonly targetTool: string
  readonly fixedFrame?: unknown
}

interface RefinementCacheInput extends GenerationCacheInput {
  readonly candidates: ReadonlyArray<GuideGenerateCandidate>
  readonly candidateIndex: number
  readonly feedback: string
}

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT"

const requireDirectory = (metadata: Awaited<ReturnType<typeof lstat>>, directory: string): void => {
  if (!metadata.isDirectory()) throw new Error(`guide artifact root is not a directory: ${directory}`)
}

const removeTemporary = async (temporaryPath: string): Promise<void> => {
  try {
    await unlink(temporaryPath)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

const readBoundedRegularFile = async (filePath: string, maximumBytes: number, label: string): Promise<string> => {
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new Error(`${label} is not a regular file`, { cause: error })
    }
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error(`${label} is not a regular file`)
    if (metadata.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`)
    const chunks: Buffer[] = []
    let position = 0
    while (position <= maximumBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - position))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      chunks.push(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    if (position > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`)
    return Buffer.concat(chunks, position).toString("utf8")
  } finally {
    await handle.close()
  }
}

const parseArtifactEnvelope = (source: string, expectedKind: ArtifactKind): ArtifactEnvelope => {
  const firstLine = source.split("\n", 1)[0] ?? ""
  const encoded = artifactHeader.exec(firstLine)?.[1]
  if (encoded === undefined) throw new Error("artifact has a malformed machine header")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
  } catch (cause) {
    throw new Error("artifact has a malformed machine header", { cause })
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("artifact schema is invalid")
  }
  const fields = parsed as Record<string, unknown>
  const exactShape = Object.keys(fields).sort().join(",") === "key,kind,result,schemaVersion"
  if (!exactShape || fields.schemaVersion !== 1 || fields.kind !== expectedKind || typeof fields.key !== "string") {
    throw new Error("artifact schema is invalid")
  }
  return fields as unknown as ArtifactEnvelope
}

const renderMatch = (intent: string, routing: GuideModelRouting, result: GuideMatchResult): string =>
  [
    "# Profile recommendations",
    "",
    `Intent: ${intent}`,
    `Routing: ${routing.match.model} (${routing.match.effort})`,
    "",
    ...result.candidates.flatMap((candidate, index) => [
      `## ${index + 1}. ${candidate.profileRef} · ${candidate.workflowId}`,
      "",
      `Confidence: ${candidate.confidence}`,
      "",
      candidate.reason,
      "",
      `Tradeoff: ${candidate.tradeoff}`,
      "",
    ]),
  ].join("\n")

const renderCandidates = (
  heading: string,
  input: GenerationCacheInput,
  routing: string,
  result: GuideGenerateResult,
  feedback?: string,
): string =>
  [
    `# ${heading}`,
    "",
    `Intent: ${input.intent}`,
    `Profile: ${input.profileRef}`,
    `Workflow: ${input.workflowId}`,
    `Target tool: ${input.targetTool}`,
    `Routing: ${routing}`,
    ...(feedback === undefined ? [] : [`Feedback: ${feedback}`]),
    "",
    ...result.candidates.flatMap((candidate, index) => [
      `## ${index + 1}. ${candidate.title}`,
      "",
      candidate.prompt,
      "",
      `Notes: ${candidate.notes}`,
      "",
    ]),
  ].join("\n")

export class GuideArtifactCache {
  private readonly root: string
  private readonly activeSessions = new Map<string, string>()

  constructor(private readonly options: GuideArtifactCacheOptions) {
    this.root = path.join(path.resolve(options.cwd), ".trx-guide")
  }

  private warn(message: string): void {
    if (this.options.onWarning !== undefined) this.options.onWarning(message)
    else process.stderr.write(`trellage-launcher: warning: ${message}\n`)
  }

  private async ensureRootDirectory(create: boolean): Promise<boolean> {
    try {
      const metadata = await lstat(this.root)
      requireDirectory(metadata, this.root)
      return true
    } catch (error) {
      if (!isMissing(error)) throw error
      if (!create) return false
      try {
        await mkdir(this.root, { mode: 0o700 })
      } catch (mkdirError) {
        if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError
      }
      const metadata = await lstat(this.root)
      requireDirectory(metadata, this.root)
      return true
    }
  }

  private async sessionDirectories(intent: string): Promise<ReadonlyArray<string>> {
    const slug = guidePromptSlug(intent)
    let entries
    try {
      if (!(await this.ensureRootDirectory(false))) return []
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return []
      this.warn(`could not inspect guide artifacts: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    const directories: string[] = []
    for (const entry of entries) {
      if (!entry.name.startsWith(`${slug}-`)) continue
      const uuid = entry.name.slice(slug.length + 1)
      if (!uuidPattern.test(uuid)) continue
      const candidate = path.join(this.root, entry.name)
      if (!entry.isDirectory()) {
        this.warn(`ignoring unsafe guide artifact session that is not a directory: ${candidate}`)
        continue
      }
      directories.push(candidate)
    }
    return directories
  }

  private async readArtifact<Result>(artifactPath: string, spec: ArtifactSpec<Result>): Promise<Result | undefined> {
    try {
      const source = await readBoundedRegularFile(artifactPath, maximumArtifactBytes, "artifact")
      const envelope = parseArtifactEnvelope(source, spec.kind)
      return envelope.key === spec.key ? spec.validate(envelope.result) : undefined
    } catch (error) {
      if (isMissing(error)) return undefined
      this.warn(
        `ignoring unreadable guide artifact ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
  }

  private async newest<Result>(spec: ArtifactSpec<Result>): Promise<Result | undefined> {
    const matches: Array<{ readonly directory: string; readonly modified: number }> = []
    for (const directory of await this.sessionDirectories(spec.intent)) {
      const artifactPath = path.join(directory, spec.filename)
      try {
        const metadata = await lstat(artifactPath)
        matches.push({ directory, modified: metadata.mtimeMs })
      } catch (error) {
        if (!isMissing(error)) this.warn(`could not inspect guide artifact ${artifactPath}: ${String(error)}`)
      }
    }
    matches.sort((left, right) => right.modified - left.modified)
    for (const match of matches) {
      const result = await this.readArtifact(path.join(match.directory, spec.filename), spec)
      if (result !== undefined) {
        this.activeSessions.set(spec.intent, match.directory)
        return result
      }
    }
    return undefined
  }

  private async createSessionDirectory(intent: string): Promise<string> {
    const slug = guidePromptSlug(intent)
    const directory = path.join(this.root, `${slug}-${randomUUID()}`)
    await this.ensureRootDirectory(true)
    await mkdir(directory, { mode: 0o700 })
    this.activeSessions.set(intent, directory)
    return directory
  }

  private async sessionDirectory(intent: string): Promise<string> {
    return this.activeSessions.get(intent) ?? this.createSessionDirectory(intent)
  }

  private async writableDirectory<Result>(spec: ArtifactSpec<Result>): Promise<string> {
    const directory = await this.sessionDirectory(spec.intent)
    try {
      await lstat(path.join(directory, spec.filename))
      return this.createSessionDirectory(spec.intent)
    } catch (error) {
      if (isMissing(error)) return directory
      throw error
    }
  }

  private async writeArtifact<Result>(spec: ArtifactSpec<Result>, result: Result): Promise<void> {
    try {
      const directory = await this.writableDirectory(spec)
      const artifactPath = path.join(directory, spec.filename)
      const temporaryPath = `${artifactPath}.${process.pid}.${randomUUID()}.tmp`
      const envelope: ArtifactEnvelope = { schemaVersion: 1, kind: spec.kind, key: spec.key, result }
      const source = `<!-- trx-guide-artifact:v1:${Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url")} -->\n\n${spec.render(result).trim()}\n`
      if (Buffer.byteLength(source, "utf8") > maximumArtifactBytes)
        throw new Error(`artifact exceeds ${maximumArtifactBytes} bytes`)
      try {
        await writeFile(temporaryPath, source, { encoding: "utf8", flag: "wx", mode: 0o600 })
        await rename(temporaryPath, artifactPath)
      } catch (error) {
        await removeTemporary(temporaryPath)
        throw error
      }
    } catch (error) {
      this.warn(`could not write guide artifact: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async cached<Result>(spec: ArtifactSpec<Result>, produce: () => Promise<Result>): Promise<Result> {
    const existing = await this.newest(spec)
    if (existing !== undefined) return existing
    const result = await produce()
    await this.writeArtifact(spec, result)
    return result
  }

  private async optimizationSkillDigest(): Promise<string | null> {
    const directory = this.options.promptMasterSkillDirectory
    if (directory === undefined) return null
    const source = await readBoundedRegularFile(
      path.join(directory, "SKILL.md"),
      maximumOptimizationSkillBytes,
      "Prompt Master SKILL.md",
    )
    return sha256(source)
  }

  match(input: MatchCacheInput, produce: () => Promise<GuideMatchResult>): Promise<GuideMatchResult> {
    const key = keyFor({
      schemaVersion: 1,
      intent: input.intent,
      catalog: input.entries,
      prompt: this.options.prompts.match,
      routing: this.options.routing.match,
    })
    const workflows = new Map(
      input.entries.map((entry) => [entry.ref, new Set(entry.guide.workflows.map(({ id }) => id))]),
    )
    return this.cached(
      {
        kind: "match",
        intent: input.intent,
        key,
        filename: "1-profile-recommendations.md",
        render: (result) => renderMatch(input.intent, this.options.routing, result),
        validate: (value) => validateGuideMatchResult(value, workflows),
      },
      produce,
    )
  }

  async generation(
    input: GenerationCacheInput,
    produce: () => Promise<GuideGenerateResult>,
  ): Promise<GuideGenerateResult> {
    const key = keyFor({
      schemaVersion: 1,
      intent: input.intent,
      profileRef: input.profileRef,
      workflowId: input.workflowId,
      guide: input.guide,
      guideBody: input.guideBody,
      generationPrompt: this.options.prompts.generate,
      generationRouting: this.options.routing.generate,
      optimizationPrompt: this.options.prompts.optimize,
      optimizationRouting: this.options.routing.optimize,
      optimizationSkillDigest: await this.optimizationSkillDigest(),
      targetTool: input.targetTool,
      fixedFrame: input.fixedFrame ?? null,
    })
    const label = filenameSlug(`${input.profileRef}-${input.workflowId}`, "profile-workflow")
    return await this.cached(
      {
        kind: "generation",
        intent: input.intent,
        key,
        filename: `2-prompt-candidates-${label}-${key.slice(0, 7)}.md`,
        render: (result) =>
          renderCandidates(
            "Prompt candidates",
            input,
            `${this.options.routing.generate.model} (${this.options.routing.generate.effort}) → ${this.options.routing.optimize.model} (${this.options.routing.optimize.effort})`,
            result,
          ),
        validate: validateGuideGenerateResult,
      },
      produce,
    )
  }

  async refinement(input: RefinementCacheInput, produce: () => Promise<GuideRefineResult>): Promise<GuideRefineResult> {
    const key = keyFor({
      schemaVersion: 1,
      intent: input.intent,
      profileRef: input.profileRef,
      workflowId: input.workflowId,
      candidates: input.candidates,
      candidateIndex: input.candidateIndex,
      feedback: input.feedback,
      guide: input.guide,
      guideBody: input.guideBody,
      refinementPrompt: this.options.prompts.refine,
      refinementRouting: this.options.routing.refine,
      optimizationPrompt: this.options.prompts.optimize,
      optimizationRouting: this.options.routing.optimize,
      optimizationSkillDigest: await this.optimizationSkillDigest(),
      targetTool: input.targetTool,
      fixedFrame: input.fixedFrame ?? null,
    })
    const feedback = filenameSlug(input.feedback, sha256(input.feedback).slice(0, 7))
    return await this.cached(
      {
        kind: "refinement",
        intent: input.intent,
        key,
        filename: `2-refinement-${input.candidateIndex + 1}-${feedback}-${key.slice(0, 7)}.md`,
        render: (result) =>
          renderCandidates(
            "Refined prompt candidate",
            input,
            `${this.options.routing.refine.model} (${this.options.routing.refine.effort}) → ${this.options.routing.optimize.model} (${this.options.routing.optimize.effort})`,
            { candidates: [result.candidate] },
            input.feedback,
          ),
        validate: validateGuideRefineResult,
      },
      produce,
    )
  }
}
