import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // shared/ sits outside this app: resolve its "effect" imports to this app's copy, so one runtime runs.
  resolve: { dedupe: ["effect"] },
  server: { allowedHosts: [".ts.net", "100.69.199.42"], proxy: { "/api": "http://127.0.0.1:7700" }, fs: { allow: [".."] } },
  build: {
    rollupOptions: {
      input: { index: "index.html", copilotkit: "copilotkit.html" },
    },
  },
});
