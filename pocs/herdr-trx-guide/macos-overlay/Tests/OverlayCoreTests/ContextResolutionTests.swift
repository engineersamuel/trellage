import Foundation
import Testing
@testable import OverlayCore

private final class ContextHerdrStub: HerdrRequesting {
    var results: [[String: Any]]
    let events: ContextEventRecorder?

    init(_ results: [[String: Any]], events: ContextEventRecorder? = nil) {
        self.results = results
        self.events = events
    }

    func request(method: String, params: [String: Any]) throws -> [String: Any] {
        events?.values.append(method)
        return results.removeFirst()
    }
}

private final class WindowProofStub: WindowIdentityProving {
    let identity: SourceWindowIdentity
    let events: ContextEventRecorder?

    init(_ identity: SourceWindowIdentity, events: ContextEventRecorder? = nil) {
        self.identity = identity
        self.events = events
    }

    func prove() throws -> SourceWindowIdentity {
        events?.values.append("window-proof")
        return identity
    }
}

private final class ContextEventRecorder {
    var values: [String] = []
}

@Suite struct ContextResolutionTests {
    private let window = SourceWindowIdentity(processId: 1, windowNumber: 2)

    @Test func acceptsStablePreAndPostProofContext() throws {
        let events = ContextEventRecorder()
        let resolver = StableHerdrContextResolver(
            herdr: ContextHerdrStub([
                snapshot(workspace: "w1", tab: "w1:t1", pane: "w1:p1", cwd: "/repo"),
                snapshot(workspace: "w1", tab: "w1:t1", pane: "w1:p1", cwd: "/repo"),
            ], events: events),
            windowProof: WindowProofStub(window, events: events)
        )
        let resolved = try resolver.resolve()
        #expect(resolved.window == window)
        #expect(resolved.source.paneId == "w1:p1")
        #expect(events.values == [
            "session.snapshot",
            "window-proof",
            "session.snapshot",
        ])
    }

    @Test func rejectsPaneChangeAcrossWindowProof() {
        let resolver = StableHerdrContextResolver(
            herdr: ContextHerdrStub([
                snapshot(workspace: "w1", tab: "w1:t1", pane: "w1:p1", cwd: "/repo"),
                snapshot(workspace: "w1", tab: "w1:t1", pane: "w1:p2", cwd: "/repo"),
            ]),
            windowProof: WindowProofStub(window)
        )
        #expect(throws: OverlayError.contextChanged) {
            try resolver.resolve()
        }
    }

    @Test func interveningInputGenerationOrWindowChangeRejectsCommit() {
        #expect(SelectionResolutionValidity.canCommit(
            startedGeneration: 4,
            currentGeneration: 4,
            mouseUpWindow: window,
            provenWindow: window
        ))
        #expect(!SelectionResolutionValidity.canCommit(
            startedGeneration: 4,
            currentGeneration: 5,
            mouseUpWindow: window,
            provenWindow: window
        ))
        #expect(!SelectionResolutionValidity.canCommit(
            startedGeneration: 4,
            currentGeneration: 4,
            mouseUpWindow: window,
            provenWindow: SourceWindowIdentity(processId: 1, windowNumber: 3)
        ))
    }

    private func snapshot(
        workspace: String,
        tab: String,
        pane: String,
        cwd: String
    ) -> [String: Any] {
        [
            "type": "session_snapshot",
            "snapshot": [
                "focused_workspace_id": workspace,
                "focused_tab_id": tab,
                "focused_pane_id": pane,
                "workspaces": [[
                    "workspace_id": workspace,
                    "active_tab_id": tab,
                    "focused": true,
                ]],
                "tabs": [[
                    "tab_id": tab,
                    "workspace_id": workspace,
                    "focused": true,
                ]],
                "panes": [[
                    "pane_id": pane,
                    "workspace_id": workspace,
                    "tab_id": tab,
                    "focused": true,
                    "foreground_cwd": cwd,
                ]],
            ],
        ]
    }
}
