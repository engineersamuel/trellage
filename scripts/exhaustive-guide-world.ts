import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { loadProfileGuideRegistry, profileGuideIdentityKey } from "@trellage/guide-core"
import { parseGuideCatalog } from "../packages/trellage-launcher/src/guide-catalog.ts"
import { loadGuideCatalogDomain } from "./exhaustive-guide-catalog.ts"

export const createGuideWorld = async () => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  const guideRoot = fileURLToPath(new URL("../profile-guides", import.meta.url))
  const domain = await loadGuideCatalogDomain()
  const identities = (domain.available as string[]).map((key: string) => {
    const [launcher, profile] = key.split("/")
    return { surface: "native", launcher: launcher!, profile: profile! } as const
  })
  const registry = await loadProfileGuideRegistry(guideRoot, identities)
  // Capability discovery is an explicit inert fixture here; authored guides are real.
  const catalog = parseGuideCatalog(
    JSON.stringify({
      schemaVersion: 1,
      native: identities.map((identity) => ({
        launcher: identity.launcher,
        harness: identity.launcher,
        name: identity.profile,
        description: "Offline generation contract fixture",
        headless: null,
        sandbox: false,
        herdrCompatibility: { status: "unsupported" },
        guide: registry.get(profileGuideIdentityKey(identity))!.guide,
        commandPath: "/fixture/bin/trx",
      })),
    }),
  )

  return { guideRoot, domain, catalog }
}
