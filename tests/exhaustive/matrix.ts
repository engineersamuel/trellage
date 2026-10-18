export interface DomainValue {
  readonly id: string
  readonly argv: ReadonlyArray<string>
  readonly rootArgv?: ReadonlyArray<string>
  /** Decoded option occurrences declared by a syntax fixture, independent of the parser. */
  readonly optionValues?: ReadonlyArray<string>
  readonly valueClass?: string
}

export interface Domain {
  readonly name: string
  readonly values: ReadonlyArray<DomainValue>
}

export const matrixSize = (domains: ReadonlyArray<Domain>): bigint => {
  const names = new Set<string>()
  let size = 1n
  for (const domain of domains) {
    if (names.has(domain.name)) throw new Error(`Duplicate domain: ${domain.name}`)
    names.add(domain.name)
    if (domain.values.length === 0) throw new Error(`Domain ${domain.name} is empty`)
    const values = new Set<string>()
    for (const value of domain.values) {
      if (values.has(value.id)) throw new Error(`Duplicate value in ${domain.name}: ${value.id}`)
      values.add(value.id)
    }
    size *= BigInt(domain.values.length)
  }
  return size
}

export function* cartesianCases(
  command: string,
  domains: ReadonlyArray<Domain>,
  range?: { readonly start: bigint; readonly end: bigint },
): Generator<{
  readonly id: string
  readonly argv: string[]
  readonly rootArgv: string[]
  readonly values: Record<string, string>
}> {
  const size = matrixSize(domains)
  const start = range?.start ?? 0n
  const end = range?.end ?? size
  if (start < 0n || end < start || end > size) throw new Error("Invalid matrix range")
  for (let ordinal = start; ordinal < end; ordinal++) {
    let remaining = ordinal
    const selected: DomainValue[] = new Array(domains.length)
    for (let index = domains.length - 1; index >= 0; index--) {
      const domain = domains[index]!
      const width = BigInt(domain.values.length)
      selected[index] = domain.values[Number(remaining % width)]!
      remaining /= width
    }
    yield {
      id: `${command}:${ordinal}`,
      argv: selected.flatMap((value) => value.argv),
      rootArgv: selected.flatMap((value) => value.rootArgv ?? []),
      values: Object.fromEntries(domains.map((domain, index) => [domain.name, selected[index]!.id])),
    }
  }
}
