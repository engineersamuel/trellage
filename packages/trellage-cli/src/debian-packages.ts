import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { Data, Effect } from "effect"

import type { OciImageLock, RuntimePackageLock } from "./lock.js"
import type { Platform } from "./platform.js"

const execFilePromise = promisify(execFile)
const packageNamePattern = /^[a-z0-9][a-z0-9+.-]*$/
const sha256Pattern = /^[0-9a-f]{64}$/

export class DebianPackageError extends Data.TaggedError("DebianPackageError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface DebianPackageResolution {
  readonly direct: ReadonlyArray<string>
  readonly runtime: ReadonlyArray<RuntimePackageLock>
}

const imageReference = (base: OciImageLock): string => {
  const repository = base.reference.split(":", 1)[0]!
  return `${base.reference.includes("/") ? repository : `docker.io/library/${repository}`}@${base.digest}`
}

const resolverScript = `
set -eu
export LC_ALL=C
apt-get update >/dev/null
requested=" $* "
for package do
  if dpkg-query -W -f='\${Status}' "$package" 2>/dev/null | grep -Fqx 'install ok installed'; then
    printf 'BASE\\t%s\\n' "$package"
  fi
done
apt-get --simulate --no-install-recommends install "$@" \
  | sed -n 's/^Inst \\([^ ]*\\) (\\([^ ]*\\).*/\\1\\t\\2/p' \
  | while IFS="$(printf '\\t')" read -r resolved version; do
  package="\${resolved%%:*}"
  [ -n "$version" ] && [ "$version" != "(none)" ]
  metadata="$(apt-cache show --no-all-versions "$package=$version")"
  sha256="$(printf '%s\\n' "$metadata" | sed -n 's/^SHA256: //p' | head -n 1)"
  size="$(printf '%s\\n' "$metadata" | sed -n 's/^Size: //p' | head -n 1)"
  uri="$(apt-get --print-uris download "$package=$version" 2>/dev/null | sed -n "s/^'\\([^']*\\)'.*/\\1/p" | head -n 1)"
  [ -n "$sha256" ] && [ -n "$size" ] && [ -n "$uri" ]
  direct=false
  case "$requested" in *" $package "*) direct=true ;; esac
  printf 'PKG\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$package" "$version" "$sha256" "$size" "$uri" "$direct"
done
`

const parseLine = (line: string): RuntimePackageLock => {
  const [recordType, name, version, digest, sizeSource, url, directSource] = line.split("\t")
  const size = Number(sizeSource)
  if (
    recordType !== "PKG" ||
    name === undefined ||
    version === undefined ||
    digest === undefined ||
    url === undefined ||
    !packageNamePattern.test(name) ||
    version.length === 0 ||
    !sha256Pattern.test(digest) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !/^https?:\/\/(?:deb|security)\.debian\.org\//.test(url) ||
    (directSource !== "true" && directSource !== "false")
  ) {
    throw new Error(`invalid Debian package resolution: ${line}`)
  }
  const normalizedUrl = new URL(url)
  normalizedUrl.protocol = "https:"
  return {
    name,
    version,
    integrity: `sha256:${digest}`,
    size,
    url: normalizedUrl.toString(),
    direct: directSource === "true",
  }
}

export const resolveDebianPackages = (
  packages: ReadonlyArray<string>,
  base: OciImageLock,
  platform: Platform,
): Effect.Effect<DebianPackageResolution, DebianPackageError> => {
  if (!packages.every((name) => packageNamePattern.test(name))) {
    return Effect.fail(new DebianPackageError({ message: "Debian package name is invalid" }))
  }
  if (packages.length === 0) return Effect.succeed({ direct: [], runtime: [] })
  return Effect.tryPromise({
    try: async (signal) => {
      const { stdout } = await execFilePromise(
        "docker",
        ["run", "--rm", "--platform", platform, imageReference(base), "sh", "-ceu", resolverScript, "sh", ...packages],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, signal },
      )
      const lines = stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
      const baseProvided = new Set(
        lines.filter((line) => line.startsWith("BASE\t")).map((line) => line.slice("BASE\t".length)),
      )
      const resolved = lines
        .filter((line) => line.startsWith("PKG\t"))
        .map(parseLine)
        .sort((left, right) => left.name.localeCompare(right.name, "en"))
      const resolvedNames = new Set(resolved.map(({ name }) => name))
      if (
        resolvedNames.size !== resolved.length ||
        packages.some((name) => !baseProvided.has(name) && !resolvedNames.has(name)) ||
        resolved.some((entry) => entry.direct === true && !packages.includes(entry.name))
      ) {
        throw new Error("Debian package dependency closure is incomplete")
      }
      return { direct: packages, runtime: resolved }
    },
    catch: (cause) => new DebianPackageError({ message: "cannot resolve Debian runtime packages", cause }),
  })
}
