export const canonicalNativeIdentity = (launcher: string, profile: string): { launcher: string; profile: string } => {
  const canonicalProfile =
    launcher === "agency" && profile === "trellage-azure"
      ? "azure"
      : launcher === "omp" && profile === "copilot"
        ? "default"
        : profile
  return { launcher, profile: canonicalProfile }
}

export const canonicalProfileRef = (ref: string): string => {
  const match = /^native:([^/]+)\/(.+)$/u.exec(ref)
  if (!match) return ref
  const identity = canonicalNativeIdentity(match[1]!, match[2]!)
  return `native:${identity.launcher}/${identity.profile}`
}
