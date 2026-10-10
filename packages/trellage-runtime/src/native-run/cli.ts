import { main } from "./run.ts"

export const canonicalRunArguments = (argv: ReadonlyArray<string>): string[] => {
  if (argv[0] !== "fx") return [...argv]
  const args = argv.slice(1)
  if (args[0] === "default") return [...argv]
  const firstBare = args.findIndex((argument) => !argument.startsWith("-"))
  if (firstBare === -1) return ["fx", "default", ...args]
  return ["fx", "default", ...args.slice(0, firstBare), "--", ...args.slice(firstBare)]
}
if (import.meta.main) {
  try {
    process.exitCode = await main(canonicalRunArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(`trx: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
