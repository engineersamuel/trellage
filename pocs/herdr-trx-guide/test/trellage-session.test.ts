import assert from "node:assert/strict"
import test from "node:test"

import {
  TrellageSessionIdentityError,
  trellageSessionIdentity,
} from "../lib/trellage-session.ts"

test("parses Native pane metadata", () => {
  assert.deepEqual(
    trellageSessionIdentity({
      agent: "codex",
      processInfo: { foreground_process_group_id: 4242 },
      tokens: {
        trellage_surface: "native",
        trellage_agent: "codex",
        trellage_profile: "rpi",
        trellage_session_id: "99999999-9999-4999-8999-999999999999",
        trellage_pgrp: "4242",
      },
    }),
    {
      surface: "native",
      agent: "codex",
      profile: "rpi",
      sessionId: "99999999-9999-4999-8999-999999999999",
      processGroup: 4242,
    },
  )
})

test("rejects incomplete, mismatched, and malformed Trellage metadata", () => {
  assert.throws(
    () => trellageSessionIdentity({ agent: "copilot", tokens: { trellage_profile: "hve" } }),
    TrellageSessionIdentityError,
  )
  assert.throws(
    () =>
      trellageSessionIdentity({
        agent: "copilot",
        tokens: {
          trellage_surface: "native",
          trellage_agent: "codex",
          trellage_profile: "hve",
          trellage_session_id: "session",
        },
      }),
    /does not match/u,
  )
  assert.throws(
    () =>
      trellageSessionIdentity({
        agent: "claude",
        processInfo: { foreground_process_group_id: 4444 },
        tokens: {
          trellage_surface: "unknown",
          trellage_agent: "claude",
          trellage_profile: "claude-research",
          trellage_session_id: "session",
          trellage_pgrp: "4444",
        },
      }),
    /unsupported surface/u,
  )
  assert.throws(
    () =>
      trellageSessionIdentity({
        agent: "claude",
        processInfo: { foreground_process_group_id: 5555 },
        tokens: {
          trellage_surface: "native",
          trellage_agent: "claude",
          trellage_profile: "claude-research",
          trellage_session_id: "session",
          trellage_pgrp: "5554",
        },
      }),
    /does not match the focused process/u,
  )
})

test("ignores panes without Trellage metadata", () => {
  assert.equal(trellageSessionIdentity({ agent: "copilot" }), undefined)
  assert.equal(trellageSessionIdentity({ agent: "copilot", tokens: { model: "gpt" } }), undefined)
})
