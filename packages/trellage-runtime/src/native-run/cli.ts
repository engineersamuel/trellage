import { main } from "./run.ts"

const runArguments = process.argv.slice(2)
if (import.meta.main) {
  try {
    process.exitCode = await main(runArguments)
  } catch (error) {
    console.error(`trx: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
