import type { Domain } from "./matrix.ts"
import type { RunOptions } from "../../packages/trellage-runtime/src/native-run/run.ts"

/** Expected values are assembled from domain choices, not by tokenizing argv. */
export const runParserExpectation = (domains: readonly Domain[], choices: Readonly<Record<string, string>>) => {
  const selections = Object.fromEntries(
    domains.map((domain) => {
      const value = domain.values.find((candidate) => candidate.id === (choices[domain.name] ?? "omitted"))
      if (!value) throw new Error(`Unknown oracle choice ${domain.name}/${choices[domain.name]}`)
      return [domain.name, value]
    }),
  )
  const selected = Object.fromEntries(Object.entries(selections).map(([name, value]) => [name, value.argv]))
  const present = (name: string) => (selected[name]?.length ?? 0) > 0
  const argumentValues = (name: string): readonly string[] => {
    const values = selections[name]?.optionValues
    if (values === undefined) throw new Error(`Oracle domain ${name} must declare decoded option occurrences`)
    return values
  }
  const argumentValue = (name: string): string => {
    const value = argumentValues(name).at(-1)
    if (value === undefined) throw new Error(`Oracle domain ${name} requires a value argument`)
    return value
  }
  if (["--model", "--effort", "--skill"].some((name) => selections[name]?.valueClass === "missing-value"))
    return { rejection: "missing option value" } as const
  if (selections["--model"]?.valueClass === "empty") return { rejection: "empty model" } as const
  if (
    [
      "empty",
      "missing-name",
      "invalid-path",
      "invalid-owner",
      "invalid-dot-repository",
      "invalid-parent-repository",
      "invalid-earlier",
      "flag-shaped",
    ].includes(selections["--skill"]?.valueClass ?? "")
  )
    return { rejection: "invalid skill selector" } as const
  const [harness, ...profiles] = [...(selected.harness ?? []), ...(selected.profiles ?? [])]
  if (harness === undefined || harness === "") return { rejection: "missing harness" } as const
  if (harness.startsWith("-")) return { rejection: "router-only help flag" } as const
  let resume: RunOptions["resume"] = present("resume-id")
    ? { kind: "pick", id: selected["resume-id"]![0]!.slice("--resume=".length) }
    : present("--resume")
      ? { kind: "pick" }
      : present("--continue")
        ? { kind: "continue" }
        : undefined
  const resumeOrder = selections["resume-order"]?.id
  if (resumeOrder === "continue-pick-id" || resumeOrder === "pick-continue-id")
    resume = { kind: "pick", id: "session-2" }
  else if (resumeOrder === "continue-id-pick" || resumeOrder === "id-continue-pick") resume = { kind: "pick" }
  else if (resumeOrder === "pick-id-continue" || resumeOrder === "id-pick-continue") resume = { kind: "continue" }
  const isolationOrder = selections["isolation-order"]?.id
  const allowUnprovenIsolation =
    isolationOrder === "require-allow"
      ? true
      : isolationOrder === "allow-require"
        ? false
        : !present("--require-proven-isolation")
  return {
    expected: {
      harness,
      profiles,
      forwardedArgs: selected.forwarded?.slice(1) ?? [],
      dryRun: present("--dry-run"),
      noAlways: present("--no-always"),
      plan: present("--plan"),
      allowUnprovenIsolation,
      ...(present("--model") ? { model: argumentValue("--model") } : {}),
      ...(present("--effort") ? { effort: argumentValue("--effort") } : {}),
      ...(present("--skill") ? { skills: [...argumentValues("--skill")] } : {}),
      ...(resume ? { resume } : {}),
    },
  } as const
}
