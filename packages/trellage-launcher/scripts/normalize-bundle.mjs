import { readFile, writeFile } from "node:fs/promises"

const bundleUrl = new URL("../dist/launcher.mjs", import.meta.url)
const bundle = await readFile(bundleUrl, "utf8")
const normalizedBundle = bundle.replace(/[ \t]+$/gm, "")

if (bundle !== normalizedBundle) {
  await writeFile(bundleUrl, normalizedBundle)
}
