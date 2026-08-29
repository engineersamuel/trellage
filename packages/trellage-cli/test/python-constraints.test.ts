import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { compilePythonConstraints } from "../src/python-constraints.js"

const originalPath = process.env.PATH
const originalUvIndex = process.env.UV_INDEX
const originalPipExtraIndex = process.env.PIP_EXTRA_INDEX_URL

afterEach(() => {
  process.env.PATH = originalPath
  if (originalUvIndex === undefined) delete process.env.UV_INDEX
  else process.env.UV_INDEX = originalUvIndex
  if (originalPipExtraIndex === undefined) delete process.env.PIP_EXTRA_INDEX_URL
  else process.env.PIP_EXTRA_INDEX_URL = originalPipExtraIndex
})

describe("Python constraint generation", () => {
  it("compiles floating inputs into exact hashed constraints in XDG staging", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-python-constraints-"))
    const bin = path.join(root, "bin")
    const argsLog = path.join(root, "args.log")
    await mkdir(bin)
    const mise = path.join(bin, "mise")
    await writeFile(
      mise,
      `#!/bin/sh
set -eu
[ "$UV_DEFAULT_INDEX" = "https://feed.test/pypi/simple/" ]
[ "$PIP_INDEX_URL" = "https://feed.test/pypi/simple/" ]
[ -z "\${UV_INDEX-}" ]
[ -z "\${PIP_EXTRA_INDEX_URL-}" ]
printf '%s\\n' "$@" >"${argsLog}"
output=
previous=
for argument do
  if [ "$previous" = "--output-file" ]; then output="$argument"; fi
  previous="$argument"
done
[ -n "$output" ]
printf '%s\\n' 'example==1.2.3 \\' '    --hash=sha256:${"a".repeat(64)}' >"$output"
`,
    )
    await chmod(mise, 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ""}`
    process.env.UV_INDEX = "https://ambient.invalid/simple/"
    process.env.PIP_EXTRA_INDEX_URL = "https://ambient.invalid/extra/"

    const constraints = await Effect.runPromise(
      compilePythonConstraints(
        {
          cacheHome: root,
          input: { kind: "requirements", requirements: ["example"] },
          uvVersion: "0.12.7",
          pythonVersion: "3.13",
          platform: "linux/arm64",
          npmRegistry: "https://packagefeedproxy.microsoft.io/npm/",
        },
        {
          discoverPypiIndex: async (options) => {
            expect(options?.npmRegistry).toBe("https://packagefeedproxy.microsoft.io/npm/")
            return "https://feed.test/pypi/simple/"
          },
        },
      ),
    )

    expect(constraints).toContain("example==1.2.3")
    const argumentLog = await readFile(argsLog, "utf8")
    expect(argumentLog).toContain("uv\n--no-config\npip\ncompile\n--prerelease\ndisallow\n--refresh\n")
    expect(argumentLog).toContain("--default-index\nhttps://feed.test/pypi/simple/\n")
    expect(argumentLog).toContain("--generate-hashes\n")
    expect(argumentLog).toContain("--python-version\n3.13\n")
    expect(argumentLog).toContain("--python-platform\naarch64-manylinux_2_28\n")
    expect(argumentLog).toContain("--output-file\n")
    await expect(readdir(path.join(root, "trellage", "constraints", "staging"))).resolves.toEqual([])
  })

  it("rejects unsafe requirement input before invoking uv", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-python-constraints-invalid-"))
    await expect(
      Effect.runPromise(
        compilePythonConstraints({
          cacheHome: root,
          input: { kind: "requirements", requirements: ["example @ file:///outside"] },
          uvVersion: "0.12.7",
          pythonVersion: "3.13",
          platform: "linux/arm64",
          pypiIndex: "https://feed.test/pypi/simple/",
        }),
      ),
    ).rejects.toThrow(/Python requirement input is invalid/)
  })

  it("rejects generated output that omits a declared requirement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-python-constraints-missing-"))
    const bin = path.join(root, "bin")
    await mkdir(bin)
    const mise = path.join(bin, "mise")
    await writeFile(
      mise,
      `#!/bin/sh
set -eu
previous=
for argument do
  if [ "$previous" = "--output-file" ]; then output="$argument"; fi
  previous="$argument"
done
printf '%s\\n' 'other==1.0.0 \\' '    --hash=sha256:${"b".repeat(64)}' >"$output"
`,
    )
    await chmod(mise, 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ""}`

    await expect(
      Effect.runPromise(
        compilePythonConstraints({
          cacheHome: root,
          input: { kind: "requirements", requirements: ["example"] },
          uvVersion: "0.12.7",
          pythonVersion: "3.13",
          platform: "linux/arm64",
          pypiIndex: "https://feed.test/pypi/simple/",
        }),
      ),
    ).rejects.toThrow(/generated Python constraints are invalid/)
  })
})
