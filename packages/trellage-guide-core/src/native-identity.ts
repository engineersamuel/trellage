/** Historical persisted names are read here; every newly emitted identity is canonical. */
export const canonicalNativeIdentity = (launcher: string, profile: string): { launcher: string; profile: string } => {
  const aliases: Readonly<Record<string, string>> = { agx: "agency", cdx: "codex", cpx: "copilot", cldx: "claude", fmx: "firstmate", jcx: "jcode", picx: "pi", prx: "prime", "agency-copilot": "agency", "oh-my-pi": "omp" }
  const harness = aliases[launcher] ?? launcher
  return { launcher: harness, profile: harness === "agency" && profile === "trellage-azure" ? "azure" : harness === "omp" && profile === "copilot" ? "default" : profile }
}

export const canonicalProfileRef = (ref: string): string => {
  const match = /^native:([^/]+)\/(.+)$/u.exec(ref)
  if (!match) return ref
  const identity = canonicalNativeIdentity(match[1]!, match[2]!)
  return `native:${identity.launcher}/${identity.profile}`
}
