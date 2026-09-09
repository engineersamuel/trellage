import { stripVTControlCharacters } from "node:util"
import type { AdminProfileEntry } from "./admin-model.js"
import { CommandRunnerError, type CommandRunner, type CommandSpec } from "./guide-launch.js"

export interface ProfileUpdateStep {
  readonly command: CommandSpec
  readonly targets: ReadonlyArray<AdminProfileEntry>
}

export type ProfileUpdateResult =
  | { readonly ref: string; readonly name: string; readonly state: "success" }
  | { readonly ref: string; readonly name: string; readonly state: "failure"; readonly diagnostic: string }

export type UpdateCommandResult =
  | { readonly state: "success"; readonly stdout: string; readonly stderr: string }
  | { readonly state: "failure"; readonly diagnostic: string }

export const updateDiagnostic = (error: unknown): string => {
  if (error instanceof CommandRunnerError) return error.stderr.trim() || error.stdout.trim() || error.message
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim()
  return String(error)
}

const managementVerb = (command: CommandSpec): string | undefined => {
  const verb = command.args[0]
  if (verb === "harness-update" || verb === "skills-update") return verb
  return verb === "skills" && command.args[1] === "update" ? "skills update" : undefined
}

const checkManagementCommand = async (
  command: CommandSpec,
  runner: CommandRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const verb = managementVerb(command)
  if (verb === undefined) return
  // Older wrappers can forward an unknown management verb into an agent session.
  const help = await runner.run(command.executable, ["--help"], {
    cwd,
    timeoutMs: 10_000,
    outputOverflow: "truncate",
    ...(signal === undefined ? {} : { signal }),
  })
  const text = stripVTControlCharacters(`${help.stdout}\n${help.stderr}`)
  if (!new RegExp(`(?:^|\\s)${verb.replace(" ", "\\s+")}(?:\\s|$)`, "m").test(text)) {
    throw new Error(`${command.executable} does not support ${verb}. Refresh the installed Trellage launcher first.`)
  }
}

export const runUpdateCommand = async (
  command: CommandSpec,
  runner: CommandRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<UpdateCommandResult> => {
  if (signal?.aborted === true) return { state: "failure", diagnostic: "Update cancelled before this command started." }
  try {
    await checkManagementCommand(command, runner, cwd, signal)
    signal?.throwIfAborted()
    const output = await runner.run(command.executable, command.args, {
      cwd,
      timeoutMs: 30 * 60 * 1000,
      outputOverflow: "truncate",
      ...(signal === undefined ? {} : { signal }),
    })
    return { state: "success", stdout: output.stdout, stderr: output.stderr }
  } catch (error: unknown) {
    return { state: "failure", diagnostic: updateDiagnostic(error) }
  }
}

const harnessFallbackLine = (step: ProfileUpdateStep, output: string): string | undefined => {
  if (step.command.args[0] !== "upgrade") return undefined
  const headlong = step.targets.some((entry) => entry.harness === "headlong")
  return stripVTControlCharacters(output)
    .split("\n")
    .find(
      (line) =>
        line.startsWith("upgrade fallback: harness ") ||
        (headlong && line.startsWith("upgrade fallback: source https://github.com/laude-institute/headlong.git@")),
    )
}

export const runProfileUpdateStep = async (
  step: ProfileUpdateStep,
  runner: CommandRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ProfileUpdateResult>> => {
  const output = await runUpdateCommand(step.command, runner, cwd, signal)
  const fallback = output.state === "success" ? harnessFallbackLine(step, `${output.stdout}\n${output.stderr}`) : undefined
  const diagnostic =
    output.state === "failure" ? output.diagnostic : fallback === undefined ? undefined : `Harness was not updated: ${fallback}`
  return step.targets.map(({ ref, name }) =>
    diagnostic === undefined ? { ref, name, state: "success" } : { ref, name, state: "failure", diagnostic },
  )
}
