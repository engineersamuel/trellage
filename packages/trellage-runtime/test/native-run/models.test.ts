import { afterEach, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { loadModelCatalog } from "../../src/native-run/models.ts"
import { cleanupFixtures, fixturePaths, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const body = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }))
const setup = async () => {
  const root = await tempRoot("models")
  const hostModelsPath = path.join(root, "models.json")
  await writeFile(
    hostModelsPath,
    JSON.stringify({ groups: { frontier: ["big", "gpt-6.1-sol", "gone"], "fast-efficient": ["tiny"], all: ["big", "tiny"] } }),
  )
  return { paths: await fixturePaths(root), hostModelsPath }
}

test("groups the endpoint models with frontier first and unknown models last", async () => {
  const options = await setup()
  const catalog = await loadModelCatalog({ ...options, fetchImpl: async () => body(["zzz", "tiny", "big", "gpt-6.1-sol"]) })
  expect(catalog.source).toBe("endpoint")
  expect(catalog.groups).toEqual([
    { title: "Frontier", models: ["gpt-6.1-sol"] },
    { title: "Balanced", models: ["big"] },
    { title: "Fast", models: ["tiny"] },
    { title: "Other", models: ["zzz"] },
  ])
})

test("falls back to the cached list, then the host list, when the endpoint is down", async () => {
  const options = await setup()
  const down = async () => {
    throw new Error("refused")
  }
  expect((await loadModelCatalog({ ...options, fetchImpl: down })).source).toBe("host-list")
  await loadModelCatalog({ ...options, fetchImpl: async () => body(["gpt-6.1-sol"]) })
  const cached = await loadModelCatalog({ ...options, fetchImpl: down })
  expect(cached.source).toBe("cache")
  expect(cached.groups).toEqual([{ title: "Frontier", models: ["gpt-6.1-sol"] }])
})
