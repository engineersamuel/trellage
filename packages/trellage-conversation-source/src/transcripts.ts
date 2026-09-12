import { constants, type Dirent } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"

import {
  claudeSessionMetadata,
  codexSessionMetadata,
  copilotWorkspaceCwd,
  extractTranscriptFinalMessage,
  extractTranscriptConversation,
  type TranscriptMetadata,
} from "./transcript-format.ts"
import { trellageSessionIdentity } from "./trellage-session.ts"
import { assertNoConversationSymlinks } from "./conversation-reader.ts"
import { errorMessage, hasErrorCode, isRecord, type JsonRecord } from "./records.ts"
import { ConversationSurface } from "@trellage/guide-core/conversation"

export interface TranscriptLookupOptions {
  readonly agent: string
  readonly cwd: string
  readonly agentSession?: unknown
  readonly processInfo?: unknown
  readonly tokens?: unknown
  readonly env?: NodeJS.ProcessEnv | undefined
}

interface TranscriptCandidate extends TranscriptMetadata {
  readonly agent: string
  readonly path: string
  readonly mtimeMs: number
}

export interface TranscriptMatch extends TranscriptCandidate {
  readonly identitySource: string
  readonly profile?: string | undefined
}

export interface FocusedTranscript extends TranscriptMatch {
  readonly roots: ReadonlyArray<string>
}

interface WalkDirectory {
  readonly directory: string
  readonly depth: number
}

interface WalkState {
  readonly files: string[]
  readonly pending: WalkDirectory[]
  visitedEntries: number
}

interface ExactSessionIdentifiers {
  readonly agentSessionId: string | undefined
  readonly processSessionId: string | undefined
  readonly nativeSessionId: string | undefined
}

const maximumRoots = 80
const maximumCandidates = 512
const maximumWalkEntries = 10_000
const maximumHeadBytes = 64 * 1024
const maximumTailBytes = 8 * 1024 * 1024
const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const supportedAgents = new Set(["copilot", "codex", "claude"])

const isInside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

const safeDirectory = async (directory: string) => {
  try {
    const stat = await lstat(directory)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false
    throw error
  }
}

const addDirectory = async (roots: string[], directory: string) => {
  if (roots.length >= maximumRoots || !path.isAbsolute(directory) || !(await safeDirectory(directory))) return
  const canonical = await realpath(directory)
  if (!roots.includes(canonical)) roots.push(canonical)
}

const addProfileHomes = async (roots: string[], familyRoot: string) => {
  if (!(await safeDirectory(familyRoot))) return
  const entries = (await readdir(familyRoot, { withFileTypes: true })).slice(0, maximumRoots)
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    await addDirectory(roots, path.join(familyRoot, entry.name, "home"))
  }
}

const agentConfigDirectory = (agent: string) =>
  agent === "copilot" ? ".copilot" : agent === "codex" ? ".codex" : ".claude"

const homeDirectory = (env: NodeJS.ProcessEnv) =>
  typeof env.HOME === "string" && path.isAbsolute(env.HOME) ? env.HOME : undefined

const nativeTranscriptRoots = async (agent: string, home: string, profile: string) => {
  const roots: string[] = []
  await addDirectory(
    roots,
    path.join(
      home,
      ".local",
      "share",
      "trellage",
      "profiles",
      agent,
      profile,
      "home",
    ),
  )
  return roots
}

const defaultTranscriptRoots = async (agent: string, env: NodeJS.ProcessEnv, home: string | undefined) => {
  const roots: string[] = []
  const explicit =
    agent === "copilot" ? env.COPILOT_HOME : agent === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR
  if (typeof explicit === "string") await addDirectory(roots, explicit)
  if (home !== undefined) {
    await addDirectory(roots, path.join(home, agentConfigDirectory(agent)))
    await addProfileHomes(roots, path.join(home, ".local", "share", "trellage", "profiles", agent))
  }
  return roots
}

export const transcriptRoots = async (agent: string, env = process.env, nativeProfile?: string) => {
  if (!supportedAgents.has(agent)) return []
  const home = homeDirectory(env)
  if (nativeProfile !== undefined) {
    return home === undefined ? [] : nativeTranscriptRoots(agent, home, nativeProfile)
  }
  return defaultTranscriptRoots(agent, env, home)
}

const openSafeFile = async (filePath: string, roots: ReadonlyArray<string>) => {
  const fileStat = await lstat(filePath)
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("Transcript path is not a regular file")
  const canonical = await realpath(filePath)
  if (!roots.some((root) => isInside(root, canonical))) {
    throw new Error("Transcript path resolves outside the allowed session roots")
  }
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW)
  const stat = await handle.stat()
  if (!stat.isFile()) {
    await handle.close()
    throw new Error("Transcript path is not a regular file")
  }
  return { handle, stat, canonical }
}

const readHead = async (filePath: string, roots: ReadonlyArray<string>, maximum = maximumHeadBytes) => {
  const { handle, stat } = await openSafeFile(filePath, roots)
  try {
    const length = Math.min(stat.size, maximum)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }
}

const readTail = async (filePath: string, roots: ReadonlyArray<string>, maximum = maximumTailBytes) => {
  const { handle, stat } = await openSafeFile(filePath, roots)
  try {
    const length = Math.min(stat.size, maximum)
    const start = stat.size - length
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    let source = buffer.subarray(0, bytesRead).toString("utf8")
    if (start > 0) {
      const newline = source.indexOf("\n")
      source = newline < 0 ? "" : source.slice(newline + 1)
    }
    return source
  } finally {
    await handle.close()
  }
}

const visitWalkEntry = (
  state: WalkState, current: WalkDirectory, entry: Dirent,
  maximumDepth: number, matchesName: (name: string) => boolean,
) => {
  state.visitedEntries += 1
  if (entry.isSymbolicLink()) return
  const entryPath = path.join(current.directory, entry.name)
  if (entry.isFile() && entry.name.endsWith(".jsonl") && matchesName(entry.name)) {
    state.files.push(entryPath)
    return
  }
  if (entry.isDirectory() && current.depth < maximumDepth) {
    state.pending.push({ directory: entryPath, depth: current.depth + 1 })
  }
}

const walkBudgetAvailable = (state: WalkState) =>
  state.files.length < maximumCandidates && state.visitedEntries < maximumWalkEntries

const walkCanContinue = (state: WalkState) => state.pending.length > 0 && walkBudgetAvailable(state)

const walkJsonl = async (
  root: string,
  maximumDepth: number,
  matchesName: (name: string) => boolean = () => true,
  strict = false,
) => {
  if (!(await safeDirectory(root))) return []
  const state: WalkState = { files: [], pending: [{ directory: root, depth: 0 }], visitedEntries: 0 }
  while (walkCanContinue(state)) {
    const current = state.pending.shift()
    if (current === undefined) break
    const entries = (await readdir(current.directory, { withFileTypes: true })).sort((left, right) =>
      right.name.localeCompare(left.name),
    )
    for (const entry of entries) {
      if (!walkBudgetAvailable(state)) break
      visitWalkEntry(state, current, entry, maximumDepth, matchesName)
    }
  }
  if (strict && !walkBudgetAvailable(state)) {
    throw new Error("Exact transcript lookup exceeded its bounded search budget.")
  }
  return state.files
}

const candidate = async (
  agent: string, filePath: string, roots: ReadonlyArray<string>, metadata: TranscriptMetadata,
): Promise<TranscriptCandidate> => {
  const { stat, canonical, handle } = await openSafeFile(filePath, roots)
  await handle.close()
  return { agent, path: canonical, mtimeMs: stat.mtimeMs, id: metadata.id, cwd: metadata.cwd }
}

const scanCopilot = async (root: string, roots: ReadonlyArray<string>, sessionId: string | undefined, focused = false) => {
  const sessionRoot = path.join(root, "session-state")
  if (!(await safeDirectory(sessionRoot))) return []
  const sessionIds =
    sessionId === undefined
      ? (await readdir(sessionRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .slice(0, maximumCandidates)
          .map((entry) => entry.name)
      : [sessionId]
  const candidates: TranscriptCandidate[] = []
  for (const id of sessionIds) {
    if (!safeSessionId.test(id)) continue
    const directory = path.join(sessionRoot, id)
    const eventsPath = path.join(directory, "events.jsonl")
    const workspacePath = path.join(directory, "workspace.yaml")
    try {
      const cwd = copilotWorkspaceCwd(await readHead(workspacePath, roots))
      if (cwd === undefined) continue
      candidates.push(await candidate("copilot", eventsPath, roots, { id, cwd }))
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && focused) throw error
      if (!hasErrorCode(error, "ENOENT")) console.error(`Skipping Copilot session ${id}: ${errorMessage(error)}`)
    }
  }
  return candidates
}

const scanCodex = async (root: string, roots: ReadonlyArray<string>, sessionId: string | undefined, focused = false) => {
  const files = await walkJsonl(
    path.join(root, "sessions"),
    5,
    sessionId === undefined ? undefined : (name) => name.includes(sessionId),
    focused,
  )
  const candidates: TranscriptCandidate[] = []
  for (const filePath of files) {
    try {
      const metadata = codexSessionMetadata(await readHead(filePath, roots))
      if (metadata === undefined || !safeSessionId.test(metadata.id)) continue
      candidates.push(await candidate("codex", filePath, roots, metadata))
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && focused) throw error
      if (!hasErrorCode(error, "ENOENT")) console.error(`Skipping Codex transcript ${filePath}: ${errorMessage(error)}`)
    }
  }
  return candidates
}

const claudeMetadata = async (filePath: string, roots: ReadonlyArray<string>, focused: boolean) => {
  if (focused) {
    const head = claudeSessionMetadata(await readHead(filePath, roots))
    if (head !== undefined) return head
  }
  return claudeSessionMetadata(await readTail(filePath, roots, 512 * 1024))
}

const scanClaude = async (root: string, roots: ReadonlyArray<string>, sessionId: string | undefined, focused = false) => {
  const files = await walkJsonl(
    path.join(root, "projects"),
    3,
    sessionId === undefined ? undefined : (name) => name === `${sessionId}.jsonl`,
    focused,
  )
  const candidates: TranscriptCandidate[] = []
  for (const filePath of files) {
    try {
      const metadata = await claudeMetadata(filePath, roots, focused)
      if (metadata === undefined || !safeSessionId.test(metadata.id)) continue
      candidates.push(await candidate("claude", filePath, roots, metadata))
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && focused) throw error
      if (!hasErrorCode(error, "ENOENT")) console.error(`Skipping Claude transcript ${filePath}: ${errorMessage(error)}`)
    }
  }
  return candidates
}

const scanCandidates = async (
  agent: string, roots: ReadonlyArray<string>, sessionId: string | undefined, focused = false,
) => {
  const groups = await Promise.all(
    roots.map((root) =>
      agent === "copilot"
        ? scanCopilot(root, roots, sessionId, focused)
        : agent === "codex"
          ? scanCodex(root, roots, sessionId, focused)
          : scanClaude(root, roots, sessionId, focused),
    ),
  )
  const unique = new Map<string, TranscriptCandidate>()
  for (const item of groups.flat()) unique.set(item.path, item)
  return [...unique.values()]
}

const normalizedDirectory = (value: string) => path.resolve(value)

const selectCandidate = (candidates: TranscriptCandidate[], cwd: string, sessionId: string | undefined) => {
  let filtered = candidates
  if (sessionId !== undefined) filtered = filtered.filter((item) => item.id === sessionId)
  const cwdMatches = filtered.filter((item) => normalizedDirectory(item.cwd) === normalizedDirectory(cwd))
  if (cwdMatches.length === 1) return cwdMatches[0]
  if (cwdMatches.length > 1 || sessionId === undefined || filtered.length !== 1) return undefined
  return filtered[0]
}

const processMatchesAgent = (agent: string, process: JsonRecord, argv: ReadonlyArray<string>) => {
  const processName = typeof process.name === "string" ? process.name.toLowerCase() : ""
  const executable = path.basename(argv[0] ?? "").toLowerCase()
  return processName.includes(agent) || executable.includes(agent)
}

const sessionIdsFromArgv = (agent: string, argv: ReadonlyArray<string>) => {
  const ids: string[] = []
  for (let index = 0; index < argv.length - 1; index += 1) {
    const token = argv[index]
    const value = argv[index + 1]
    const isSessionFlag = token === "--session-id" || token === "--resume"
    const isCodexResume = agent === "codex" && token === "resume"
    if ((isSessionFlag || isCodexResume) && value !== undefined && safeSessionId.test(value)) ids.push(value)
  }
  return ids
}

export const sessionIdFromProcessInfo = (agent: string, processInfo: unknown) => {
  if (!isRecord(processInfo) || !Array.isArray(processInfo.foreground_processes)) return undefined
  const ids = new Set<string>()
  for (const process of processInfo.foreground_processes) {
    if (!isRecord(process) || !Array.isArray(process.argv)) continue
    const argv = process.argv.filter((value) => typeof value === "string")
    if (!processMatchesAgent(agent, process, argv)) continue
    for (const id of sessionIdsFromArgv(agent, argv)) ids.add(id)
  }
  return ids.size === 1 ? [...ids][0] : undefined
}

export const exactSessionIdFromProcessInfo = (agent: string, processInfo: unknown) => {
  if (!isRecord(processInfo) || !Array.isArray(processInfo.foreground_processes)) return undefined
  const ids = new Set<string>()
  for (const process of processInfo.foreground_processes) {
    if (!isRecord(process) || !Array.isArray(process.argv)) continue
    const argv = process.argv.filter((value) => typeof value === "string")
    if (!processMatchesAgent(agent, process, argv)) continue
    for (const id of sessionIdsFromArgv(agent, argv)) ids.add(id)
  }
  if (ids.size > 1) throw new Error("Conflicting exact process session identities were reported.")
  return [...ids][0]
}

const candidateFromExactPath = async (
  agent: string, value: string, roots: ReadonlyArray<string>, focused = false,
) => {
  if (!path.isAbsolute(value) || !value.endsWith(".jsonl")) return undefined
  try {
    const metadata =
      agent === "copilot"
        ? {
            id: path.basename(path.dirname(value)),
            cwd: copilotWorkspaceCwd(await readHead(path.join(path.dirname(value), "workspace.yaml"), roots)),
          }
        : agent === "codex"
          ? codexSessionMetadata(await readHead(value, roots))
          : await claudeMetadata(value, roots, focused)
    if (metadata?.cwd === undefined) return undefined
    return candidate(agent, value, roots, { id: metadata.id, cwd: metadata.cwd })
  } catch (error) {
    if (focused) throw error
    console.error(`Skipping exact ${agent} transcript ${value}: ${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

const exactPathSession = async (
  agent: string, agentSession: unknown, roots: ReadonlyArray<string>, focused = false,
) => {
  if (
    !isRecord(agentSession) ||
    agentSession.agent !== agent ||
    agentSession.kind !== "path" ||
    typeof agentSession.value !== "string"
  ) {
    return undefined
  }
  return candidateFromExactPath(agent, agentSession.value, roots, focused)
}

export const sessionIdFromAgentSession = (agent: string, agentSession: unknown) => {
  if (
    !isRecord(agentSession) ||
    agentSession.agent !== agent ||
    agentSession.kind !== "id" ||
    typeof agentSession.value !== "string" ||
    !safeSessionId.test(agentSession.value)
  ) {
    return undefined
  }
  return agentSession.value
}

const exactSessionIdentity = ({ agentSessionId, processSessionId, nativeSessionId }: ExactSessionIdentifiers) => {
  const exactIds = new Set(
    [agentSessionId, processSessionId, nativeSessionId].filter((value) => value !== undefined),
  )
  if (exactIds.size > 1) throw new Error("Conflicting exact session identities were reported")
  return [...exactIds][0]
}

const exactIdentitySource = ({ agentSessionId, processSessionId, nativeSessionId }: ExactSessionIdentifiers) => {
  if (nativeSessionId !== undefined) {
    return agentSessionId !== undefined || processSessionId !== undefined
      ? "matching-trellage-and-harness-session-id"
      : "trellage-native-metadata"
  }
  return agentSessionId !== undefined ? "herdr-session-id" : "process-session-id"
}

const exactPathTranscript = (
  exactPath: TranscriptCandidate | undefined, exactId: string | undefined, nativeProfile: string | undefined,
): TranscriptMatch | undefined => {
  if (exactPath === undefined) return undefined
  if (exactId !== undefined && exactPath.id !== exactId) {
    throw new Error("The exact transcript path conflicts with the reported session identity")
  }
  return { ...exactPath, identitySource: "herdr-session-path", profile: nativeProfile }
}

export const findTranscript = async (
  { agent, cwd, agentSession, processInfo, tokens, env = process.env }: TranscriptLookupOptions,
): Promise<TranscriptMatch | undefined> => {
  if (!supportedAgents.has(agent)) return undefined
  const trellageIdentity = trellageSessionIdentity({ agent, tokens, processInfo })
  if (trellageIdentity?.surface === ConversationSurface.Sandbox) return undefined
  const nativeProfile = trellageIdentity?.surface === ConversationSurface.Native ? trellageIdentity.profile : undefined
  const roots = await transcriptRoots(agent, env, nativeProfile)
  if (roots.length === 0) return undefined
  const exactPath = await exactPathSession(agent, agentSession, roots, false)
  const agentSessionId = sessionIdFromAgentSession(agent, agentSession)
  const processSessionId = sessionIdFromProcessInfo(agent, processInfo)
  const nativeSessionId =
    trellageIdentity?.surface === ConversationSurface.Native ? trellageIdentity.sessionId : undefined
  const exactId = exactSessionIdentity({ agentSessionId, processSessionId, nativeSessionId })
  const pathTranscript = exactPathTranscript(exactPath, exactId, nativeProfile)
  if (pathTranscript !== undefined || exactId === undefined) return pathTranscript
  const exact = selectCandidate(await scanCandidates(agent, roots, exactId), cwd, exactId)
  if (exact === undefined) return undefined
  return {
    ...exact,
    identitySource: exactIdentitySource({ agentSessionId, processSessionId, nativeSessionId }),
    profile: nativeProfile,
  }
}

const focusedHomePaths = (agent: string, env: NodeJS.ProcessEnv, nativeProfile: string | undefined) => {
  const home = homeDirectory(env)
  if (nativeProfile !== undefined) {
    return home === undefined ? [] : [
      path.join(home, ".local", "share", "trellage", "profiles", agent, nativeProfile, "home"),
    ]
  }
  const explicit = agent === "copilot"
    ? env.COPILOT_HOME
    : agent === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR
  return [
    ...(typeof explicit === "string" ? [explicit] : []),
    ...(home === undefined ? [] : [path.join(home, agentConfigDirectory(agent))]),
  ]
}

export const focusedTranscriptRoots = async (agent: string, env = process.env, nativeProfile?: string) => {
  if (!supportedAgents.has(agent)) return []
  const roots: string[] = []
  for (const directory of focusedHomePaths(agent, env, nativeProfile)) {
    if (!path.isAbsolute(directory)) throw new Error("The focused harness home must be an absolute path.")
    try {
      await assertNoConversationSymlinks(directory)
      await addDirectory(roots, directory)
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error
    }
  }
  return roots
}

const checkedFocusedReference = (agent: string, agentSession: unknown) => {
  if (agentSession !== undefined && (
    !isRecord(agentSession) || agentSession.agent !== agent ||
    (agentSession.kind !== "id" && agentSession.kind !== "path") || typeof agentSession.value !== "string"
  )) throw new Error("The focused harness session reference is invalid.")
  const agentSessionId = sessionIdFromAgentSession(agent, agentSession)
  if (isRecord(agentSession) && agentSession.kind === "id" && agentSessionId === undefined) {
    throw new Error("The focused harness session ID is invalid.")
  }
  return agentSessionId
}

const focusedCandidate = async (
  agent: string, agentSession: unknown, roots: ReadonlyArray<string>, exactId: string | undefined,
  nativeProfile: string | undefined, identitySource: string,
): Promise<TranscriptMatch> => {
  if (isRecord(agentSession) && agentSession.kind === "path" && typeof agentSession.value === "string") {
    await assertNoConversationSymlinks(agentSession.value)
    const exactPath = await exactPathSession(agent, agentSession, roots, true)
    const transcript = exactPathTranscript(exactPath, exactId, nativeProfile)
    if (transcript === undefined) throw new Error("The exact focused transcript is unavailable.")
    return transcript
  }
  if (exactId === undefined) throw new Error("The focused pane has no exact session identity.")
  const candidates = (await scanCandidates(agent, roots, exactId, true)).filter((item) => item.id === exactId)
  const first = candidates[0]
  if (candidates.length !== 1 || first === undefined) {
    throw new Error(candidates.length === 0
      ? "The exact focused transcript is unavailable."
      : "The focused session has more than one transcript; capture is ambiguous.")
  }
  return { ...first, identitySource, profile: nativeProfile }
}

export const findFocusedTranscript = async ({
  agent, cwd, agentSession, processInfo, tokens, env = process.env,
}: TranscriptLookupOptions): Promise<FocusedTranscript> => {
  if (!supportedAgents.has(agent)) throw new Error("The focused harness does not support conversation analysis.")
  const identity = trellageSessionIdentity({ agent, tokens, processInfo })
  if (identity?.surface === ConversationSurface.Sandbox) throw new Error("Sandbox conversations require the validated session bridge.")
  const nativeProfile = identity?.surface === ConversationSurface.Native ? identity.profile : undefined
  const identifiers = {
    agentSessionId: checkedFocusedReference(agent, agentSession),
    processSessionId: exactSessionIdFromProcessInfo(agent, processInfo),
    nativeSessionId: identity?.surface === ConversationSurface.Native ? identity.sessionId : undefined,
  }
  const sessionId = exactSessionIdentity(identifiers)
  const roots = await focusedTranscriptRoots(agent, env, nativeProfile)
  if (roots.length === 0) throw new Error("The focused harness has no supported session root.")
  const transcript = await focusedCandidate(
    agent, agentSession, roots, sessionId, nativeProfile,
    exactIdentitySource(identifiers),
  )
  if (!safeSessionId.test(transcript.id) ||
    normalizedDirectory(transcript.cwd) !== normalizedDirectory(cwd)) {
    throw new Error("The focused transcript does not match the source working directory or session.")
  }
  await assertNoConversationSymlinks(transcript.path)
  return { ...transcript, roots }
}

export const captureStructuredFinalMessage = async (options: TranscriptLookupOptions) => {
  const transcript = await findTranscript(options)
  if (transcript === undefined) return undefined
  const roots = await transcriptRoots(options.agent, options.env, transcript.profile)
  const text = extractTranscriptFinalMessage(options.agent, await readTail(transcript.path, roots))
  return text === undefined
    ? undefined
    : {
        text,
        agent: options.agent,
        sessionId: transcript.id,
        transcriptPath: transcript.path,
        identitySource: transcript.identitySource,
        profile: transcript.profile,
      }
}

const exactTranscriptUnavailable = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:no exact session identity|focused harness has no supported session root|focused harness does not support)/iu.test(message)
}

/**
 * Reads the completed focused transcript with strict path and identity checks.
 */
export const captureStrictStructuredFinalMessage = async (options: TranscriptLookupOptions) => {
  let transcript
  try {
    transcript = await findFocusedTranscript(options)
  } catch (error) {
    if (exactTranscriptUnavailable(error)) return undefined
    throw error
  }
  const text = extractTranscriptFinalMessage(options.agent, await readTail(transcript.path, transcript.roots))
  return text === undefined
    ? undefined
    : {
        text,
        agent: options.agent,
        sessionId: transcript.id,
        transcriptPath: transcript.path,
        identitySource: transcript.identitySource,
        profile: transcript.profile,
      }
}

export const captureStructuredConversation = async (options: TranscriptLookupOptions) => {
  const transcript = await findTranscript(options)
  if (transcript === undefined) return undefined
  const roots = await transcriptRoots(options.agent, options.env, transcript.profile)
  const messages = extractTranscriptConversation(options.agent, await readTail(transcript.path, roots))
  if (messages.length === 0) return undefined
  return {
    messages,
    agent: options.agent,
    sessionId: transcript.id,
    transcriptPath: transcript.path,
    identitySource: transcript.identitySource,
    profile: transcript.profile,
  }
}
