import assert, { deepStrictEqual } from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  CommandRunnerError,
  type CommandRunner,
  type CommandRunOptions,
  type CommandRunResult,
} from "../../src/guide-launch.js"
import {
  FixtureMode,
  fixtureBranch,
  fixtureHead,
  fixtureProfiles,
  repositoryPack,
  researchIntent,
  type RecordFixtureEvent,
} from "./guide-integration-data.js"

const success = (stdout = ""): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })

const runResearch = async (
  root: string,
  args: ReadonlyArray<string>,
  options: CommandRunOptions | undefined,
): Promise<CommandRunResult> => {
  deepStrictEqual(args.length, 3)
  deepStrictEqual(options?.cwd, root)
  deepStrictEqual(options?.signal?.aborted, false)
  const request = args[2]?.match(/\n<request>\n([\s\S]+)\n<\/request>$/u)?.[1]
  assert(request !== undefined, "Research must receive the original intent in its request")
  assert(args[2]?.includes("rpi-research"))
  const notes = path.join(root, ".copilot-tracking", "research", "2026-01-01")
  await mkdir(notes, { recursive: true })
  await writeFile(path.join(notes, "login-research.md"), researchIntent(request))
  return success("Saved the research note.\n")
}

const runNative = (
  root: string,
  executable: string,
  args: ReadonlyArray<string>,
  options: CommandRunOptions | undefined,
): CommandRunResult | Promise<CommandRunResult> => {
  if (executable === path.join(root, "bin", "cpx") && args[0] === "hve" && args[1] === "-p") {
    return runResearch(root, args, options)
  }
  const native = fixtureProfiles.find(
    (profile) =>
      profile.surface === "native" &&
      executable === path.join(root, "bin", profile.launcher) &&
      args[1] === profile.name,
  )
  assert(native?.surface === "native", `Unexpected native profile: ${args[1]}`)
  deepStrictEqual(args, ["inventory", native.name, "--json"])
  deepStrictEqual(options?.cwd, root)
  return success(
    JSON.stringify({
      schemaVersion: 1,
      launcher: native.launcher,
      profile: native.name,
      readiness: "healthy",
    }),
  )
}

const runSandbox = (
  root: string,
  args: ReadonlyArray<string>,
  options: CommandRunOptions | undefined,
): CommandRunResult => {
  const sandbox = fixtureProfiles.find((profile) => profile.surface === "sandbox" && profile.name === args[2])
  assert(sandbox !== undefined, `Unexpected Sandbox profile: ${args[2]}`)
  deepStrictEqual(args, ["doctor", "--profile", sandbox.name])
  deepStrictEqual(options?.cwd, root)
  return success(`profile: ${sandbox.name} (sandbox)\ndevelopment resolution: true\nimage: trellage/test (available)\n`)
}

const runRepomix = async (
  root: string,
  args: ReadonlyArray<string>,
  options: CommandRunOptions | undefined,
): Promise<CommandRunResult> => {
  deepStrictEqual(options?.cwd, root)
  deepStrictEqual(options?.signal?.aborted, false)
  deepStrictEqual(args.slice(0, 5), ["--yes", "repomix@latest", "--style", "markdown", "--compress"])
  deepStrictEqual(args.length, 9)
  deepStrictEqual(args[5], "--ignore")
  assert(args[6]?.includes("**/node_modules/**"))
  deepStrictEqual(args[7], "-o")
  const outputPath = args[8]
  assert(outputPath !== undefined && path.resolve(outputPath).startsWith(`${root}${path.sep}`))
  await writeFile(outputPath, repositoryPack)
  return success("Packed the fixture repository.\n")
}

const runGit = (
  root: string,
  mode: FixtureMode,
  args: ReadonlyArray<string>,
  options: CommandRunOptions | undefined,
): CommandRunResult => {
  deepStrictEqual(args.slice(0, 3), ["--no-pager", "-C", root])
  deepStrictEqual(options?.cwd, undefined)
  const operation = args.slice(3)
  switch (operation[0]) {
    case "check-ref-format":
      deepStrictEqual(operation, ["check-ref-format", "--branch", fixtureBranch])
      return success(`${fixtureBranch}\n`)
    case "rev-parse": {
      const showRoot = operation[1] === "--show-toplevel"
      deepStrictEqual(operation, ["rev-parse", showRoot ? "--show-toplevel" : "HEAD"])
      return success(`${showRoot ? root : fixtureHead}\n`)
    }
    case "status":
      deepStrictEqual(operation, ["status", "--porcelain"])
      return success(mode === FixtureMode.DirtyWorktree ? " M src/login.ts\n" : "")
    case "show-ref":
      deepStrictEqual(operation, ["show-ref", "--verify", "--quiet", `refs/heads/${fixtureBranch}`])
      if (mode === FixtureMode.ExistingWorktree) return success()
      throw new CommandRunnerError({
        kind: "exited",
        executable: "git",
        args,
        exitCode: 1,
        message: "Fixture branch does not exist",
      })
    case "worktree": {
      deepStrictEqual(operation, ["worktree", "list", "--porcelain"])
      const primary = `worktree ${root}\nHEAD ${fixtureHead}\nbranch refs/heads/main\n\n`
      return success(
        primary +
          (mode === FixtureMode.ExistingWorktree
            ? `worktree ${path.join(root, "worktrees", "existing")}\nHEAD ${fixtureHead}\nbranch refs/heads/${fixtureBranch}\n\n`
            : ""),
      )
    }
    default:
      throw new Error(`Unexpected fixture Git operation: ${JSON.stringify(operation)}`)
  }
}

const herdrRunner = (root: string, mode: FixtureMode) => {
  let allocation = 0
  const panes = new Map<string, string>()
  const existingWorktree = path.join(root, "worktrees", "existing")
  const allocatePane = (args: ReadonlyArray<string>, tab: boolean): CommandRunResult => {
    deepStrictEqual(
      args,
      tab
        ? ["tab", "create", "--workspace", "9", "--cwd", root, "--no-focus"]
        : ["pane", "split", "--pane", "9-0", "--cwd", root, "--direction", "right", "--no-focus"],
    )
    const pane = { pane_id: `9-${++allocation}` }
    panes.set(pane.pane_id, root)
    return success(JSON.stringify({ result: tab ? { root_pane: pane } : { pane } }))
  }
  const allocateWorktree = (args: ReadonlyArray<string>, existing: boolean): CommandRunResult => {
    deepStrictEqual(existing, mode === FixtureMode.ExistingWorktree)
    deepStrictEqual(
      args,
      existing
        ? ["worktree", "open", "--cwd", root, "--path", existingWorktree, "--no-focus"]
        : ["worktree", "create", "--cwd", root, "--branch", fixtureBranch, "--base", "HEAD", "--no-focus"],
    )
    const workspaceId = String(20 + ++allocation)
    const paneId = `${workspaceId}-1`
    const cwd = existing
      ? path.join(root, "worktrees", "existing-canonical")
      : path.join(root, "worktrees", fixtureBranch)
    panes.set(paneId, cwd)
    return success(
      JSON.stringify({
        result: {
          workspace: { workspace_id: workspaceId },
          root_pane: { pane_id: paneId },
          worktree: { path: cwd },
        },
      }),
    )
  }
  const runPane = (args: ReadonlyArray<string>, options: CommandRunOptions | undefined): CommandRunResult => {
    const paneId = args[2]
    assert(paneId !== undefined && panes.has(paneId), `Unknown allocated pane: ${paneId}`)
    deepStrictEqual(args.length, 4)
    deepStrictEqual(options?.cwd, panes.get(paneId))
    assert(args[3]?.startsWith("env TRELLAGE_AUTOMATION=1 "))
    return success()
  }
  return (args: ReadonlyArray<string>, options: CommandRunOptions | undefined): CommandRunResult => {
    assert(mode !== FixtureMode.Terminal, "Herdr is unavailable in the terminal-only fixture")
    const operation = args.slice(0, 2).join(" ")
    if (operation === "pane run") return runPane(args, options)
    deepStrictEqual(options?.cwd, root)
    switch (operation) {
      case "pane split":
        return allocatePane(args, false)
      case "tab create":
        return allocatePane(args, true)
      case "worktree create":
        return allocateWorktree(args, false)
      case "worktree open":
        return allocateWorktree(args, true)
      default:
        throw new Error(`Unexpected fixture Herdr operation: ${JSON.stringify(args)}`)
    }
  }
}

export const createFixtureRunner = (root: string, mode: FixtureMode, record: RecordFixtureEvent): CommandRunner => {
  const bin = (name: string): string => path.join(root, "bin", name)
  const nativeCommands = new Set(
    fixtureProfiles.filter((profile) => profile.surface === "native").map((profile) => bin(profile.launcher)),
  )
  const runHerdr = herdrRunner(root, mode)

  return {
    async run(executable, args, options) {
      await record({
        kind: "command",
        command: {
          executable,
          args,
          ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        },
      })
      if (nativeCommands.has(executable)) return runNative(root, executable, args, options)
      switch (executable) {
        case bin("trellage"):
          return runSandbox(root, args, options)
        case "npx":
          return runRepomix(root, args, options)
        case "git":
          return runGit(root, mode, args, options)
        case "herdr":
          return runHerdr(args, options)
        default:
          throw new Error(`Unexpected fixture command: ${JSON.stringify({ executable, args })}`)
      }
    },
  }
}
