import { readTrellageConfig } from "@trellage/runtime/native-config"
import { expect, it } from "vitest"
import { fileURLToPath } from "node:url"

it("ships ub-mode as an always-on Claude profile", async () => {
  const config = await readTrellageConfig({
    environment: {
      TRELLAGE_CONFIG: fileURLToPath(new URL("../../../config.example.toml", import.meta.url)),
    },
  })
  expect(config.config.native.sources["ub-mode"]?.repository).toBe("unclebob/ub-mode")
  expect(config.config.native.profiles["claude-ub-mode"]).toMatchObject({
    always: true,
    harnesses: ["claude"],
    skills: [{ source: "ub-mode", names: ["ub-mode"] }],
  })
})
