import CoreGraphics
import Darwin
import Foundation
import Testing
@testable import OverlayCore

@Suite struct PlacementAndProtocolTests {
    @Test func placesAboveAndClampsAtDisplayEdges() {
        let display = CGRect(x: 0, y: 0, width: 1200, height: 800)
        #expect(PanelPlacement.frame(
            selection: CGRect(x: 500, y: 300, width: 100, height: 20),
            panelSize: CGSize(width: 300, height: 56),
            visibleFrames: [display]
        ) == CGRect(x: 400, y: 328, width: 300, height: 56))
        #expect(PanelPlacement.frame(
            selection: CGRect(x: 5, y: 760, width: 30, height: 20),
            panelSize: CGSize(width: 300, height: 56),
            visibleFrames: [display]
        ) == CGRect(x: 0, y: 696, width: 300, height: 56))
    }

    @Test func usesDisplayContainingSelectionCenter() {
        let left = CGRect(x: -1000, y: 0, width: 1000, height: 700)
        let main = CGRect(x: 0, y: 0, width: 1200, height: 800)
        let frame = PanelPlacement.frame(
            selection: CGRect(x: -950, y: 100, width: 40, height: 20),
            panelSize: CGSize(width: 300, height: 56),
            visibleFrames: [main, left]
        )
        #expect(frame == CGRect(x: -1000, y: 128, width: 300, height: 56))
    }

    @Test func convertsQuartzCoordinatesToAppKitCoordinates() {
        #expect(PanelPlacement.appKitRect(
            fromQuartz: CGRect(x: 100, y: 50, width: 40, height: 20),
            mainDisplayHeight: 900
        ) == CGRect(x: 100, y: 830, width: 40, height: 20))
    }

    @Test func buildsStrictNewlineDelimitedSocketEnvelope() throws {
        let data = try HerdrEnvelope.makeRequest(
            id: "request-1",
            method: "session.snapshot",
            params: [:]
        )
        #expect(data.last == 0x0A)
        let object = try #require(
            JSONSerialization.jsonObject(with: data.dropLast()) as? [String: Any]
        )
        #expect(object["id"] as? String == "request-1")
        #expect(object["method"] as? String == "session.snapshot")
    }

    @Test func parsesSuccessAndRejectsWrongEnvelopeId() throws {
        let response = Data(#"{"id":"one","result":{"type":"ok"}}"#.utf8)
        #expect(
            try HerdrEnvelope.parseResponse(data: response, expectedId: "one")["type"] as? String
                == "ok"
        )
        #expect(throws: OverlayError.self) {
            try HerdrEnvelope.parseResponse(data: response, expectedId: "two")
        }
    }

    @Test func peerCloseReturnsTransportErrorWithoutSigpipeTermination() throws {
        var descriptors = [Int32](repeating: -1, count: 2)
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0)
        defer {
            if descriptors[0] >= 0 { close(descriptors[0]) }
            if descriptors[1] >= 0 { close(descriptors[1]) }
        }
        try HerdrSocketClient.UnixSocketSafety.configureNoSigPipe(descriptors[0])
        close(descriptors[1])
        descriptors[1] = -1
        #expect(throws: OverlayError.self) {
            try HerdrSocketClient.UnixSocketSafety.writeAll(
                Data("request\n".utf8),
                to: descriptors[0]
            )
        }
    }

    @Test func parsesFocusedContextAndRequiresOneFocusedPane() throws {
        let result: [String: Any] = [
            "type": "session_snapshot",
            "snapshot": [
                "focused_workspace_id": "w1",
                "focused_tab_id": "w1:t1",
                "focused_pane_id": "w1:p1",
                "workspaces": [[
                    "workspace_id": "w1",
                    "active_tab_id": "w1:t1",
                    "focused": true,
                ]],
                "tabs": [[
                    "tab_id": "w1:t1",
                    "workspace_id": "w1",
                    "focused": true,
                ]],
                "panes": [[
                    "pane_id": "w1:p1",
                    "workspace_id": "w1",
                    "tab_id": "w1:t1",
                    "focused": true,
                    "foreground_cwd": "/repo",
                    "agent": "copilot",
                    "terminal_title_stripped": "Review code",
                ]],
            ],
        ]
        #expect(try HerdrResponseParser.sourceContext(from: result) == SourceContext(
            workspaceId: "w1",
            tabId: "w1:t1",
            paneId: "w1:p1",
            cwd: "/repo",
            agent: "copilot",
            paneTitle: "Review code"
        ))
    }

    @Test func parsesExactActionLogAndSafeStdout() throws {
        let invocation: [String: Any] = [
            "type": "plugin_action_invoked",
            "log": ["log_id": "plugin-log-9", "status": "running"],
        ]
        #expect(try HerdrResponseParser.invokedLog(from: invocation) == .init(
            logId: "plugin-log-9",
            status: "running",
            stdout: nil,
            error: nil
        ))
        let listed: [String: Any] = [
            "type": "plugin_log_list",
            "logs": [
                ["log_id": "other", "status": "failed"],
                ["log_id": "plugin-log-9", "status": "succeeded", "stdout": "{}"],
            ],
        ]
        #expect(try HerdrResponseParser.exactLog(id: "plugin-log-9", from: listed) == .init(
            logId: "plugin-log-9",
            status: "succeeded",
            stdout: "{}",
            error: nil
        ))
        let stdout = """
        {"schemaVersion":1,"requestId":"abc","queued":true,"opened":false,"queueCount":4}
        """
        #expect(try HerdrResponseParser.safeActionResult(stdout: stdout, requestId: "abc")
            == SafeActionResult(
                schemaVersion: 1,
                requestId: "abc",
                queued: true,
                opened: false,
                queueCount: 4
            ))
        #expect(throws: OverlayError.self) {
            try HerdrResponseParser.safeActionResult(stdout: stdout, requestId: "other")
        }
        #expect(throws: OverlayError.self) {
            try HerdrResponseParser.safeActionResult(
                stdout: stdout.dropLast() + #","extra":true}"#,
                requestId: "abc"
            )
        }
    }
}
