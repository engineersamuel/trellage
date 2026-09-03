import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { findTrellageRoot } from "./trellage-root.ts"

const execFileAsync = promisify(execFile)
export const sandboxBridgeMaximumOutputBytes = 512 * 1024

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const parseBridgeResult = (source, identity) => {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("The Trellage Sandbox session bridge returned invalid JSON.")
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.agent !== identity.agent ||
    value.profile !== identity.profile ||
    typeof value.session_id !== "string" ||
    value.session_id.length === 0 ||
    typeof value.answer !== "string" ||
    value.answer.trim().length === 0
  ) {
    throw new Error("The Trellage Sandbox session bridge returned mismatched session data.")
  }
  return value
}

const defaultBridgeRunner = async ({ identity, env, cwd }) => {
  const repositoryRoot = await findTrellageRoot(import.meta.dirname)
  const command = path.join(repositoryRoot, "prototypes", "trellage", "trellage")
  const args = [
    "--profile",
    identity.profile,
    "session",
    "final-message",
    "--agent",
    identity.agent,
    "--container-id",
    identity.containerId,
    "--invocation",
    identity.invocationId,
  ]
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: sandboxBridgeMaximumOutputBytes,
      timeout: 30_000,
    })
    return result.stdout
  } catch (error) {
    const detail = typeof error?.stderr === "string" ? error.stderr.trim() : ""
    throw new Error(detail || "The Trellage Sandbox session bridge could not read the completed result.")
  }
}

export const captureSandboxFinalMessage = async ({
  identity,
  cwd,
  env = process.env,
  bridgeRunner = defaultBridgeRunner,
}) => {
  const value = parseBridgeResult(await bridgeRunner({ identity, env, cwd }), identity)
  return {
    text: value.answer,
    source: "sandbox-transcript",
    agent: identity.agent,
    sessionId: value.session_id,
    identitySource: "trellage-sandbox-bridge",
    profile: identity.profile,
  }
}
