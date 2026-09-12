import { lstat } from "node:fs/promises"
import path from "node:path"
import { hasErrorCode } from "./records.ts"

export const findTrellageRoot = async (start: string): Promise<string> => {
  let current = path.resolve(start)
  for (;;) {
    try {
      const stat = await lstat(path.join(current, "mise.toml"))
      if (stat.isFile() && !stat.isSymbolicLink()) return current
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error
    }
    const parent = path.dirname(current)
    if (parent === current) throw new Error("The plugin is not inside a Trellage checkout")
    current = parent
  }
}
