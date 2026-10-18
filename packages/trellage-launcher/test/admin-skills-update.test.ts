import { describe, expect, it } from "vitest"
import {
  nativeSkillsUpdateCommand,
  nativeSkillsUpdatePlanFor,
} from "../src/admin-skills-update.ts"
import type { AdminProfileEntry } from "../src/admin-model.ts"

const entry = (launcher: string): AdminProfileEntry => ({
  ref: `native:${launcher}/default`,
  surface: "native",
  launcher,
  harness: launcher,
  name: "default",
  profiles: ["default"],
  lifecycle: launcher === "headlong" ? null : { runtime: launcher, profile: "default" },
  description: launcher,
  commandPath: "/fixture/trx",
  doctorSupported: false,
  inventorySupported: false,
  health: "unsupported",
  install: "unsupported",
  stale: false,
  updateCheckSupported: false,
  harnessVersionSupported: false,
  updateCheckStale: false,
})

describe("Native skills updates", () => {
  it("leaves Headlong's managed skills to synchronize on launch", () => {
    const headlong = entry("headlong")
    const copilot = entry("copilot")
    const plan = nativeSkillsUpdatePlanFor([headlong, copilot], "/fixture/trx")

    expect(plan?.targets.map(({ ref }) => ref)).toEqual([copilot.ref])
    expect(nativeSkillsUpdateCommand(headlong)).toBeUndefined()
    expect(nativeSkillsUpdateCommand(copilot)).toEqual({
      executable: "/fixture/trx",
      args: ["upgrade", "copilot", "default", "--skills-only"],
    })
  })
})
