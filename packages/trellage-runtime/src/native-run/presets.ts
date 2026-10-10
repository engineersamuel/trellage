export const nativeHarnessPresets = {
  agency: ["azure"],
  claude: ["default", "office", "office-charts"],
  codex: ["pstack", "superpowers", "youtube"],
  copilot: ["awesome", "compound-engineering", "hve", "plannotator", "superpowers", "tufte-vdqi"],
  firstmate: ["default", "pstack-workers"],
  fx: ["default"],
  jcode: ["default"],
  omp: ["default", "local"],
  pi: ["default"],
  prime: ["default"],
} as const satisfies Readonly<Record<string, ReadonlyArray<string>>>

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
