// The chat diffs need web-foldkit/patches/@plana-solutions+agent-interface+*.patch. This fails when the installed
// package lacks it (installed with --ignore-scripts, or an upgrade the patch no longer fits), so diffs never vanish silently.
import { describe, expect, test } from "vitest";
import timeline from "../node_modules/@plana-solutions/agent-interface/dist/features/timeline.js?raw";

describe("agent-interface patch", () => {
  test("the chat timeline renders a diff slot per tool call", () => {
    expect(timeline).toContain('h.Class("sf-tool-slot")');
    expect(timeline).toContain("...toolSlots(header.revealedSteps, h)");
  });
});
