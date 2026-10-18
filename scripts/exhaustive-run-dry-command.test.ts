import { expect, test } from "bun:test"
import { adapters, parseRunArguments, prepareRun, runNative } from "@trellage/runtime/native-run"
import { assertRunCommand, decodeRunCommand } from "./exhaustive-run-command.ts"
import { createRunWorld } from "./exhaustive-run-world.ts"

// Parse as data: never execute the displayed command or shell expansions.
const shellWords = (command: string): string[] => {
  const result = Bun.spawnSync(
    ["python3", "-c", "import json,shlex,sys; print(json.dumps(shlex.split(sys.stdin.read())))"],
    { stdin: Buffer.from(command), stdout: "pipe", stderr: "pipe" },
  )
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString())
}

for (const harness of Object.keys(adapters).sort())
  test(`${harness}: dry command round-trips shell-sensitive argument values without launching`, async () => {
    const world = await createRunWorld(harness)
    try {
      const forwarded = [
        "space value",
        "",
        "*",
        "single'quote",
        'double"quote',
        "$(exit 97)",
        "`exit 98`",
        "a\nb",
        "\\",
        "模型",
      ]
      const options = parseRunArguments([harness, "--no-always", "--dry-run", "--", ...forwarded])
      const prepared = await prepareRun(options, world.dependencies)
      await world.resetEvidence()
      expect(await runNative(options, world.dependencies)).toBe(0)
      const commands = world.lines.filter((line) => line.startsWith("Command     "))
      expect(commands).toHaveLength(1)
      const decoded = shellWords(commands[0]!.slice("Command     ".length))
      assertRunCommand(options, world.lines, harness)
      expect(decodeRunCommand(commands[0]!.slice("Command     ".length))).toEqual(decoded)
      expect(decoded).toEqual([prepared.launch.command, ...prepared.launch.args])
      expect(decoded.slice(-forwarded.length)).toEqual(forwarded)
      expect(world.launches).toEqual([])
      expect(world.unexpected).toEqual([])
    } finally {
      await world.close()
    }
  }, 120000)

test("displayed command rejects lost arguments, changed values and executable shell expressions", () => {
  expect(decodeRunCommand("ab\\\ncd")).toEqual(["abcd"])
  expect(() =>
    assertRunCommand(parseRunArguments(["codex", "--", "ab\ncd"]), ["Command     codex ab\\\ncd"], "line continuation"),
  ).toThrow()
  const options = parseRunArguments(["codex", "--model", "fixture", "--effort", "high", "--", "space value", ""])
  const command = `codex -m fixture -c 'model_reasoning_effort="high"' 'space value' ''`
  assertRunCommand(options, [`Command     ${command}`], "valid")
  for (const changed of [
    command.replace("-m fixture", "-m substituted"),
    command.replace('"high"', '"low"'),
    command.slice(0, -3),
    command.replace("'space value'", "space value"),
    command + " $(exit 97)",
  ])
    expect(() => assertRunCommand(options, [`Command     ${changed}`], "mutation")).toThrow()
  for (const invalid of ["'unterminated", "trailing\\", "$(exit)", "*", "`exit`"])
    expect(() => decodeRunCommand(invalid)).toThrow()
})
