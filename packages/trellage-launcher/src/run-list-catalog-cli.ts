#!/usr/bin/env bun
import { loadRunListCatalog } from "./run-list-catalog.ts"
import { formatRunList, parseRunListArguments, RUN_LIST_USAGE } from "./run-list.ts"

export const main = async (argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> => {
  let parsed: ReturnType<typeof parseRunListArguments>
  try {
    parsed = parseRunListArguments(argv)
  } catch {
    process.stderr.write(`${RUN_LIST_USAGE}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(`${RUN_LIST_USAGE}\n`)
    return 0
  }
  const catalog = await loadRunListCatalog()
  process.stdout.write(parsed.format === "json" ? `${JSON.stringify(catalog)}\n` : formatRunList(catalog))
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`trx run list: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
