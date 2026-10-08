export const canonicalNativeIdentity = (launcher: string, profile: string): { launcher: string; profile: string } => {
  return { launcher, profile }
}

export const canonicalProfileRef = (ref: string): string => {
  const match = /^native:([^/]+)\/(.+)$/u.exec(ref)
  if (!match) return ref
  const identity = canonicalNativeIdentity(match[1]!, match[2]!)
  return `native:${identity.launcher}/${identity.profile}`
}
