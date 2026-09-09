import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { Cause, Effect } from "effect"

import { loadProfile, profileImage } from "./application.js"
import { dockerHostArguments, verifyDockerTarget, type DockerTarget, type DockerTargetRunner } from "./docker-target.js"
import type { ProfileDocument } from "./profile.js"

export interface SkillsCheckReport {
  readonly kind: "current" | "available" | "unknown"
  readonly diagnostic?: string
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const execFilePromise = promisify(execFile)
const liveRun: DockerTargetRunner = (command, args) =>
  Effect.tryPromise({
    try: async (signal) =>
      (
        await execFilePromise(command, [...args], {
          signal,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: 5 * 60 * 1000,
          env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
        })
      ).stdout,
    catch: (cause) => cause,
  })

const bakedSkillsPath = (kind: string): string | undefined => {
  if (kind === "codex") return "/home/agent/.codex/skills"
  if (kind === "headlong") return "/usr/local/share/trellage/headlong-skills/skills"
  if (["claude", "copilot", "pi", "prime"].includes(kind)) return `/usr/local/share/trellage/${kind}-seed/skills`
  return undefined
}

const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({ try: operation, catch: (cause) => cause })
const failure = (cause: unknown): SkillsCheckReport => ({
  kind: "unknown",
  diagnostic: cause instanceof Error ? cause.message : String(cause),
})

const parseReport = (text: string): SkillsCheckReport => {
  const value: unknown = JSON.parse(text)
  if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error("Invalid skills report.")
  if (value.kind === "current" || value.kind === "available") return { kind: value.kind }
  if (value.kind === "unknown" && "diagnostic" in value && typeof value.diagnostic === "string") {
    return { kind: "unknown", diagnostic: value.diagnostic }
  }
  throw new Error("Skills check returned no freshness evidence.")
}

const inspectImageId = (output: string): string => {
  const id = output.trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error("Installed image has no exact local image ID.")
  return id
}

const ownedContainerId = (output: string, name: string, token: string, image: string): string => {
  const value: unknown = JSON.parse(output)
  if (typeof value !== "object" || value === null) throw new Error("Invalid check container evidence.")
  const record = value as {
    Id?: string
    Name?: string
    Image?: string
    Config?: { Labels?: Record<string, string> }
    State?: { Running?: boolean }
  }
  if (
    record.Name !== `/${name}` ||
    record.Image !== image ||
    record.Config?.Labels?.["io.trellage.skills-check"] !== token
  ) {
    throw new Error("Temporary check container ownership does not match.")
  }
  if (!/^[0-9a-f]{64}$/.test(record.Id ?? "") || record.State?.Running !== false) {
    throw new Error("Temporary check container is not stopped.")
  }
  return record.Id!
}

const extractAndCompare = (
  document: ProfileDocument,
  target: DockerTarget,
  source: string,
  stage: string,
  run: DockerTargetRunner,
) =>
  Effect.gen(function* () {
    const docker = (args: ReadonlyArray<string>) =>
      verifyDockerTarget(target, run).pipe(Effect.zipRight(run("docker", dockerHostArguments(target, args))))
    const image = yield* docker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      profileImage(document.profile.name, target.platform),
    ]).pipe(Effect.flatMap((output) => Effect.try(() => inspectImageId(output))))
    const token = randomUUID()
    const name = `trellage-skills-check-${token}`
    let removed = false
    const inspect = () =>
      docker(["container", "inspect", "--format", "{{json .}}", name]).pipe(
        Effect.flatMap((output) => Effect.try(() => ownedContainerId(output, name, token, image))),
      )
    const remove = () =>
      inspect().pipe(
        Effect.flatMap((id) => docker(["container", "rm", "--volumes", id])),
        Effect.tap(() =>
          Effect.sync(() => {
            removed = true
          }),
        ),
        Effect.asVoid,
      )
    return yield* Effect.acquireUseRelease(
      docker([
        "container",
        "create",
        "--name",
        name,
        "--label",
        `io.trellage.skills-check=${token}`,
        "--network",
        "none",
        "--read-only",
        "--entrypoint",
        "/bin/false",
        image,
      ]).pipe(Effect.zipRight(inspect())),
      (id) =>
        Effect.gen(function* () {
          const extracted = path.join(stage, "baked")
          yield* io(() => mkdir(extracted, { mode: 0o700 }))
          yield* docker(["container", "cp", `${id}:${source}/.`, extracted])
          const result = yield* run(process.execPath, [
            path.join(root, "scripts/floating-skills.mjs"),
            "check-container",
            "--catalog",
            path.join(root, "skills.json"),
            ...document.profile.skill_bundles.flatMap((bundle) => ["--bundle", bundle]),
            "--target",
            extracted,
            "--output",
            stage,
            "--skills-cli",
            path.join(root, "packages/trellage-cli/node_modules/skills/bin/cli.mjs"),
          ])
          return yield* Effect.try(() => parseReport(result))
        }),
      () => remove().pipe(Effect.orDie),
    ).pipe(Effect.onError(() => (removed ? Effect.void : remove().pipe(Effect.ignore))))
  })

export const checkContainerSkills = (
  document: ProfileDocument,
  target: DockerTarget,
  run: DockerTargetRunner = liveRun,
  cwd = process.cwd(),
): Effect.Effect<SkillsCheckReport> => {
  const source = bakedSkillsPath(document.profile.harness.kind)
  if (source === undefined || document.profile.skill_bundles.length === 0) {
    return Effect.succeed({ kind: "unknown", diagnostic: "This profile has no supported floating skill snapshot." })
  }
  return Effect.acquireUseRelease(
    io(() => mkdtemp(path.join(cwd, ".trellage-image-skills-check."))),
    (stage) => extractAndCompare(document, target, source, stage, run),
    (stage) => io(() => rm(stage, { recursive: true, force: true })).pipe(Effect.orDie),
  ).pipe(Effect.catchAllCause((cause) => Effect.succeed({ kind: "unknown" as const, diagnostic: Cause.pretty(cause) })))
}

export const skillsCheckReport = (profile: string, target: DockerTarget): Effect.Effect<SkillsCheckReport> =>
  loadProfile(profile).pipe(
    Effect.flatMap((document) => checkContainerSkills(document, target)),
    Effect.catchAll((cause) => Effect.succeed(failure(cause))),
  )
