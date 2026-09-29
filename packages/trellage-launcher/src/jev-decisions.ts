import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { parseEnv } from "node:util"
import {
  TypeSafeClient,
  choice,
  noul,
  type NoulQuestion,
  type Questions,
  type RequestOptions,
  type SystemOneRequest,
} from "@typesafe-ai/sdk"

export interface JevSystemOneClient {
  systemOne(request: SystemOneRequest, options: RequestOptions): Promise<unknown>
}

export interface JevDecisionOptions {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly client?: JevSystemOneClient
  readonly clientFactory?: (apiKey: string) => JevSystemOneClient
  readonly timeoutMs?: number
}

export const jevModel = "jev-1.13.0"
export const jevTimeoutMs = 3_000

const loadClient = (apiKey: string): JevSystemOneClient =>
  new TypeSafeClient({
    apiKey,
    defaultModel: jevModel,
    retry: { maxRetries: 0 },
    timeout: jevTimeoutMs,
    logLevel: "off",
  })

// trx loads the optional key through Varlock under this private name. The
// launcher keeps it in memory so child agent processes do not inherit it.
export const jevPrivateApiKeyVariable = "_TRELLAGE_JEV_API_KEY"
let privateApiKey: string | undefined

export const adoptPrivateJevApiKey = (env: Record<string, string | undefined> = process.env): void => {
  const value = env[jevPrivateApiKeyVariable]
  delete env[jevPrivateApiKeyVariable]
  privateApiKey = value?.trim() ? value : undefined
}

type Environment = Readonly<Record<string, string | undefined>>

const fileKey = async (file: string, privateFile: boolean): Promise<string | undefined> => {
  try {
    if (privateFile) {
      const stats = await lstat(file)
      // Same guard as the Varlock user environment: private regular files only.
      if (!stats.isFile() || (stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.()) return undefined
    }
    const value = parseEnv(await readFile(file, "utf8")).TYPESAFE_API_KEY?.trim()
    // Varlock function values such as encrypted secrets need Varlock itself; skip them.
    return value && !/^[A-Za-z_]\w*\(/u.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Trellage user environment directory shared with Varlock-enabled launchers. */
export const userEnvironmentDirectory = (env: Environment): string | undefined => {
  if (env.TRELLAGE_ENVIRONMENT === "off") return undefined
  if (env.XDG_CONFIG_HOME?.trim()) return path.resolve(env.XDG_CONFIG_HOME, "trellage")
  return env.HOME?.trim() ? path.join(env.HOME, ".config", "trellage") : undefined
}

/** Resolve the Jev key: process env, worktree .env, trx Varlock handoff, then the user environment files. */
export const jevApiKey = async (cwd: string, env: Environment): Promise<string | undefined> => {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY
  const local = await fileKey(path.join(cwd, ".env"), false)
  if (local !== undefined) return local
  if (privateApiKey !== undefined) return privateApiKey
  const directory = userEnvironmentDirectory(env)
  if (directory === undefined) return undefined
  for (const name of [".env.local", ".env"]) {
    const value = await fileKey(path.join(directory, name), true)
    if (value !== undefined) return value
  }
  return undefined
}

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Jev decision response")
  }
  return value as Record<string, unknown>
}

const probability = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("Invalid Jev decision probability")
  }
  return value
}

export const resolveJevClient = async (options: JevDecisionOptions): Promise<JevSystemOneClient> => {
  if (options.client !== undefined) return options.client
  const apiKey = await jevApiKey(options.cwd, options.env ?? process.env)
  if (apiKey === undefined) throw new Error("Jev credentials unavailable")
  return (options.clientFactory ?? loadClient)(apiKey)
}

const evaluate = async (
  options: JevDecisionOptions,
  state: unknown,
  questions: Questions,
  signal?: AbortSignal,
): Promise<Record<string, Record<string, unknown>>> => {
  const client = await resolveJevClient(options)
  const timeoutMs = options.timeoutMs ?? jevTimeoutMs
  const controller = new AbortController()
  let rejectInterrupted: (reason: Error) => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject
  })
  const cancel = () => {
    controller.abort()
    rejectInterrupted(new DOMException("Jev decision cancelled", "AbortError"))
  }
  const timer = setTimeout(() => {
    controller.abort()
    rejectInterrupted(new Error("Jev decision timed out"))
  }, timeoutMs)
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    if (signal?.aborted) throw new DOMException("Jev decision cancelled", "AbortError")
    const request: SystemOneRequest = {
      state: JSON.stringify(state),
      model: jevModel,
      questions,
    }
    const response = await Promise.race([
      client.systemOne(request, { timeout: timeoutMs, retry: { maxRetries: 0 }, signal: controller.signal }),
      interrupted,
    ])
    const answers = asRecord(asRecord(response).answers)
    return Object.fromEntries(Object.entries(questions).map(([id]) => [id, asRecord(answers[id])]))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
  }
}

export const askJevNoul = async (
  options: JevDecisionOptions,
  state: unknown,
  instructions: string,
  criteria: { readonly true: string; readonly false: string },
  signal?: AbortSignal,
): Promise<number> => {
  const answer = (await evaluate(options, state, { decision: noul(instructions, criteria) }, signal)).decision!
  if (answer.type !== "noul") throw new Error("Invalid Jev decision answer type")
  return probability(answer.noul)
}

export const askJevNouls = async (
  options: JevDecisionOptions,
  state: unknown,
  questions: Readonly<
    Record<
      string,
      {
        readonly instructions: string
        readonly criteria: { readonly true: string; readonly false: string }
      }
    >
  >,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, number>>> => {
  const requested = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [id, noul(question.instructions, question.criteria)]),
  )
  const answers = await evaluate(options, state, requested, signal)
  return Object.fromEntries(
    Object.entries(requested).map(([id, question]) => {
      const answer = answers[id]
      if (answer === undefined || answer.type !== question.type) throw new Error("Invalid Jev decision answer type")
      return [id, probability(answer.noul)]
    }),
  )
}

export const askJevChoice = async <Option extends string>(
  options: JevDecisionOptions,
  state: unknown,
  instructions: string,
  criteria: Readonly<Record<Option, string | null>>,
  signal?: AbortSignal,
): Promise<{ readonly choice: Option; readonly confidence: number }> => {
  const answer = (await evaluate(options, state, { decision: choice(instructions, criteria) }, signal)).decision!
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice)) {
    throw new Error("Invalid Jev decision choice")
  }
  const confidence = probability(answer.confidence)
  const probabilities = asRecord(answer.probabilities)
  const candidates = Object.keys(criteria)
  if (
    Object.keys(probabilities).length !== candidates.length ||
    candidates.some((candidate) => !Object.hasOwn(probabilities, candidate))
  ) {
    throw new Error("Invalid Jev choice probabilities")
  }
  for (const option of Object.keys(criteria)) probability(probabilities[option])
  return { choice: answer.choice as Option, confidence }
}
