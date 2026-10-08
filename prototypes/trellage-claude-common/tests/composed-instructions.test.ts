import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { publishCompositionInstructions } from "../native-skills.ts"

test("composed Copilot instructions preserve user files and reject an unowned destination", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trellage-instructions-")))
  const priorHarness = process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
  const priorSnapshot = process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
  try {
    const cache = path.join(root, "snapshot")
    const home = path.join(root, "home")
    await mkdir(cache)
    await mkdir(path.join(home, "instructions"), { recursive: true })
    await writeFile(path.join(cache, "always-on.md"), "Selected instructions.")
    await writeFile(path.join(home, "instructions/user.instructions.md"), "My instructions.")
    process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = "copilot"
    process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = cache
    const destination = path.join(home, "instructions/trellage-selected.instructions.md")
    await writeFile(destination, "Unowned content")
    await expect(publishCompositionInstructions(cache, path.join(home, "skills"))).rejects.toThrow("refusing to replace user instructions")
    await rm(destination)
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    expect(await readFile(destination, "utf8")).toContain("Selected instructions.")
    expect(await readFile(path.join(home, "instructions/user.instructions.md"), "utf8")).toBe("My instructions.")
    await writeFile(path.join(cache, "always-on.md"), "")
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    expect(await readFile(destination, "utf8")).not.toContain("Selected instructions.")
  } finally {
    if (priorHarness === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
    else process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = priorHarness
    if (priorSnapshot === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
    else process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = priorSnapshot
    await rm(root, { recursive: true, force: true })
  }
})
test("JCode composition replaces only its managed instruction block", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trellage-jcode-instructions-")))
  const priorHarness = process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
  const priorSnapshot = process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
  try {
    const cache = path.join(root, "snapshot")
    const home = path.join(root, "home")
    await mkdir(cache)
    await mkdir(home)
    const destination = path.join(home, "prompt-overlay.md")
    await writeFile(destination, "User prefix.\n")
    await writeFile(path.join(cache, "always-on.md"), "First selection.")
    process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = "jcode"
    process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = cache
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    await writeFile(destination, (await readFile(destination, "utf8")) + "User suffix.\n")
    await writeFile(path.join(cache, "always-on.md"), "Second selection.")
    await publishCompositionInstructions(cache, path.join(home, "skills"))
    const updated = await readFile(destination, "utf8")
    expect(updated).toStartWith("User prefix.\n")
    expect(updated).toEndWith("User suffix.\n")
    expect(updated).toContain("Second selection.")
    expect(updated).not.toContain("First selection.")
  } finally {
    if (priorHarness === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS
    else process.env.TRELLAGE_NATIVE_COMPOSITION_HARNESS = priorHarness
    if (priorSnapshot === undefined) delete process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT
    else process.env.TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT = priorSnapshot
    await rm(root, { recursive: true, force: true })
  }
})

test("Codex preserves YouTube argv and adds valid TOML composition instructions", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "trellage-codex-instructions-")))
  try {
    const source = await readFile(new URL("../../trellage-codex-common/native-codex", import.meta.url), "utf8")
    const extract = (name: string) => {
      const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"))
      if (!match) throw new Error(`Missing shell function ${name}`)
      return match[0]
    }
    const builtin = source.match(/^youtube_developer_instructions='(.*)'$/m)![1]
    const catalog = path.join(root, "catalog.json")
    await writeFile(catalog, JSON.stringify({ profiles: {
      youtube: { requiredEnvironment: ["TRANSCRIPT_API_KEY"] },
      pstack: { requiredEnvironment: [] },
    } }))
    const selected = 'Selected "instructions" with \\paths.\nSecond line.\tTabbed\rReturn'
    await writeFile(path.join(root, "always-on.md"), selected)
    const argsFor = async (profile: string, snapshot: string) => {
      const command = [
        "set -eo pipefail",
        'catalog="$1"',
        'youtube_developer_instructions="$2"',
        'TRELLAGE_NATIVE_COMPOSITION_SNAPSHOT="$3"',
        'die() { printf "%s\\n" "$*" >&2; exit 1; }',
        extract("toml_escape_basic_string"),
        extract("build_profile_codex_args"),
        'build_profile_codex_args "$4"',
        'jq -cn --args \'$ARGS.positional\' -- "${profile_codex_args[@]}"',
      ].join("\n")
      const child = Bun.spawn(["bash", "-c", command, "fixture", catalog, builtin, snapshot, profile], {
        stdout: "pipe", stderr: "pipe",
      })
      const result = await new Response(child.stdout).text()
      const diagnostic = await new Response(child.stderr).text()
      expect(await child.exited, diagnostic).toBe(0)
      return JSON.parse(result) as string[]
    }
    const plain = await argsFor("youtube", "")
    expect(plain).toEqual([
      "-c", "shell_environment_policy.inherit=all",
      "-c", "shell_environment_policy.ignore_default_excludes=true",
      "-c", 'shell_environment_policy.include_only=["PATH","SHELL","HOME","USER","LOGNAME","TMPDIR","TEMP","TMP","LANG","LC_*","TERM","COLORTERM","NO_COLOR","HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy","SSL_CERT_FILE","SSL_CERT_DIR","CURL_CA_BUNDLE","XDG_CONFIG_HOME","XDG_CACHE_HOME","XDG_DATA_HOME","TRANSCRIPT_API_KEY"]',
      "-c", `developer_instructions="${builtin}"`,
    ])
    const composed = await argsFor("youtube", root)
    expect(composed.slice(0, 7)).toEqual(plain.slice(0, 7))
    expect(Bun.TOML.parse(composed[7]).developer_instructions).toBe(`${builtin}\n\n${selected}`)
    expect(await argsFor("pstack", "")).toEqual([])
    const regular = await argsFor("pstack", root)
    expect(regular).toHaveLength(2)
    expect(regular[0]).toBe("-c")
    expect(Bun.TOML.parse(regular[1]).developer_instructions).toBe(selected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
