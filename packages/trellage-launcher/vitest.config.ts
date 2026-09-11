import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Make already runs four targets; each PTY test also starts a Node process.
    maxWorkers: 2,
  },
})
