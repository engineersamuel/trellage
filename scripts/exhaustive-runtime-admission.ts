import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises"
import path from "node:path"
import { nativePresetProfiles } from "@trellage/runtime/native-run"
import { PRIME_PROFILE_MARKER, primeRuntimePaths } from "../packages/trellage-runtime/src/native-run/prime-runtime.ts"

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** External lifecycle/version boundaries only; production admission and runtime validation still execute. */
export const createRuntimeAdmission = async (root: string, home: string, executable: string) => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  assert(path.isAbsolute(root) && path.isAbsolute(home) && path.isAbsolute(executable))
  const directory = path.join(root, "runtime-admission")
  await mkdir(directory, { recursive: true })
  const callsFile = path.join(directory, "calls.jsonl")
  const overlay = path.join(directory, "omp.yml")
  const credential = path.join(directory, "omp-credential")
  await writeFile(overlay, "setupVersion: 1\n", { mode: 0o600 })
  const prime = primeRuntimePaths({ environment: { HOME: home } })
  const packageRoot = path.join(prime.npmPrefix, "lib", "node_modules", "prime-agent")
  const cli = path.join(packageRoot, "dist", "bundle", "cli.js")
  const identity = {
    schemaVersion: 1,
    primeVersion: "0.7.0",
    runtimeHashAlgorithm: "sha256",
    runtimeHash: "a".repeat(64),
    kernelSpecVersion: 1,
  }
  const versionProgram = `import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
if (process.env.TRELLAGE_TEST_OFFLINE !== "1" || process.env.HOME !== ${JSON.stringify(home)} || JSON.stringify(args) !== '["--version"]') {
  process.stderr.write("Unexpected Prime version request\\n"); process.exit(97)
}
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ role: "prime-version", args }) + "\\n")
console.log("0.7.0")
`
  const program = path.join(directory, "admit.ts")
  const ompProfiles = nativePresetProfiles("omp")
  assert.deepEqual([...ompProfiles].sort(), ["default", "local"], "audit new OMP profile admission")
  await writeFile(
    program,
    `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
const role = process.argv[2]
const args = process.argv.slice(3)
const fail = () => { process.stderr.write("Unexpected runtime admission request\\n"); process.exit(97) }
if (process.env.TRELLAGE_TEST_OFFLINE !== "1" || process.env.HOME !== ${JSON.stringify(home)}) fail()
if (role === "omp") {
  if (process.env.TRELLAGE_TRX_OMP_ADAPTER !== "1" || args.length !== 2 || args[0] !== "_trx-admit" || !${JSON.stringify(ompProfiles)}.includes(args[1])) fail()
  const isDefault = args[1] === "default"
  if (isDefault) writeFileSync(${JSON.stringify(credential)}, "fixture-copilot-token\\n", { mode: 0o600, flag: "wx" })
  appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ role, args }) + "\\n")
  console.log(JSON.stringify({ schemaVersion: 1, executable: ${JSON.stringify(executable)}, ompProfile: isDefault ? "trellage-copilot-native" : "trellage-qwen-local", piConfigFiles: ${JSON.stringify(overlay)}, version: "18.8.5", copilotCredentialFile: isDefault ? ${JSON.stringify(credential)} : null }))
} else if (role === "prime") {
  const installed = existsSync(${JSON.stringify(prime.receiptFile)})
  if (JSON.stringify(args) !== JSON.stringify([installed ? "repair" : "setup", "default"])) fail()
  appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ role, args }) + "\\n")
  for (const directory of ${JSON.stringify([path.dirname(cli), path.join(packageRoot, "node_modules"), path.join(prime.profileHome, "extensions"), path.dirname(prime.kernelPython)])}) mkdirSync(directory, { recursive: true })
  writeFileSync(${JSON.stringify(path.join(packageRoot, "package.json"))}, ${JSON.stringify(JSON.stringify({ name: "prime-agent", version: "0.7.0" }) + String.fromCharCode(10))})
  writeFileSync(${JSON.stringify(cli)}, ${JSON.stringify(versionProgram)})
  writeFileSync(${JSON.stringify(prime.receiptFile)}, "0.7.0\\n")
  writeFileSync(${JSON.stringify(prime.runtimeIdentityFile)}, ${JSON.stringify(JSON.stringify(identity) + String.fromCharCode(10))})
  writeFileSync(${JSON.stringify(prime.profileMarker)}, ${JSON.stringify(PRIME_PROFILE_MARKER + String.fromCharCode(10))})
  writeFileSync(${JSON.stringify(prime.kernelPython)}, "#!/bin/sh\\nexit 97\\n", { mode: 0o700 })
  writeFileSync(${JSON.stringify(prime.kernelIdentityStamp)}, ${JSON.stringify(JSON.stringify(identity) + String.fromCharCode(10))})
} else fail()
`,
  )
  const binaries: Record<string, string> = {}
  for (const role of ["omp", "prime"]) {
    const binary = path.join(directory, role)
    await writeFile(
      binary,
      `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} ${shellWord(role)} "$@"\n`,
      { mode: 0o700 },
    )
    binaries[role] = binary
  }
  const canonicalHome = await realpath(home)
  return {
    prime: primeRuntimePaths({ environment: { HOME: canonicalHome } }),
    cli: path.join(canonicalHome, path.relative(home, cli)),
    overlay,
    credential,
    binaries,
    executable,
    environment: {
      TRELLAGE_OMP_LIFECYCLE_BIN: binaries.omp!,
      TRELLAGE_PRIME_LIFECYCLE_BIN: binaries.prime!,
      TRELLAGE_NODE_BIN: process.execPath,
    },
    calls: async (): Promise<{ role: string; args: string[] }[]> => {
      const text = await readFile(callsFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
  }
}
