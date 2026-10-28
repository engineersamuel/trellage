export const nativeHarnessPresets = {
  agency: ["azure"],
  claude: ["blog", "council", "default", "ecc", "frontend-design", "office", "office-charts", "research", "six-hats", "social-media"],
  codex: ["pstack", "superpowers", "youtube"],
  copilot: ["awesome", "compound-engineering", "hve", "plannotator", "superpowers", "tufte-vdqi"],
  fx: ["default"],
  headlong: ["default"],
  jcode: ["default"],
  omp: ["default", "local"],
  pi: ["default"],
  prime: ["default"],
  uji: ["default"],
  nodecode: ["default"],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>

/** Shipped profiles selected by their own name on every harness they list; a user profile of the same name wins. */
export const nativeSharedPresets: ReadonlyArray<string> = ["firstmate"]

export const nativePresetProfile = (harness: string, profile: string): string | undefined => {
  const profiles = Object.hasOwn(nativeHarnessPresets, harness)
    ? nativeHarnessPresets[harness as keyof typeof nativeHarnessPresets]
    : undefined
  return profiles?.includes(profile as never) ? `preset-${harness}-${profile}` : undefined
}

export const nativePresetProfiles = (harness: string): ReadonlyArray<string> =>
  Object.hasOwn(nativeHarnessPresets, harness)
    ? nativeHarnessPresets[harness as keyof typeof nativeHarnessPresets]
    : []
