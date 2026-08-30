import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"

import {
  claudeSessionMetadata,
  codexSessionMetadata,
  copilotWorkspaceCwd,
  extractTranscriptFinalMessage,
} from "./transcript-format.mjs"
import { trellageSessionIdentity } from "./trellage-session.mjs"

const maximumRoots = 80
const maximumCandidates = 512
const maximumWalkEntries = 10_000
const maximumHeadBytes = 64 * 1024
const maximumTailBytes = 8 * 1024 * 1024
const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const supportedAgents = new Set(["copilot", "codex", "claude"])

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const isInside = (root, target) => {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

const safeDirectory = async (directory) => {
  try {
    const stat = await lstat(directory)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

const addDirectory = async (roots, directory) => {
  if (roots.length >= maximumRoots || !path.isAbsolute(directory) || !(await safeDirectory(directory))) return
  const canonical = await realpath(directory)
  if (!roots.includes(canonical)) roots.push(canonical)
}

const addProfileHomes = async (roots, familyRoot) => {
  if (!(await safeDirectory(familyRoot))) return
  const entries = (await readdir(familyRoot, { withFileTypes: true })).slice(0, maximumRoots)
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    await addDirectory(roots, path.join(familyRoot, entry.name, "home"))
  }
}

const agentConfigDirectory = (agent) =>
  agent === "copilot" ? ".copilot" : agent === "codex" ? ".codex" : ".claude"

const homeDirectory = (env) =>
  typeof env.HOME === "string" && path.isAbsolute(env.HOME) ? env.HOME : undefined

const nativeTranscriptRoots = async (agent, home, profile) => {
  const roots = []
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

const defaultTranscriptRoots = async (agent, env, home) => {
  const roots = []
  const explicit =
    agent === "copilot" ? env.COPILOT_HOME : agent === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR
  if (typeof explicit === "string") await addDirectory(roots, explicit)
  if (home !== undefined) {
    await addDirectory(roots, path.join(home, agentConfigDirectory(agent)))
    await addProfileHomes(roots, path.join(home, ".local", "share", "trellage", "profiles", agent))
  }
  return roots
}

export const transcriptRoots = async (agent, env = process.env, nativeProfile) => {
  if (!supportedAgents.has(agent)) return []
  const home = homeDirectory(env)
  if (nativeProfile !== undefined) {
    return home === undefined ? [] : nativeTranscriptRoots(agent, home, nativeProfile)
  }
  return defaultTranscriptRoots(agent, env, home)
}

const openSafeFile = async (filePath, roots) => {
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

const readHead = async (filePath, roots, maximum = maximumHeadBytes) => {
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

const readTail = async (filePath, roots, maximum = maximumTailBytes) => {
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

const visitWalkEntry = (state, current, entry, maximumDepth, matchesName) => {
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

const walkBudgetAvailable = (state) =>
  state.files.length < maximumCandidates && state.visitedEntries < maximumWalkEntries

const walkCanContinue = (state) => state.pending.length > 0 && walkBudgetAvailable(state)

const walkJsonl = async (root, maximumDepth, matchesName = () => true) => {
  if (!(await safeDirectory(root))) return []
  const state = { files: [], pending: [{ directory: root, depth: 0 }], visitedEntries: 0 }
  while (walkCanContinue(state)) {
    const current = state.pending.shift()
    const entries = (await readdir(current.directory, { withFileTypes: true })).sort((left, right) =>
      right.name.localeCompare(left.name),
    )
    for (const entry of entries) {
      if (!walkBudgetAvailable(state)) break
      visitWalkEntry(state, current, entry, maximumDepth, matchesName)
    }
  }
  return state.files
}

const candidate = async (agent, filePath, roots, metadata) => {
  const { stat, canonical, handle } = await openSafeFile(filePath, roots)
  await handle.close()
  return { agent, path: canonical, mtimeMs: stat.mtimeMs, id: metadata.id, cwd: metadata.cwd }
}

const scanCopilot = async (root, roots, sessionId) => {
  const sessionRoot = path.join(root, "session-state")
  if (!(await safeDirectory(sessionRoot))) return []
  const sessionIds =
    sessionId === undefined
      ? (await readdir(sessionRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .slice(0, maximumCandidates)
          .map((entry) => entry.name)
      : [sessionId]
  const candidates = []
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
      if (error?.code !== "ENOENT") console.error(`Skipping Copilot session ${id}: ${error.message}`)
    }
  }
  return candidates
}

const scanCodex = async (root, roots, sessionId) => {
  const files = await walkJsonl(
    path.join(root, "sessions"),
    5,
    sessionId === undefined ? undefined : (name) => name.includes(sessionId),
  )
  const candidates = []
  for (const filePath of files) {
    try {
      const metadata = codexSessionMetadata(await readHead(filePath, roots))
      if (metadata === undefined || !safeSessionId.test(metadata.id)) continue
      candidates.push(await candidate("codex", filePath, roots, metadata))
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`Skipping Codex transcript ${filePath}: ${error.message}`)
    }
  }
  return candidates
}

const scanClaude = async (root, roots, sessionId) => {
  const files = await walkJsonl(
    path.join(root, "projects"),
    3,
    sessionId === undefined ? undefined : (name) => name === `${sessionId}.jsonl`,
  )
  const candidates = []
  for (const filePath of files) {
    try {
      const metadata = claudeSessionMetadata(await readTail(filePath, roots, 512 * 1024))
      if (metadata === undefined || !safeSessionId.test(metadata.id)) continue
      candidates.push(await candidate("claude", filePath, roots, metadata))
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`Skipping Claude transcript ${filePath}: ${error.message}`)
    }
  }
  return candidates
}

const scanCandidates = async (agent, roots, sessionId) => {
  const groups = await Promise.all(
    roots.map((root) =>
      agent === "copilot"
        ? scanCopilot(root, roots, sessionId)
        : agent === "codex"
          ? scanCodex(root, roots, sessionId)
          : scanClaude(root, roots, sessionId),
    ),
  )
  const unique = new Map()
  for (const item of groups.flat()) unique.set(item.path, item)
  return [...unique.values()]
}

const normalizedDirectory = (value) => path.resolve(value)

const selectCandidate = (candidates, cwd, sessionId) => {
  let filtered = candidates
  if (sessionId !== undefined) filtered = filtered.filter((item) => item.id === sessionId)
  const cwdMatches = filtered.filter((item) => normalizedDirectory(item.cwd) === normalizedDirectory(cwd))
  if (cwdMatches.length === 1) return cwdMatches[0]
  if (cwdMatches.length > 1 || sessionId === undefined || filtered.length !== 1) return undefined
  return filtered[0]
}

const processMatchesAgent = (agent, process, argv) => {
  const processName = typeof process.name === "string" ? process.name.toLowerCase() : ""
  const executable = path.basename(argv[0] ?? "").toLowerCase()
  return processName.includes(agent) || executable.includes(agent)
}

const sessionIdsFromArgv = (agent, argv) => {
  const ids = []
  for (let index = 0; index < argv.length - 1; index += 1) {
    const token = argv[index]
    const value = argv[index + 1]
    const isSessionFlag = token === "--session-id" || token === "--resume"
    const isCodexResume = agent === "codex" && token === "resume"
    if ((isSessionFlag || isCodexResume) && safeSessionId.test(value)) ids.push(value)
  }
  return ids
}

export const sessionIdFromProcessInfo = (agent, processInfo) => {
  if (!isRecord(processInfo) || !Array.isArray(processInfo.foreground_processes)) return undefined
  const ids = new Set()
  for (const process of processInfo.foreground_processes) {
    if (!isRecord(process) || !Array.isArray(process.argv)) continue
    const argv = process.argv.filter((value) => typeof value === "string")
    if (!processMatchesAgent(agent, process, argv)) continue
    for (const id of sessionIdsFromArgv(agent, argv)) ids.add(id)
  }
  return ids.size === 1 ? [...ids][0] : undefined
}

const candidateFromExactPath = async (agent, value, roots) => {
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
          : claudeSessionMetadata(await readTail(value, roots, 512 * 1024))
    if (metadata?.cwd === undefined) return undefined
    return candidate(agent, value, roots, metadata)
  } catch (error) {
    console.error(`Skipping exact ${agent} transcript ${value}: ${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

const exactPathSession = async (agent, agentSession, roots) => {
  if (
    !isRecord(agentSession) ||
    agentSession.agent !== agent ||
    agentSession.kind !== "path" ||
    typeof agentSession.value !== "string"
  ) {
    return undefined
  }
  return candidateFromExactPath(agent, agentSession.value, roots)
}

export const sessionIdFromAgentSession = (agent, agentSession) => {
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

const exactSessionIdentity = ({ agentSessionId, processSessionId, nativeSessionId }) => {
  const exactIds = new Set(
    [agentSessionId, processSessionId, nativeSessionId].filter((value) => value !== undefined),
  )
  if (exactIds.size > 1) throw new Error("Conflicting exact session identities were reported")
  return [...exactIds][0]
}

const exactIdentitySource = ({ agentSessionId, processSessionId, nativeSessionId }) => {
  if (nativeSessionId !== undefined) {
    return agentSessionId !== undefined || processSessionId !== undefined
      ? "matching-trellage-and-harness-session-id"
      : "trellage-native-metadata"
  }
  return agentSessionId !== undefined ? "herdr-session-id" : "process-session-id"
}

const exactPathTranscript = (exactPath, exactId, nativeProfile) => {
  if (exactPath === undefined) return undefined
  if (exactId !== undefined && exactPath.id !== exactId) {
    throw new Error("The exact transcript path conflicts with the reported session identity")
  }
  return { ...exactPath, identitySource: "herdr-session-path", profile: nativeProfile }
}

export const findTranscript = async ({ agent, cwd, agentSession, processInfo, tokens, env = process.env }) => {
  if (!supportedAgents.has(agent)) return undefined
  const trellageIdentity = trellageSessionIdentity({ agent, tokens, processInfo })
  if (trellageIdentity?.surface === "sandbox") return undefined
  const nativeProfile = trellageIdentity?.surface === "native" ? trellageIdentity.profile : undefined
  const roots = await transcriptRoots(agent, env, nativeProfile)
  if (roots.length === 0) return undefined
  const exactPath = await exactPathSession(agent, agentSession, roots)
  const agentSessionId = sessionIdFromAgentSession(agent, agentSession)
  const processSessionId = sessionIdFromProcessInfo(agent, processInfo)
  const nativeSessionId =
    trellageIdentity?.surface === "native" ? trellageIdentity.sessionId : undefined
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

export const captureStructuredFinalMessage = async (options) => {
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
