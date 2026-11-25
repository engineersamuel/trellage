import { foldkit } from "@foldkit/vite-plugin"
import { defineConfig } from "vite"

// SF_ADDR is the coordinator of this instance (instance.sh: 7700 in the main checkout, its own port in a worktree).
export default defineConfig({
  // View identity for the differ, and Model preservation across hot reloads.
  plugins: [foldkit()],
  server: {
    allowedHosts: [".ts.net", "100.69.199.42"],
    proxy: { "/api": `http://${process.env.SF_ADDR ?? "127.0.0.1:7700"}` },
    fs: { allow: [".."] },
  },
  // Pre-bundle the lazy highlighter before the first code block mounts.
  optimizeDeps: { exclude: ["lucide"], include: ["refractor/all"] },
  // shared/ sits outside this app: resolve its "effect" imports to this app's copy, so one runtime runs.
  resolve: { dedupe: ["effect"] },
  build: { target: "es2022" },
})
