import assert from "node:assert/strict"
import type { RunOptions } from "@trellage/runtime/native-run"

/** Decode literal shell words without evaluating substitutions or expansions. */
export const decodeRunCommand = (source: string): string[] => {
  const words: string[] = []
  let word = "",
    started = false,
    quoted = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (quoted) {
      if (char === "'") quoted = false
      else word += char
    } else if (char === "'") {
      quoted = true
      started = true
    } else if (char === "\\") {
      assert(index + 1 < source.length, "unterminated escape")
      const escaped = source[++index]!
      if (escaped === "\n") continue
      word += escaped
      started = true
    } else if (char === " ") {
      if (started) words.push(word)
      word = ""
      started = false
    } else {
      assert.match(char, /^[A-Za-z0-9_@%+=:,./-]$/, "unquoted shell expression")
      word += char
      started = true
    }
  }
  assert(!quoted, "unterminated quote")
  if (started) words.push(word)
  return words
}

export const expectedRunSuffix = (options: RunOptions): string[] => {
  const harness = options.harness
  let resume: string[] = []
  if (options.resume) {
    const continuation = options.resume.kind === "continue",
      session = options.resume.kind === "pick" ? options.resume.id : undefined
    if (harness === "codex") resume = continuation ? ["resume", "--last"] : session ? ["resume", session] : ["resume"]
    else if (harness === "uji") resume = !continuation && session ? ["resume", "--id", session] : ["resume"]
    else if (harness === "copilot")
      resume = continuation ? ["--continue"] : session ? [`--resume=${session}`] : ["--resume"]
    else resume = continuation ? ["--continue"] : session ? ["--resume", session] : ["--resume"]
  }
  const forwarded =
    harness === "copilot" ? options.forwardedArgs.filter((arg) => arg !== "--plan") : [...options.forwardedArgs]
  return harness === "uji"
    ? [...(resume.length ? resume : ["new"]), ...forwarded]
    : harness === "codex" && resume.length && forwarded[0] === "exec"
      ? ["exec", ...resume, ...forwarded.slice(1)]
      : [...resume, ...forwarded]
}

export const assertRunCommand = (options: RunOptions, lines: readonly string[], id: string): void => {
  const commands = lines.filter((line) => line.startsWith("Command     "))
  assert.equal(commands.length, 1, id)
  const [executable, ...args] = decodeRunCommand(commands[0]!.slice("Command     ".length))
  assert(executable, `${id}: missing executable`)
  const suffix = expectedRunSuffix(options)
  if (suffix.length) assert.deepEqual(args.slice(-suffix.length), suffix, `${id}: displayed argument suffix`)
  const prefix = suffix.length ? args.slice(0, -suffix.length) : args
  const value = (flag: string, expected: string) => {
    const positions = prefix.flatMap((arg, index) => (arg === flag ? [index] : []))
    assert.equal(positions.length, 1, `${id}: displayed ${flag} count`)
    assert.equal(prefix[positions[0]! + 1], expected, `${id}: displayed ${flag} value`)
  }
  const { harness, model, effort } = options
  if (model !== undefined && !["fx", "headlong", "jcode", "uji"].includes(harness))
    value(
      harness === "codex" ? "-m" : "--model",
      harness === "omp" && !model.includes("/") ? `github-copilot/${model}` : model,
    )
  if (effort !== undefined) {
    if (harness === "codex")
      assert.deepEqual(
        prefix.filter((arg) => arg.startsWith("model_reasoning_effort=")),
        [`model_reasoning_effort="${effort}"`],
        `${id}: displayed effort`,
      )
    else if (["agency", "claude", "copilot", "fx", "grok", "omp", "pi"].includes(harness))
      value(
        harness === "grok" ? "--reasoning-effort" : ["omp", "pi"].includes(harness) ? "--thinking" : "--effort",
        effort,
      )
  }
}
