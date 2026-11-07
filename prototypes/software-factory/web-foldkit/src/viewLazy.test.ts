import { Effect, Option } from "effect";
import { AsyncData } from "foldkit";
import { modifyFields } from "foldkit/struct";
import { Lazy } from "foldkit/test";
import * as Url from "foldkit/url";
import { NO_ARTIFACTS, ThemeSetting, memoryNavigation, readFlags } from "@plana-solutions/agent-interface";
import { describe, expect, test, vi } from "vitest";
import type { Decision } from "../../shared/approvals";
import { chat } from "./chatProgram";
import type { Model } from "./model";
import { document } from "./settings/fixture";
import { init } from "./update";
import { view } from "./view";

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
);
const url = Option.getOrThrow(Url.fromString("http://localhost/"));
const loaded: Model = modifyFields(init(flags, url, Option.none()).model, {
  settings: modifyFields({ document: () => AsyncData.succeed(document) }),
});
const approval: Decision = {
  id: "d1", kind: "approval", threadId: null, title: "Ship?", summary: "", options: [], optionDetails: [], allowText: false,
  context: "coordinator", status: "pending", answer: null, note: null, createdAt: 1, topic: "other",
};

describe("root view memo", () => {
  test("an unchanged Model reuses every lazy slot", () => {
    Lazy.expectAllReused({ view, model: loaded });
  });

  // The chat (every message, markdown) is the most costly subtree: worker, panel and approvals changes must not rebuild it.
  test("a Model that differs only outside the chat does not render the chat again", () => {
    const chatView = vi.spyOn(chat, "view");
    // A new chat object misses the slot cache once, whatever an earlier test cached.
    const base = modifyFields(loaded, { chat: (current) => ({ ...current }) });
    const other = modifyFields(base, { approvals: () => [approval], workerPanel: modifyFields({ messageDraft: () => "x" }) });
    let renders = 0;
    const twoModels = (model: Model, h: Parameters<typeof view>[1]) => view(renders++ === 0 ? model : other, h);
    // The navbar and panel slots miss (their inputs changed); the chat slot must hit.
    expect(() => Lazy.expectAllReused({ view: twoModels, model: base })).toThrow(/ArgumentsChanged/);
    expect(chatView).toHaveBeenCalledTimes(1);
    chatView.mockRestore();
  });
});
