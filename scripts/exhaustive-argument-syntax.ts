import type { DomainValue } from "./exhaustive-cli-domains.ts"

export const argumentForms = [
  "canonical", "inline-values", "reverse-options", "repeat-booleans",
  "repeat-values", "missing-value", "unknown-option",
] as const
export type ArgumentForm = (typeof argumentForms)[number]

export const renderArgumentForm = (command: "run" | "guide", selected: ReadonlyMap<string, DomainValue>): string[] => {
  const form = selected.get("syntax")?.form ?? "canonical"
  const positionalNames = command === "run" ? ["harness", "profiles"] : ["positionals"]
  const positionals = positionalNames.flatMap(name => selected.get(name)?.argv ?? [])
  let groups = [...selected.entries()]
    .filter(([name]) => !positionalNames.includes(name) && name !== "syntax" && name !== "forwarded")
    .map(([, value]) => [...value.argv])
  if (form === "reverse-options") groups.reverse()
  if (form === "inline-values") groups = groups.map(group => {
    const result: string[] = []
    for (let index = 0; index < group.length; index++) {
      const token = group[index]!
      if (token.startsWith("--") && !token.includes("=") && index + 1 < group.length)
        result.push(`${token}=${group[++index]!}`)
      else result.push(token)
    }
    return result
  })
  if (form === "repeat-booleans") groups = groups.map(group =>
    group.length === 1 && !group[0]!.includes("=") ? [...group, ...group] : group)
  if (form === "repeat-values") groups = groups.map(group =>
    group.length > 1 || group[0]?.includes("=") ? [...group, ...group] : group)
  const options = groups.flat()
  if (form === "missing-value" && command === "run") options.push("--model")
  if (form === "unknown-option") options.push("--not-a-declared-option")
  return command === "run"
    ? [...positionals, ...options, ...(selected.get("forwarded")?.argv ?? [])]
    : [...options, ...positionals, ...(form === "missing-value" ? ["--model"] : [])]
}
