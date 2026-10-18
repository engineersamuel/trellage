import assert from "node:assert/strict"
import { forkPreviewVariants } from "../packages/trellage-launcher/src/fork-preview.tsx"
import { loadCliDomains, type CliDomain, type DomainValue } from "./exhaustive-cli-domains.ts"

const value = (id: string, ...argv: string[]): DomainValue => ({ id, argv })
const omitted = value("omitted")
const permutations = (names: readonly string[]): string[][] => names.length === 0 ? [[]]
  : names.flatMap(name => permutations(names.filter(other => other !== name)).map(rest => [name, ...rest]))

export const loadPreviewDomains = async () => {
  const { guide, sourceHashes } = await loadCliDomains()
  const help: CliDomain = { name: "help", rationale: "Omission, both declared help aliases, repeated and combined help aliases.",
    values: [omitted, value("short", "-h"), value("long", "--help"), value("repeat-short", "-h", "-h"),
      value("repeat-long", "--help", "--help"), value("both", "-h", "--help")] }
  const foreign: CliDomain = { name: "foreign", rationale: "One extraneous input group: ordinary, empty, whitespace, Unicode, 256 characters, help word, unknown flag, separator, and every ordinary Guide flag. This axis does not establish combinations of ordinary Guide options.",
    values: [omitted, value("ordinary", "prompt"), value("empty", ""), value("whitespace", " \t "),
      value("unicode", "模型"), value("long", "a".repeat(256)), value("help-word", "help"),
      value("unknown", "--unknown"), value("separator", "--"),
      ...guide.filter(domain => domain.name.startsWith("--") && domain.name !== "--help").map(domain => {
        const selected = domain.values.find(item => item.argv.length > 0)!
        return value(domain.name, ...selected.argv)
      })] }
  const order = (groups: string[]): CliDomain => ({ name: "order",
    rationale: "Every permutation of argument groups, including help before and after invalid inputs. Empty groups can render identical argv but retain distinct tuple IDs.",
    values: permutations(groups).map(names => value(names.join(","))) })
  const basket: CliDomain[] = [
    { name: "flag", rationale: "Preview omitted, present, repeated, and unsupported inline values.", values: [omitted,
      value("present", "--preview"), value("repeated", "--preview", "--preview"),
      value("inline-empty", "--preview="), value("inline-value", "--preview=fixture")] },
    help, { ...foreign, values: [...foreign.values, value("forks", "--forks"),
      ...forkPreviewVariants.map(variant => value(`variant-${variant}`, variant))] },
    order(["flag", "help", "foreign"]),
  ]
  const fork: CliDomain[] = [
    { name: "flag", rationale: "Fork flag omitted, present, repeated, and inline values for all variants plus empty and invalid values.",
      values: [omitted, value("present", "--forks"), value("repeated", "--forks", "--forks"),
        value("inline-empty", "--forks="), value("inline-invalid", "--forks=unknown"),
        ...forkPreviewVariants.map(variant => value(`inline-${variant}`, `--forks=${variant}`))] },
    { name: "variant", rationale: "Omission, every production variant, invalid open text and all ordered pairs including repeated and conflicting variants.",
      values: [omitted, ...forkPreviewVariants.map(variant => value(variant, variant)), value("empty", ""),
        value("whitespace", " \t "), value("unknown", "unknown"), value("unicode", "模型"), value("long", "a".repeat(256)),
        ...forkPreviewVariants.flatMap(left => forkPreviewVariants.map(right => value(`${left},${right}`, left, right)))] },
    help, { ...foreign, values: [...foreign.values, value("preview", "--preview")] },
    order(["flag", "variant", "help", "foreign"]),
  ]
  for (const domains of [basket, fork]) for (const domain of domains) {
    assert.equal(new Set(domain.values.map(item => item.id)).size, domain.values.length, `duplicate IDs: ${domain.name}`)
  }
  return { basket, fork, sourceHashes }
}

export const renderPreviewArguments = (selected: ReadonlyMap<string, DomainValue>): string[] =>
  selected.get("order")!.id.split(",").flatMap(name => selected.get(name)!.argv)

export const assertPreviewSourcesUnchanged = async (hashes: Readonly<Record<string, string>>): Promise<void> => {
  assert.deepEqual((await loadPreviewDomains()).sourceHashes, hashes, "preview production or verification sources changed")
}
