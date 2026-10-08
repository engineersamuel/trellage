import { main } from "./run.ts"
import { nativeHarness } from "./registry.ts"
import { runNativeBackend } from "./backend-cli.ts"

const [harness, ...args] = process.argv.slice(2)
const selection = args.slice(0, args.findIndex((arg) => arg.startsWith("-")) === -1 ? args.length : args.findIndex((arg) => arg.startsWith("-")))
const preset = harness ? selection.find((profile) => nativeHarness(harness)?.presets[profile]) : undefined
try {
  process.exitCode = preset && harness
    ? await runNativeBackend("run", harness, args)
    : await main(process.argv.slice(2))
} catch (error) {
  console.error(`trx: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
