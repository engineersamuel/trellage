import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { parseFirstmateInstanceControlContextV1 } from "@trellage/guide-core"
import { captureFixture, historyRecords, sessionId, writeHarnessHistory } from "./conversation-fixtures.ts"

const wire = JSON.parse(readFileSync(
  new URL("../../../../packages/trellage-guide-core/test/fixtures/firstmate-instances-v1.json", import.meta.url), "utf8",
))
export const firstmateOrigin = parseFirstmateInstanceControlContextV1({
  ...wire.controlContext,
  reference: { ...wire.controlContext.reference, instanceId: "33333333-3333-4333-8333-333333333333" },
})
export const legacyOrigin = parseFirstmateInstanceControlContextV1(wire.legacyControlContext)
export const firstmateTokens = (origin = firstmateOrigin, id = sessionId) => ({
  trellage_surface: "native", trellage_agent: "claude", trellage_profile: origin.reference.profile,
  trellage_session_id: id, trellage_pgrp: "12345",
  trellage_firstmate_instance_id: origin.reference.instanceId,
  trellage_firstmate_launch_origin: JSON.stringify(origin),
})
export const captainHome = (home: string, origin = firstmateOrigin): string => {
  const root = path.join(home, ".local", "share", "trellage", "profiles", "firstmate")
  return origin.reference.mode === "named"
    ? path.join(root, "instances", origin.reference.instanceId, "captain", "claude")
    : path.join(root, origin.reference.profile, "captain", "claude")
}
export const firstmateCaptureFixture = async (t, origin = firstmateOrigin) => {
  const fixture = await captureFixture(t, "claude")
  const home = captainHome(fixture.root, origin)
  const cwd = path.resolve(home, "..", "..", "runtime")
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  fixture.context.cwd = cwd
  fixture.agentInfo.cwd = cwd
  fixture.agentInfo.tokens = firstmateTokens(origin)
  const records = historyRecords("claude", cwd)
  const transcriptPath = await writeHarnessHistory(home, "claude", cwd, records)
  return { ...fixture, cwd, home, records, transcriptPath, origin }
}
