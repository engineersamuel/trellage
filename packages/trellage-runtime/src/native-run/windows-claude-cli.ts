import { parseRunArguments, prepareRun } from "./run.ts"
import { admitWindowsClaude } from "./windows-claude.ts"

if (import.meta.main) {
  try {
    const prepared = await prepareRun(parseRunArguments(["claude", "default", "--dry-run"]))
    await admitWindowsClaude(process.env, prepared.launch)
    console.log(`trx ${process.argv[2]} claude default: ready (native Windows, http://127.0.0.1:8080)`)
  } catch (cause) {
    console.error(`trx: ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
  }
}
