import fs from "node:fs"
import path from "node:path"

enum Race {
  Rollback = "rollback",
  Snapshot = "snapshot",
  Crash = "crash",
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`missing race fixture variable: ${name}`)
  return value
}

const requestedRace = requiredEnvironment("TRELLAGE_TEST_MANAGED_RACE")
const race = Object.values(Race).find((value) => value === requestedRace)
if (race === undefined) throw new Error(`unknown managed-file race fixture: ${requestedRace}`)
const target = path.resolve(requiredEnvironment("TRELLAGE_TEST_MANAGED_RACE_PATH"))
const marker = path.resolve(requiredEnvironment("TRELLAGE_TEST_MANAGED_RACE_MARKER"))
const removedDirectory = race === Race.Snapshot ? "prior-removed" : "rollback-removed"
const originalRename = fs.renameSync.bind(fs)

const injectRace = (destination: string): void => {
  if (race === Race.Snapshot) {
    fs.writeFileSync(target, "concurrent in-place edit\n")
  } else {
    const replacement = `${target}.concurrent-replacement`
    const content = race === Race.Crash ? "crash-window replacement\n" : "concurrent rollback replacement\n"
    fs.writeFileSync(replacement, content)
    originalRename(replacement, target)
  }
  if (race === Race.Crash) originalRename(target, destination)
  fs.writeFileSync(marker, "")
  if (race === Race.Crash) {
    if (process.ppid <= 1) throw new Error("crash fixture requires an isolated entrypoint parent")
    process.kill(process.ppid, "SIGKILL")
    process.kill(process.pid, "SIGKILL")
  }
}

fs.renameSync = (source, destination) => {
  if (
    typeof source === "string" &&
    typeof destination === "string" &&
    path.resolve(source) === target &&
    destination.includes(`${path.sep}${removedDirectory}${path.sep}`) &&
    !fs.existsSync(marker)
  ) {
    injectRace(destination)
  }
  return originalRename(source, destination)
}
