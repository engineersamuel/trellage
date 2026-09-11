import { describe, expect, it } from "vitest"
import {
  ConversationAgent,
  ConversationRole,
  ConversationSurface,
  sanitizeConversationSnapshot,
  sanitizeConversationText,
  type ConversationSnapshot,
} from "../src/index.js"

const token = "ghp_".concat("abcdefghijklmnopqrstuvwxyz1234")
const pem = (label: string, body: string, complete = true) =>
  `-----BEGIN ${label}-----${body}${complete ? `-----END ${label}-----` : ""}`

const snapshot = (messages: ConversationSnapshot["messages"]): ConversationSnapshot => ({
  schemaVersion: 1,
  id: "c909793f-e80d-4f74-b92c-d59676ae9fb4",
  source: {
    serverId: "server-1",
    surface: ConversationSurface.Host,
    agent: ConversationAgent.Copilot,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    paneId: "workspace-1:pane-1",
    cwd: "/work/search",
  },
  capturedAt: "2026-09-09T21:02:09.441Z",
  cutoff: { messageId: "message-2", recordIndex: 2 },
  revision: "a".repeat(64),
  messages,
  coverage: { complete: true, notices: [] },
})

describe("sanitizeConversationText", () => {
  it("preserves ordinary prose and removes terminal controls", () => {
    const result = sanitizeConversationText("Hello\tworld\nnext\r\u001b[31mred\u001b[0m\u001b]8;;https://secret.example\u0007link")

    expect(result).toEqual({
      text: "Hello\tworld\nnext\rredlink",
      credentialsRedacted: false,
      controlsRemoved: true,
    })
  })

  it("redacts recognized credentials without dropping surrounding content", () => {
    const text = [
      `prefix ${token} suffix`,
      'json: {"api_key":"0123456789ab"}',
      "github_pat_".concat("abcdefghijklmnopqrstuvwxyz1234"),
      pem("RSA PRIVATE KEY", "\nsecret bytes", false),
    ].join("\n")

    const result = sanitizeConversationText(text)

    expect(result.credentialsRedacted).toBe(true)
    expect(result.text).toContain("prefix [REDACTED credential] suffix")
    expect(result.text).toContain('json: {"api_key":"[REDACTED credential]"}')
    expect(result.text).toContain("[REDACTED private key]")
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz1234")
    expect(result.text).not.toContain("secret bytes")
  })

  it("preserves prose after closed keys and redacts multiple keys", () => {
    const text = `before ${pem("PRIVATE KEY", "one")} middle ${pem("EC PRIVATE KEY", "two")} after`
    const result = sanitizeConversationText(text)

    expect(result.text).toBe("before [REDACTED private key] middle [REDACTED private key] after")
  })

  it("redacts punctuation-bearing quoted assigned credentials completely", () => {
    const result = sanitizeConversationText('password="Abcd12345678!rest"')
    const singleQuoted = sanitizeConversationText("password='Abcd12345678\"rest'")
    const escapedDouble = sanitizeConversationText('password="Abcd12345678\\\"rest"')
    const escapedSingle = sanitizeConversationText("password='Abcd12345678\\'rest'")

    expect(result.text).toBe('password="[REDACTED credential]"')
    expect(singleQuoted.text).toBe("password='[REDACTED credential]'")
    expect(escapedDouble.text).toBe('password="[REDACTED credential]"')
    expect(escapedSingle.text).toBe("password='[REDACTED credential]'")
  })

  it("recognizes NFKC-equivalent credential prefixes", () => {
    const result = sanitizeConversationText("ｇｈｐ＿abcdefghijklmnopqrstuvwxyz1234")

    expect(result.text).toBe("[REDACTED credential]")
  })

  it("handles decorated credentials and is idempotent", () => {
    const input = "api_key=\u001b[2m0123456789ab\u001b[0m"
    const once = sanitizeConversationText(input)
    const twice = sanitizeConversationText(once.text)

    expect(once.text).toBe("api_key=[REDACTED credential]")
    expect(once.controlsRemoved).toBe(true)
    expect(twice).toEqual({ text: once.text, credentialsRedacted: false, controlsRemoved: false })
  })
})

describe("sanitizeConversationSnapshot", () => {
  it("keeps evidence identity and records deduplicated coverage notices", () => {
    const original = snapshot([
      { id: "message-1", role: ConversationRole.User, text: `send ${token}`, recordIndex: 0 },
      { id: "message-2", role: ConversationRole.Assistant, text: "\u001b[31mDone\u001b[0m", recordIndex: 2 },
    ])

    const sanitized = sanitizeConversationSnapshot(original)

    expect(sanitized.id).toBe(original.id)
    expect(sanitized.source).toBe(original.source)
    expect(sanitized.cutoff).toBe(original.cutoff)
    expect(sanitized.revision).toBe(original.revision)
    expect(sanitized.messages.map(({ id }) => id)).toEqual(["message-1", "message-2"])
    expect(sanitized.messages[0]?.text).toBe("send [REDACTED credential]")
    expect(sanitized.messages[1]?.text).toBe("Done")
    expect(sanitized.coverage.complete).toBe(false)
    expect(sanitized.coverage.notices).toEqual([
      "Conversation credentials were redacted.",
      "Terminal control sequences were removed.",
    ])
    expect(sanitizeConversationSnapshot(sanitized)).toEqual(sanitized)
  })

  it("returns an unchanged snapshot when no sanitization is needed", () => {
    const original = snapshot([
      { id: "message-1", role: ConversationRole.User, text: "Hello", recordIndex: 0 },
      { id: "message-2", role: ConversationRole.Assistant, text: "Done", recordIndex: 2 },
    ])

    expect(sanitizeConversationSnapshot(original)).toEqual(original)
  })
})
