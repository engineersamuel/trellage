import { Effect, Option } from "effect"
import { AsyncData } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { Lazy } from "foldkit/test"
import * as Url from "foldkit/url"
import {
  Message as ChatMessage,
  NO_ARTIFACTS,
  ThemeSetting,
  memoryNavigation,
  readFlags,
} from "@plana-solutions/agent-interface"
import { describe, expect, test, vi } from "vitest"
import type { Decision } from "../../shared/approvals"
import { chat } from "./chatProgram"
import type { Model } from "./model"
import { document } from "./settings/fixture"
import { init } from "./update"
import { view } from "./view"

const flags = Effect.runSync(
  readFlags({
    agentName: "test",
    artifacts: NO_ARTIFACTS,
    componentLibrary: "openuiChat",
    maybeStarterVariant: Option.none(),
    maybeWelcome: Option.none(),
    navigation: memoryNavigation,
    placeholder: "",
    starters: [],
    theme: ThemeSetting.Fixed({ mode: "dark" }),
  }),
)
const url = Option.getOrThrow(Url.fromString("http://localhost/"))
const loaded: Model = modifyFields(init(flags, url, Option.none()).model, {
  settings: modifyFields({ document: () => AsyncData.succeed(document) }),
})
const approval: Decision = {
  id: "d1",
  kind: "approval",
  threadId: null,
  title: "Ship?",
  summary: "",
  options: [],
  optionDetails: [],
  allowText: false,
  context: "coordinator",
  status: "pending",
  answer: null,
  note: null,
  createdAt: 1,
  answeredAt: null,
  answeredBy: null,
  topic: "other",
}

describe("root view memo", () => {
  test("an unchanged Model reuses every lazy slot", () => {
    expect(() => Lazy.expectAllReused({ view, model: loaded })).not.toThrow()
  })

  // The chat (every message, markdown) is the most costly subtree: worker and approvals changes must not rebuild it.
  test("a Model that differs only outside the chat does not render the chat again", () => {
    const chatView = vi.spyOn(chat, "view")
    // A new chat object misses the slot cache once, whatever an earlier test cached.
    const base = modifyFields(loaded, { chat: (current) => ({ ...current }) })
    const other = modifyFields(base, {
      approvals: () => [approval],
      workers: modifyFields({ workers: () => AsyncData.succeed([]) }),
    })
    let renders = 0
    const twoModels = (model: Model, h: Parameters<typeof view>[1]) => view(renders++ === 0 ? model : other, h)
    // The navbar slot misses (its inputs changed); the chat slot must hit.
    expect(() => Lazy.expectAllReused({ view: twoModels, model: base })).toThrow(/ArgumentsChanged/)
    expect(chatView).toHaveBeenCalledTimes(1)
    chatView.mockRestore()
  })
})

describe("chat message list memo (agent-interface patch)", () => {
  /** The `.openui-agent-thread-messages` VNode of one render. */
  type Node = Readonly<{ data?: { class?: Record<string, boolean> }; children?: ReadonlyArray<Node | string> }>
  const findMessages = (node: Node | string | null | undefined): Node | undefined => {
    if (node === null || node === undefined || typeof node === "string") return undefined
    if (node.data?.class?.["openui-agent-thread-messages"]) return node
    for (const child of node.children ?? []) {
      const hit = findMessages(child)
      if (hit) return hit
    }
    return undefined
  }
  /** Render `first`, then `second`, in one test frame (the same builder), as the app renders two Models in a row. */
  const twoRenders = (first: Model, second: Model): [unknown, unknown] => {
    const found: unknown[] = []
    let renders = 0
    const run = (_: Model, h: Parameters<typeof view>[1]) => {
      const html = view(renders++ === 0 ? first : second, h)
      found.push(findMessages(html.body))
      return html
    }
    // Other slots may miss (the chat Model changed); this test reads the message VNodes, not the reuse report.
    try {
      Lazy.expectAllReused({ view: run, model: first })
    } catch {}
    return [found[0], found[1]]
  }

  test("typing reuses the message list; a new message rebuilds it", () => {
    const withMessages = modifyFields(loaded, {
      chat: modifyFields({ messages: () => [{ id: "m1", role: "user" as const, content: "hi" }] }),
    })
    const typed = modifyFields(withMessages, { chat: modifyFields({ composerText: () => "x" }) })
    const [before, afterTyping] = twoRenders(withMessages, typed)
    expect(before).toBeDefined()
    expect(afterTyping).toBe(before)
    const more = modifyFields(typed, {
      chat: modifyFields({
        messages: () => [...typed.chat.messages, { id: "m2", role: "user" as const, content: "again" }],
      }),
    })
    const [, afterMessage] = twoRenders(typed, more)
    expect(afterMessage).toBeDefined()
    expect(afterMessage).not.toBe(before)
  })
})

describe("chat timeline and scroll state (agent-interface patch)", () => {
  test("a keystroke keeps the timelines and scroll state the same objects", () => {
    const withMessages = modifyFields(loaded, {
      chat: modifyFields({ messages: () => [{ id: "m1", role: "user" as const, content: "hi" }] }),
    })
    const typed = chat.update(withMessages.chat, ChatMessage.UpdatedComposerText({ value: "x" })).model
    expect(typed.composerText).toBe("x")
    expect(typed.timelines).toBe(withMessages.chat.timelines)
    expect(typed.threadScroll).toBe(withMessages.chat.threadScroll)
  })
})
