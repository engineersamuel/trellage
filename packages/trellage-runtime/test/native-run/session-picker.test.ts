import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  listCopilotSessions,
  parseSessionSelection,
  type CopilotSession,
} from "../../src/native-run/session-picker.ts"
import { cleanupFixtures, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const writeSession = async (
  stateRoot: string,
  session: { id: string; cwd: string; updatedAt: string; message: string },
): Promise<void> => {
  const directory = path.join(stateRoot, session.id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, "workspace.yaml"),
    `id: ${session.id}\ncwd: ${session.cwd}\ncreated_at: 2026-01-01T00:00:00.000Z\nupdated_at: ${session.updatedAt}\n`,
  )
  await writeFile(
    path.join(directory, "events.jsonl"),
    [
      JSON.stringify({ type: "session.start", timestamp: "2026-01-01T00:00:00.000Z", data: {} }),
      JSON.stringify({ type: "user.message", timestamp: session.updatedAt, data: { content: session.message } }),
    ].join("\n"),
  )
}

test("lists only Copilot sessions from this composition and working directory, newest first", async () => {
  const root = await tempRoot("copilot-session-picker")
  const ownerHome = path.join(root, "composition")
  const stateRoot = path.join(ownerHome, "state", "session-state")
  const workspace = path.join(root, "work")
  await writeSession(stateRoot, {
    id: "older",
    cwd: workspace,
    updatedAt: "2026-10-15T10:00:00.000Z",
    message: "First older request\nwith detail",
  })
  await writeSession(stateRoot, {
    id: "newer",
    cwd: workspace,
    updatedAt: "2026-10-16T10:00:00.000Z",
    message: "First newer request",
  })
  await writeSession(stateRoot, {
    id: "other-worktree",
    cwd: path.join(root, "other"),
    updatedAt: "2026-10-17T10:00:00.000Z",
    message: "Do not list me",
  })

  expect(await listCopilotSessions(ownerHome, workspace)).toEqual([
    {
      id: "newer",
      cwd: workspace,
      timestamp: "2026-10-16T10:00:00.000Z",
      firstUserMessage: "First newer request",
    },
    {
      id: "older",
      cwd: workspace,
      timestamp: "2026-10-15T10:00:00.000Z",
      firstUserMessage: "First older request with detail",
    },
  ] satisfies CopilotSession[])
})

test("empty, q, Escape, and Ctrl-C cancel session selection", () => {
  for (const input of ["", "q", "Q", "\u001b", "\u0003"]) {
    expect(parseSessionSelection(input, 2)).toEqual({ kind: "cancelled" })
  }
  expect(parseSessionSelection("2", 2)).toEqual({ kind: "selected", index: 1 })
  expect(parseSessionSelection("3", 2)).toEqual({ kind: "invalid" })
})
