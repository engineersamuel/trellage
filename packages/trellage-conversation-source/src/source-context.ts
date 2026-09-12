import path from "node:path"

export const sourceWorkingDirectory = (
  context: { readonly cwd?: unknown },
  agentInfo: { readonly foreground_cwd?: unknown; readonly cwd?: unknown },
): string => {
  for (const value of [agentInfo.foreground_cwd, agentInfo.cwd, context.cwd]) {
    if (typeof value === "string" && value.length > 0 && value.length <= 4096 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
      if (!path.isAbsolute(value)) continue
      return value
    }
  }
  throw new Error("The focused agent does not have an absolute working directory")
}
