// The chat diffs need web-foldkit/patches/@plana-solutions+agent-interface+*.patch. This fails when the installed
// package lacks it (installed with --ignore-scripts, or an upgrade the patch no longer fits), so diffs never vanish silently.
import { describe, expect, test } from "vitest"
import timeline from "../node_modules/@plana-solutions/agent-interface/dist/features/timeline.js?raw"
import turnLayout from "../node_modules/@plana-solutions/agent-interface/dist/client/timeline.js?raw"
import rendered from "../node_modules/@plana-solutions/agent-interface/dist/client/genui/rendered.js?raw"
import messages from "../node_modules/@plana-solutions/agent-interface/dist/features/messages.js?raw"
import sidebar from "../node_modules/@plana-solutions/agent-interface/dist/features/sidebar.js?raw"
import update from "../node_modules/@plana-solutions/agent-interface/dist/client/update.js?raw"
import threadScrollDom from "../node_modules/@plana-solutions/agent-interface/dist/client/thread-scroll-dom.js?raw"
import index from "../node_modules/@plana-solutions/agent-interface/dist/index.js?raw"
import compositeCards from "../node_modules/@plana-solutions/agent-interface/dist/features/genui/medium-card-blocks.js?raw"
import legend from "../node_modules/@plana-solutions/agent-interface/dist/features/genui/charts/legend.js?raw"
import select from "../node_modules/@plana-solutions/agent-interface/dist/features/genui/forms/select.js?raw"

describe("agent-interface patch", () => {
  test("the chat timeline renders a diff slot per tool call", () => {
    expect(timeline).toContain('h.Class("sf-tool-slot")')
    expect(timeline).toContain("...toolSlots(header.revealedSteps, h)")
  })

  test("each turn layout and the answer list are built once per messages array", () => {
    expect(turnLayout).toContain("const turnLayouts = new WeakMap();")
    expect(rendered).toContain("const answersByMessages = new WeakMap();")
  })

  test("typing reuses the message list: the composer fields are not part of its memo", () => {
    expect(messages).toContain("software-factory patch: messages memo")
    expect(update).toContain("software-factory patch: keep equal state")
    expect(sidebar).toContain("software-factory patch: sidebar memo")
  })

  test("a user bubble does not read its layout on mount", () => {
    expect(threadScrollDom).toContain("software-factory patch: no read on mount")
  })

  test("OpenUI cards draw outside the chat, as OpenUI's React renderer draws them", () => {
    expect(index).toContain('export { genUiCardView } from "./features/genui/card.js";')
    expect(compositeCards).toContain('isElementOf(node, ["AreaChart", "BarChart", "LineChart"])')
    expect(legend).toContain('[percentage.toFixed(1), "%"]')
    expect(select).toContain('position: "absolute"')
  })
})
