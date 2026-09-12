import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

export enum BunFixtureMode {
  Ready = "ready",
  Missing = "missing",
  NonExecutable = "non-executable",
  WrongVersion = "wrong-version",
  VersionFailed = "version-failed",
  Symlink = "symlink",
}

export enum BunFixtureFailure {
  Size = "size",
  Checksum = "checksum",
  Download = "download",
}

const execFilePromise = promisify(execFile)

const createBunArchive = async (root: string, mode?: BunFixtureMode) => {
  const payload = await mkdtemp(path.join(root, "bun-payload-"))
  const binaryDirectory = path.join(payload, "package", "bin")
  await mkdir(binaryDirectory, { recursive: true })
  if (mode !== BunFixtureMode.Missing) {
    const binaryName = mode === BunFixtureMode.Symlink ? "linked-bun" : "bun"
    await writeFile(
      path.join(binaryDirectory, binaryName),
      `#!/bin/sh
set -eu
[ "$1" = --no-install ] && [ "$2" = --no-env-file ] && [ "$3" = --config=/dev/null ]
[ "$BUN_RUNTIME_TRANSPILER_CACHE_PATH" = 0 ]
if [ "$4" = --version ]; then
  printf 'bun:version\\n' >> "$TRACE_FILE"
  printf '%s\\n' '${mode === BunFixtureMode.WrongVersion ? "0.0.0" : "1.3.3"}'
  exit ${mode === BunFixtureMode.VersionFailed ? "26" : "0"}
fi
printf 'bun:argv=%s\\n' "$*" >> "$TRACE_FILE"
exit "$FINALIZER_STATUS"
`,
      { mode: mode === BunFixtureMode.NonExecutable ? 0o644 : 0o755 },
    )
    if (mode === BunFixtureMode.Symlink) await symlink("linked-bun", path.join(binaryDirectory, "bun"))
  }
  const archive = path.join(payload, "fixture.tgz")
  await execFilePromise("tar", ["-czf", archive, "-C", payload, "package"])
  const bytes = await readFile(archive)
  return { archive, bytes }
}

export const createBunBuilderFixture = async (
  root: string,
  script: string,
  options: { readonly mode?: BunFixtureMode; readonly failure?: BunFixtureFailure },
): Promise<{ readonly script: string; readonly environment: Record<string, string> }> => {
  const { archive, bytes } = await createBunArchive(root, options.mode)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const bin = path.join(root, "bin")
  await Promise.all([
    writeFile(
      path.join(bin, "curl"),
      `#!/bin/sh
set -eu
printf 'curl:download\\n' >> "$TRACE_FILE"
[ "$BUN_FIXTURE_DOWNLOAD_STATUS" = 0 ] || exit "$BUN_FIXTURE_DOWNLOAD_STATUS"
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output="$2"; shift; fi
  shift
done
[ -n "$output" ]
cp "$BUN_FIXTURE_ARCHIVE" "$output"
`,
      { mode: 0o755 },
    ),
    writeFile(path.join(bin, "sha256sum"), '#!/bin/sh\nset -eu\nexec shasum -a 256 "$@"\n', { mode: 0o755 }),
  ])

  const productionSha = "1021798148d98705e8a448a3c8ec698ec144c66eb1e0f287927f05dbc459cbc7"
  if (!script.includes(productionSha) || !script.includes("39032147")) {
    throw new Error("the builder fixture requires the independently pinned Linux arm64 archive")
  }
  // Substitute only artifact data and its temporary root; run the real verification commands.
  return {
    script: script
      .replaceAll("39032147", String(bytes.length + (options.failure === BunFixtureFailure.Size ? 1 : 0)))
      .replace(productionSha, options.failure === BunFixtureFailure.Checksum ? "0".repeat(64) : sha256)
      .replace("/tmp/trellage-bun.XXXXXXXX", path.join(root, "bun.XXXXXXXX")),
    environment: {
      BUN_FIXTURE_ARCHIVE: archive,
      BUN_FIXTURE_DOWNLOAD_STATUS: options.failure === BunFixtureFailure.Download ? "25" : "0",
    },
  }
}
