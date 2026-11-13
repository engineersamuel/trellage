import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises"
import path from "node:path"
import { nativePresetProfiles } from "@trellage/runtime/native-run"
import { PRIME_PROFILE_MARKER, primeRuntimePaths } from "../packages/trellage-runtime/src/native-run/prime-runtime.ts"

import { prelude, shellWord, writeExact } from "./sh-mock.ts"

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
  const payloadRoot = path.join(prime.rustPrefix, "share", "prime-agent")
  const cli = path.join(prime.rustPrefix, "bin", "prime-agent")
  const identity = {
    schemaVersion: 1,
    primeVersion: "0.10.0",
    runtimeHashAlgorithm: "sha256",
    runtimeHash: "a".repeat(64),
    kernelSpecVersion: 1,
  }
  const versionProgram = `#!/bin/sh
if [ "$TRELLAGE_TEST_OFFLINE" != 1 ] || [ "$HOME" != ${JSON.stringify(home)} ] || [ "$*" != --version ]; then
  echo "Unexpected Prime version request" >&2; exit 97
fi
printf '{"role":"prime-version","args":["--version"]}\\n' >> ${JSON.stringify(callsFile)}
echo 0.10.0 >&2
`
  const ompProfiles = nativePresetProfiles("omp")
  assert.deepEqual([...ompProfiles].sort(), ["default", "local"], "audit new OMP profile admission")
  const reply = (isDefault: boolean) =>
    JSON.stringify({
      schemaVersion: 1,
      executable,
      ompProfile: isDefault ? "trellage-copilot-native" : "trellage-qwen-local",
      piConfigFiles: overlay,
      version: "18.8.5",
      copilotCredentialFile: isDefault ? credential : null,
    })
  const identityJson = `${JSON.stringify(identity)}\n`
  const log = `printf '{"role":"%s","args":%s}\\n' "$role" "$(args_json "$@")" >> ${shellWord(callsFile)}`
  // One /bin/sh program per role (no interpreter start per call); same checks, calls log and files as before.
  const program = `${prelude("Unexpected runtime admission request")}role=$1; shift
[ "\${TRELLAGE_TEST_OFFLINE:-}" = 1 ] && [ "\${HOME:-}" = ${shellWord(home)} ] || fail
if [ "$role" = omp ]; then
  [ "\${TRELLAGE_TRX_OMP_ADAPTER:-}" = 1 ] && [ $# = 2 ] && [ "$1" = _trx-admit ] || fail
  case "$2" in
${ompProfiles.map((profile) => `    ${shellWord(profile)}) ;;`).join("\n")}
    *) fail ;;
  esac
  if [ "$2" = default ]; then
    # Like writeFileSync(..., { flag: "wx", mode: 0o600 }): fail when the credential already exists.
    (umask 077; set -C; printf 'fixture-copilot-token\\n' > ${shellWord(credential)}) || exit 1
  fi
  ${log}
  if [ "$2" = default ]; then printf '%s\\n' ${shellWord(reply(true))}; else printf '%s\\n' ${shellWord(reply(false))}; fi
elif [ "$role" = prime ]; then
  if [ -e ${shellWord(prime.receiptFile)} ]; then want=repair; else want=setup; fi
  [ $# = 2 ] && [ "$1" = "$want" ] && [ "$2" = default ] || fail
  ${log}
  mkdir -p ${[path.dirname(cli), payloadRoot, path.join(prime.profileHome, "extensions"), path.dirname(prime.kernelPython)].map(shellWord).join(" ")}
  ${writeExact(path.join(payloadRoot, "package.json"), `${JSON.stringify({ name: "prime-agent", version: "0.10.0" })}\n`)}
  ${writeExact(cli, versionProgram)}
  chmod 755 ${shellWord(cli)}
  ${writeExact(prime.receiptFile, "0.10.0\n")}
  ${writeExact(prime.runtimeIdentityFile, identityJson)}
  ${writeExact(prime.profileMarker, `${PRIME_PROFILE_MARKER}\n`)}
  ${writeExact(prime.kernelPython, "#!/bin/sh\nexit 97\n")}
  chmod 700 ${shellWord(prime.kernelPython)}
  ${writeExact(prime.kernelIdentityStamp, identityJson)}
else fail
fi
`
  const binaries: Record<string, string> = {}
  for (const role of ["omp", "prime"]) {
    const binary = path.join(directory, role)
    await writeFile(binary, program.replace("role=$1; shift", `role=${role}`), { mode: 0o700 })
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
