import { main } from "./run.ts"
import { adapters } from "./adapters.ts"
import { nativeHarness } from "./registry.ts"
import { runNativeBackend } from "./backend-cli.ts"

const [harness, ...args] = process.argv.slice(2)
const selection = args.slice(0, args.findIndex((arg) => arg.startsWith("-")) === -1 ? args.length : args.findIndex((arg) => arg.startsWith("-")))
const registration = harness ? nativeHarness(harness) : undefined
const preset = registration ? selection.find((profile) => registration.presets[profile]) : undefined
const backendOnly = registration !== undefined && !Object.hasOwn(adapters, registration.id)
const needsProfile = backendOnly && !preset && !args.includes("--help") && !args.includes("-h") && !args.includes("help") && !args.includes("--dry-run")
if (needsProfile && registration && !registration.presets.default) {
  console.error(`trx: ${registration.id} needs a profile: trx run ${registration.id} ${Object.keys(registration.presets).join("|")}`)
  process.exit(1)
}
try {
  process.exitCode = (preset || needsProfile) && harness
    ? await runNativeBackend("run", harness, needsProfile ? ["default", ...args] : args)
    : await main(process.argv.slice(2))
} catch (error) {
  console.error(`trx: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
