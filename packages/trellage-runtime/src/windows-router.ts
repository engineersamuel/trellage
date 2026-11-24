import { spawn } from "node:child_process"
import path from "node:path"
import { bunArguments, bunExecutable, sourceEnvironment } from "./index.ts"

const usage = `Usage:
  trx run claude [PROFILE...] [OPTIONS] [-- CLAUDE_ARGS...]
  trx list [--json]
  trx doctor|setup|repair claude default

Native Windows supports Claude composed profiles, default, and clean.
Office plugin lifecycle, Unix-only harnesses, and Herdr handoff are not supported.`

export const windowsRoute = (args: readonly string[]): { script: string; args: string[] } | undefined => {
  if (
    ["help", "--help", "-h"].includes(args[0] ?? "") ||
    (args[0] === "run" && ["--help", "-h"].includes(args[1] ?? ""))
  )
    return undefined
  if (args[0] === "list")
    return { script: "packages/trellage-launcher/src/run-list-catalog-cli.ts", args: args.slice(1) }
  if (
    ["doctor", "setup", "repair"].includes(args[0] ?? "") &&
    args[1] === "claude" &&
    (args.length === 2 || (args.length === 3 && args[2] === "default"))
  )
    return { script: "packages/trellage-runtime/src/native-run/windows-claude-cli.ts", args: args.slice(0, 1) }
  if (args[0] !== "run" || args[1] !== "claude")
    throw new Error(`native Windows supports trx run claude and trx list; run trx --help`)
  return { script: "packages/trellage-runtime/src/native-run/cli.ts", args: args.slice(1) }
}

const childStatus = (
  root: string,
  script: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(bunExecutable(), bunArguments(path.join(root, script), args), {
      env: sourceEnvironment(environment),
      stdio: "inherit",
    })
    const handlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
      const handler = () => child.kill(signal)
      process.on(signal, handler)
      return { signal, handler }
    })
    const clear = () => {
      for (const { signal, handler } of handlers) process.off(signal, handler)
    }
    child.once("error", (error) => {
      clear()
      reject(error)
    })
    child.once("exit", (status) => {
      clear()
      resolve(status ?? 1)
    })
  })

export const runWindowsRouter = async (root: string, args: readonly string[]): Promise<number> => {
  const route = windowsRoute(args)
  if (!route) {
    console.log(usage)
    return 0
  }
  const environment = {
    ...process.env,
    HOME: process.env.HOME ?? process.env.USERPROFILE,
    TRELLAGE_RUN_SOURCE_ROOT: root,
    TRELLAGE_RUN_GUIDE_ROOT: path.join(root, "profile-guides"),
    TRELLAGE_RUN_ROUTER_PATH: process.env.TRELLAGE_TRX_COMMAND_PATH ?? path.join(root, "bin", "trx.ts"),
  }
  const prepared = await childStatus(
    root,
    "packages/trellage-runtime/src/workspace-cli.ts",
    ["ensure", root],
    environment,
  )
  if (prepared !== 0) return prepared
  return childStatus(root, route.script, route.args, environment)
}
