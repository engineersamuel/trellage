import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { loadCompositionCatalog } from "../packages/trellage-launcher/src/composition-catalog.ts"
import { loadGuideCatalogDomain } from "./exhaustive-guide-catalog.ts"

export const createGuideWorld = async () => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  const guideRoot = fileURLToPath(new URL("../profile-guides", import.meta.url))
  const domain = await loadGuideCatalogDomain()
  const composition = await loadCompositionCatalog({ guideRoot, commandPath: "/fixture/bin/trx" })
  const catalog = {
    ...composition,
    native: composition.entries.flatMap((entry) => entry.guide === null ? [] : [{
      ...entry, launcher: entry.harness, name: entry.profiles[0]!, guide: entry.guide,
    }]),
  }
  return { guideRoot, domain, catalog }
}
