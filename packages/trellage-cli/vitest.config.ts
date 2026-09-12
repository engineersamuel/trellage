import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    cache: false,
    setupFiles: [fileURLToPath(new URL("../../tests/bun-runtime.setup.ts", import.meta.url))],
  },
})
