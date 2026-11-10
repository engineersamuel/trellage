import { expect, test, vi } from "vitest";
import { mountCard } from "./openUiCard";

const PROGRAM = `root = Card([header, body, tags, buttons])
header = CardHeader("Status board", "2 workers")
body = TextContent("All **green**.")
tags = TagBlock(["fast", "cheap"])
buttons = Buttons([Button("Tell me more", @ToAssistant("Tell me more")), Button("Docs", @OpenUrl("https://example.com"))])`;

const mount = (program: string) => {
  const el = document.createElement("div");
  document.body.append(el);
  const onFollowUp = vi.fn();
  const stop = mountCard(el, program, onFollowUp);
  return { el, onFollowUp, stop };
};

test("a card draws OpenUI Lang with OpenUI's DOM classes, without React", async () => {
  const { el, stop } = mount(PROGRAM);
  await vi.waitFor(() => expect(el.querySelector(".openui-card")).not.toBeNull());
  expect(el.querySelector(".openui-header")?.textContent).toContain("Status board");
  expect(el.querySelector(".openui-text-content strong")?.textContent).toBe("green");
  expect(el.querySelectorAll(".openui-tag")).toHaveLength(2);
  expect(el.textContent).not.toContain("root =");
  stop();
  expect(el.childElementCount).toBe(0);
});

test("a follow-up button sends its text to the host and keeps the card", async () => {
  const { el, onFollowUp, stop } = mount(PROGRAM);
  const button = await vi.waitFor(() => {
    const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Tell me more"));
    expect(found).toBeDefined();
    return found!;
  });
  button.click();
  await vi.waitFor(() => expect(onFollowUp).toHaveBeenCalledWith("Tell me more"));
  expect(el.querySelector(".openui-card")).not.toBeNull();
  stop();
});

test("an open-url button opens a new tab", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  const { el, onFollowUp, stop } = mount(PROGRAM);
  const button = await vi.waitFor(() => {
    const found = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Docs"));
    expect(found).toBeDefined();
    return found!;
  });
  button.click();
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith("https://example.com", "_blank", ""));
  expect(onFollowUp).not.toHaveBeenCalled();
  stop();
  open.mockRestore();
});

test("a partial program does not throw", async () => {
  const { el, stop } = mount(`root = Card([header, body])\nheader = CardHeader("Half`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(el.textContent).not.toContain("root =");
  stop();
});
