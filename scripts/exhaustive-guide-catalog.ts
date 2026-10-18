import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { canonicalNativeIdentity } from "@trellage/guide-core"
import { enrichNativeProfileList } from "../packages/trellage-launcher/src/native-guide-list.ts"

const root = new URL("../", import.meta.url)
export const loadGuideCatalogDomain = async () => {
  const sourceHashes: Record<string, string> = {}
  const read = async (name: string): Promise<string> => {
    const content = await readFile(new URL(name, root), "utf8")
    sourceHashes[name] = createHash("sha256").update(content).digest("hex")
    return content
  }
  const router = await read("prototypes/trellage-router/bin/trx")
  const profiles: { launcher: string; name: string }[] = []
  const catalogs = [...router.matchAll(/^read_canonical_catalog ([a-z]+) ([a-z-]+) [a-z]+ >"\$catalog_tmp\/[a-z]+"$/gm)]
  if (!catalogs.length) throw new Error("Cannot find the router's canonical catalogs")
  for (const [, harness, directory] of catalogs) {
    const catalog = JSON.parse(await read(`prototypes/${directory}/catalog.json`))
    const names = Array.isArray(catalog.profiles)
      ? catalog.profiles.map((profile: { name: string }) => profile.name)
      : Object.keys(catalog.profiles)
    for (const name of names) {
      const identity = canonicalNativeIdentity(harness!, name)
      profiles.push({ launcher: identity.launcher, name: identity.profile })
    }
  }
  const inline = [...router.matchAll(/^[a-z]+_catalog='(\{"schemaVersion":1,[^\n]+\})'$/gm)]
  if (!inline.length) throw new Error("Cannot find the router's inline catalogs")
  for (const [, source] of inline) {
    const catalog = JSON.parse(source!)
    for (const profile of catalog.profiles) profiles.push({ launcher: catalog.harness, name: profile.name })
  }
  const firstmate = [...router.matchAll(/then firstmateProfile\("([a-z]+)"\)/g)]
  if (!firstmate.length) throw new Error("Cannot find the router's Firstmate profiles")
  for (const [, harness] of firstmate) profiles.push({ launcher: harness!, name: "firstmate" })
  const keys = profiles.map(({ launcher, name }) => `${launcher}/${name}`)
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate router profile identities")
  const guideRoot = fileURLToPath(new URL("profile-guides", root))
  const enriched = JSON.parse(await enrichNativeProfileList(JSON.stringify({ schemaVersion: 1, profiles }), guideRoot))
  for (const profile of enriched.profiles) await read(`profile-guides/native/${profile.launcher}/${profile.name}.md`)
  await read("packages/trellage-launcher/src/native-guide-list.ts")
  await read("packages/trellage-guide-core/src/native-identity.ts")
  return {
    declared: keys.sort(),
    available: enriched.profiles.map((profile: { launcher: string; name: string }) => `${profile.launcher}/${profile.name}`).sort(),
    sourceHashes,
  }
}

if (import.meta.main) console.log(JSON.stringify(await loadGuideCatalogDomain(), null, 2))
