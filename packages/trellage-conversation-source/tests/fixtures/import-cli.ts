export {}

const signals = ["SIGINT", "SIGHUP", "SIGTERM"] as const
const before = signals.map((signal) => process.listenerCount(signal))
await import("../../src/cli.ts")
const after = signals.map((signal) => process.listenerCount(signal))
if (before.some((count, index) => count !== after[index])) throw new Error("CLI import installed signal handlers.")
process.stdout.write(`${JSON.stringify({
  imported: true,
  bun: process.versions.bun,
  environmentLoaded: process.env.CONVERSATION_TEST_ENV_SENTINEL !== undefined,
})}\n`)
