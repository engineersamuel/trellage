import { readFile, writeFile, readdir, mkdir } from "node:fs/promises"
import path from "node:path"
import { readTrellageConfig } from "@trellage/runtime/native-config"

export const generateRunCatalogContent = async (options: { root: string; check: boolean }): Promise<void> => {
  const shippedConfigPath = path.join(options.root, "config.example.toml")
  const config = (
    await readTrellageConfig({ environment: { TRELLAGE_CONFIG: shippedConfigPath } })
  ).config.native
  const publish = async (file: string, expected: string) => {
    const actual = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    if (actual === expected) return
    if (options.check) throw new Error(`generated catalog content differs: ${path.relative(options.root, file)}`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, expected)
  }
  for (const family of await readdir(path.join(options.root, "prototypes"))) {
    if (!/^trellage-.+-profiles$/u.test(family)) continue
    const file = path.join(options.root, "prototypes", family, "catalog.json")
    const original = await readFile(file, "utf8").catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (original === undefined) continue
    const catalog = JSON.parse(original)
    const backend = family.slice(9, -9)
    const harness = backend === "picx" ? "pi" : backend
    for (const [name, record] of Object.entries(catalog.profiles) as Array<[string, { description: string }]>) {
      const description = config.profiles[`preset-${harness}-${name}`]?.selection?.description
      if (description !== undefined) record.description = description
    }
    await publish(file, JSON.stringify(catalog, null, 2) + "\n")
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== "--check") || args.length > 1)
    throw new Error("usage: generate-run-catalog-content.ts [--check]")
  await generateRunCatalogContent({ root: path.resolve(import.meta.dir, ".."), check: args.includes("--check") })
}
