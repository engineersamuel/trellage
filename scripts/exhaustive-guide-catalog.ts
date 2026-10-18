import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { loadCompositionCatalog } from "../packages/trellage-launcher/src/composition-catalog.ts"

const root = new URL("../", import.meta.url)
export const loadGuideCatalogDomain = async () => {
  const sourceHashes: Record<string, string> = {}
  const read = async (name: string): Promise<void> => {
    sourceHashes[name] = createHash("sha256").update(await readFile(new URL(name, root))).digest("hex")
  }
  for (const name of ["config.example.toml", "prototypes/trellage-router/bin/trx",
    "packages/trellage-launcher/src/composition-catalog.ts", "packages/trellage-launcher/src/run-catalog.ts",
    "packages/trellage-runtime/src/native-run/presets.ts", "docs/herdr-compatibility.json"])
    await read(name)
  for (const harness of await readdir(new URL("profile-guides/native/", root)))
    for (const name of await readdir(new URL(`profile-guides/native/${harness}/`, root)))
      if (name.endsWith(".md")) await read(`profile-guides/native/${harness}/${name}`)
  const catalog = await loadCompositionCatalog({
    guideRoot: fileURLToPath(new URL("profile-guides", root)), commandPath: "/fixture/bin/trx",
  })
  const key = (entry: typeof catalog.entries[number]) => `${entry.harness}/${entry.profiles.join("+")}`
  return {
    declared: catalog.entries.map(key).sort(),
    available: catalog.entries.filter((entry) => entry.guide !== null).map(key).sort(),
    sourceHashes,
  }
}

if (import.meta.main) console.log(JSON.stringify(await loadGuideCatalogDomain(), null, 2))
