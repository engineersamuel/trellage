import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { Data, Effect } from "effect"

import { parseDockerPlatform, type Platform } from "./platform.js"

const execFilePromise = promisify(execFile)

export interface DockerTarget {
  readonly endpoint: string
  readonly serverId: string
  readonly platform: Platform
}

export class DockerTargetError extends Data.TaggedError("DockerTargetError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type DockerTargetRunner = (command: string, arguments_: ReadonlyArray<string>) => Effect.Effect<string, unknown>

const liveRunner: DockerTargetRunner = (command, arguments_) =>
  Effect.tryPromise({
    try: async () => (await execFilePromise(command, [...arguments_], { encoding: "utf8" })).stdout,
    catch: (cause) => cause,
  })

const validateEndpoint = (endpoint: string): Effect.Effect<string, DockerTargetError> => {
  if (!endpoint.startsWith("unix:///")) {
    return Effect.fail(new DockerTargetError({ message: `Docker endpoint must be Unix: ${endpoint || "missing"}` }))
  }
  try {
    const parsed = new URL(endpoint)
    if (
      parsed.protocol !== "unix:" ||
      parsed.hostname !== "" ||
      parsed.pathname.length < 2 ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid Unix endpoint")
    }
    return Effect.succeed(endpoint)
  } catch (cause) {
    return Effect.fail(new DockerTargetError({ message: `Docker endpoint must be Unix: ${endpoint}`, cause }))
  }
}

const inspectTarget = (endpoint: string, run: DockerTargetRunner): Effect.Effect<DockerTarget, DockerTargetError> =>
  run("docker", ["--host", endpoint, "info", "--format", "{{.ID}}\n{{.OSType}}/{{.Architecture}}"]).pipe(
    Effect.mapError((cause) => new DockerTargetError({ message: "cannot inspect Docker server", cause })),
    Effect.flatMap((output) => {
      const [serverId = "", reportedPlatform = ""] = output.trim().split(/\r?\n/, 2)
      if (serverId.length === 0)
        return Effect.fail(new DockerTargetError({ message: "Docker server identity is empty" }))
      return parseDockerPlatform(reportedPlatform).pipe(
        Effect.mapError((cause) => new DockerTargetError({ message: cause.message, cause })),
        Effect.map((platform) => ({ endpoint, serverId, platform })),
      )
    }),
  )

export const captureDockerTarget = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  run: DockerTargetRunner = liveRunner,
): Effect.Effect<DockerTarget, DockerTargetError> =>
  Effect.gen(function* () {
    const explicit = environment.DOCKER_HOST?.trim()
    const endpoint =
      explicit && explicit.length > 0
        ? yield* validateEndpoint(explicit)
        : yield* run("docker", ["context", "show"]).pipe(
            Effect.map((value) => value.trim()),
            Effect.mapError((cause) => new DockerTargetError({ message: "cannot capture Docker context", cause })),
            Effect.flatMap((context) =>
              run("docker", ["context", "inspect", context, "--format", '{{ (index .Endpoints "docker").Host }}']),
            ),
            Effect.map((value) => value.trim()),
            Effect.mapError((cause) => new DockerTargetError({ message: "cannot capture Docker endpoint", cause })),
            Effect.flatMap(validateEndpoint),
          )
    return yield* inspectTarget(endpoint, run)
  })

export const verifyDockerTarget = (
  target: DockerTarget,
  run: DockerTargetRunner = liveRunner,
): Effect.Effect<void, DockerTargetError> =>
  inspectTarget(target.endpoint, run).pipe(
    Effect.flatMap((current) =>
      current.serverId === target.serverId && current.platform === target.platform
        ? Effect.void
        : Effect.fail(new DockerTargetError({ message: "Docker server changed during operation" })),
    ),
  )

export const dockerHostArguments = (target: DockerTarget, arguments_: ReadonlyArray<string>): Array<string> => [
  "--host",
  target.endpoint,
  ...arguments_,
]

export const dockerSocketPath = (target: DockerTarget): string => new URL(target.endpoint).pathname
