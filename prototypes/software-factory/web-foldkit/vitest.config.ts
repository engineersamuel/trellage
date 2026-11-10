import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "happy-dom",
    // Let Happy DOM provide storage instead of Node's file-backed Web Storage.
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/vitest-setup.ts"],
    server: { deps: { inline: ["foldkit", "@foldkit/ui", "@plana-solutions/agent-interface"] } },
  },
  resolve: { dedupe: ["effect"] },
})
