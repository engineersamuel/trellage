import { describe, expect, test } from "vitest";
import { startToolDiffs } from "../../shared/diffview";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("chat tool diffs", () => {
  test("a tool slot with an edit gets its diff; a read-only call stays empty", async () => {
    startToolDiffs();
    const slot = (tool: object) => {
      const e = document.createElement("div");
      e.className = "sf-tool-slot";
      e.dataset.sfTool = JSON.stringify(tool);
      document.body.append(e);
      return e;
    };
    const edit = slot({ name: "edit", args: JSON.stringify({ path: "a.ts", old_str: "x", new_str: "y" }), result: "ok" });
    const view = slot({ name: "view", args: "{}", result: "1. x" });
    await tick();
    expect(edit.className).toBe("sf-tool-slot");
    expect(edit.querySelectorAll(".dv-row.add, .dv-row.del").length).toBe(2);
    expect(view.children.length).toBe(0);
  });
});
