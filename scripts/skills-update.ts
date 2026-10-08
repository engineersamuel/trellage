#!/usr/bin/env -S bun --no-env-file
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { updateSkills } from "@trellage/runtime/skill-update"

const args = process.argv.slice(2)
if (args.some((arg) => !["--check", "--upgrade-pins"].includes(arg))) {
  process.stderr.write("usage: trx skills update [--check | --upgrade-pins]\n")
  process.exitCode = 2
} else {
  try {
    const loaded = await readTrellageConfig()
    if (!loaded.present) throw new Error(`configuration is missing: ${loaded.path}`)
    const results = await updateSkills({
      configPath: loaded.path,
      check: args.includes("--check"),
      upgradePins: args.includes("--upgrade-pins"),
    })
    for (const result of results) {
      process.stdout.write(
        `${result.source}: ${result.oldSelector}${result.newSelector === result.oldSelector ? "" : ` -> ${result.newSelector}`} resolved ${result.commit ?? "not cached"}${result.candidateCommit ? `; candidate ${result.candidateCommit}` : ""}; profiles: ${result.profiles.join(", ") || "none"}\n`,
      )
    }
  } catch (error) {
    process.stderr.write(`skills: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
