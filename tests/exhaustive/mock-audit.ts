/** Keep unexpected mock calls visible even when production fallback logic catches their errors. */
export class MockAudit {
  private failure: Error | undefined
  private counts = new Map<string, number>()

  run<T>(operation: string, action: () => T): T {
    this.assertClean()
    this.counts.set(operation, (this.counts.get(operation) ?? 0) + 1)
    try {
      return action()
    } catch (cause) {
      this.failure = new Error(`Unexpected mock interaction: ${operation}`, { cause })
      throw this.failure
    }
  }

  assertClean(): void {
    if (this.failure) throw this.failure
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counts)
  }
}
