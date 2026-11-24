import { NativeRunError } from "./paths.ts"
import { executableOnPath } from "./requirements.ts"

const proxy = "http://127.0.0.1:8080"

// Takes only what it reads, so adapters.ts can call it without an import cycle.
export const admitWindowsClaude = async <Launch extends { readonly command: string }>(
  environment: NodeJS.ProcessEnv,
  planned: Launch,
): Promise<Launch> => {
  const binary = await executableOnPath(planned.command, environment)
  if (!binary || !/\.(exe|com)$/i.test(binary))
    throw new NativeRunError(
      "prerequisite",
      "native Windows Claude requires a Claude Code .exe on PATH or TRELLAGE_CLAUDE_BIN",
    )
  try {
    const health = await fetch(`${proxy}/health`, { signal: AbortSignal.timeout(5000) })
    const status: unknown = await health.json()
    if (!health.ok || !status || typeof status !== "object" || !("status" in status) || status.status !== "ok")
      throw new Error("proxy health check did not report ok")
    const response = await fetch(`${proxy}/v1/models`, { signal: AbortSignal.timeout(5000) })
    const body: unknown = await response.json()
    if (!response.ok || !body || typeof body !== "object" || !("data" in body) || !Array.isArray(body.data))
      throw new Error("proxy returned an invalid model catalog")
    const ids = new Set(
      body.data.flatMap((entry: unknown) =>
        entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" ? [entry.id] : [],
      ),
    )
    for (const id of ["claude-sonnet-5.5", "claude-opus-5.5"])
      if (!ids.has(id)) throw new Error(`proxy does not advertise ${id}`)
  } catch (cause) {
    throw new NativeRunError(
      "prerequisite",
      `Claude proxy at ${proxy}: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  return { ...planned, command: binary }
}
