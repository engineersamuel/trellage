import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/vitest-setup.ts"],
    server: { deps: { inline: ["foldkit", "@foldkit/ui", "@plana-solutions/agent-interface"] } },
  },
  resolve: { dedupe: ["effect"] },
});
