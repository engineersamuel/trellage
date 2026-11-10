import { expect, test } from "vitest";
import type { Thread } from "../../shared/schemas";
import { chatThreads } from "./threads";

test("the chat lists conversations and started drafts, not unstarted drafts", () => {
  const draft = (startedAt?: number) => ({ versions: [], current: "v1", reports: [], ...(startedAt ? { startedAt } : {}) });
  const threads: ReadonlyArray<Thread> = [
    { id: "a", title: "General", createdAt: 1, folderId: "general" },
    { id: "b", title: "Add retries", createdAt: 2, folderId: "r", draft: draft() },
    { id: "c", title: "Started draft", createdAt: 3, folderId: "r", draft: draft(5) },
  ];
  expect(chatThreads(threads).map((t) => t.id)).toEqual(["a", "c"]);
});
