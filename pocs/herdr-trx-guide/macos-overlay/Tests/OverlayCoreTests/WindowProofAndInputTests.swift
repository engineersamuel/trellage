import Foundation
import Testing
@testable import OverlayCore

private final class ProofHerdrStub: HerdrRequesting {
    var results: [Result<[String: Any], Error>]
    var calls: [(String, [String: Any])] = []

    init(_ results: [Result<[String: Any], Error>]) {
        self.results = results
    }

    func request(method: String, params: [String: Any]) throws -> [String: Any] {
        calls.append((method, params))
        return try results.removeFirst().get()
    }
}

private final class ProofWindowStub: ForegroundWindowReading {
    var observations: [Result<ForegroundWindowObservation, Error>]

    init(_ observations: [Result<ForegroundWindowObservation, Error>]) {
        self.observations = observations
    }

    func frontmostKittyWindow() throws -> ForegroundWindowObservation {
        try observations.removeFirst().get()
    }
}

@Suite struct WindowProofAndInputTests {
    private let source = SourceWindowIdentity(processId: 10, windowNumber: 20)
    private let other = SourceWindowIdentity(processId: 10, windowNumber: 21)
    private let marker = "trxg-0123456789ab"

    @Test func provesExactMarkerAndClearsOnlyTheSameMarkedWindow() throws {
        let herdr = ProofHerdrStub([
            .success(["type": "client_window_title", "changed": true, "reason": "set"]),
            .success(["type": "client_window_title", "changed": true, "reason": "cleared"]),
        ])
        let tracker = DeferredWindowMarkerTracker()
        let identity = try ForegroundClientProof(
            herdr: herdr,
            windowReader: ProofWindowStub([
                .success(.init(identity: source, title: "original")),
                .success(.init(identity: source, title: marker)),
                .success(.init(identity: source, title: marker)),
            ]),
            tracker: tracker,
            marker: { marker }
        ).prove()
        #expect(identity == source)
        #expect(tracker.pending == nil)
        #expect(herdr.calls.map(\.0) == [
            "client.window_title.set",
            "client.window_title.clear",
        ])
        #expect(herdr.calls.first?.1["title"] as? String == marker)
    }

    @Test func acknowledgedDelayedRenderCancelsOverrideOnSameWindow() {
        let herdr = ProofHerdrStub([
            .success(["type": "client_window_title", "changed": true, "reason": "set"]),
            .success(["type": "client_window_title", "changed": true, "reason": "cleared"]),
        ])
        let tracker = DeferredWindowMarkerTracker()
        var times = [
            Date(timeIntervalSince1970: 0),
            Date(timeIntervalSince1970: 1),
        ]
        #expect(throws: OverlayError.self) {
            try ForegroundClientProof(
                herdr: herdr,
                windowReader: ProofWindowStub([
                    .success(.init(identity: source, title: "original")),
                    .success(.init(identity: source, title: "wrong")),
                    .success(.init(identity: source, title: "wrong")),
                ]),
                tracker: tracker,
                now: { times.removeFirst() },
                sleep: { _ in },
                marker: { marker },
                renderTimeout: 0.3
            ).prove()
        }
        #expect(herdr.calls.map(\.0) == [
            "client.window_title.set",
            "client.window_title.clear",
        ])
        #expect(tracker.pending == nil)
    }

    @Test func focusChangeDefersClearUntilExactWindowAndMarkerReturn() {
        let herdr = ProofHerdrStub([
            .success(["type": "client_window_title", "changed": true, "reason": "set"]),
            .success(["type": "client_window_title", "changed": true, "reason": "cleared"]),
        ])
        let tracker = DeferredWindowMarkerTracker()
        #expect(throws: OverlayError.self) {
            try ForegroundClientProof(
                herdr: herdr,
                windowReader: ProofWindowStub([
                    .success(.init(identity: source, title: "original")),
                    .success(.init(identity: other, title: marker)),
                    .success(.init(identity: other, title: marker)),
                ]),
                tracker: tracker,
                marker: { marker }
            ).prove()
        }
        #expect(tracker.pending == DeferredWindowMarker(
            identity: source,
            marker: marker,
            kind: .acknowledged
        ))
        let reconciliation = ForegroundClientProof(
            herdr: herdr,
            windowReader: ProofWindowStub([
                .success(.init(identity: source, title: "old title")),
            ]),
            tracker: tracker,
            marker: { marker }
        ).reconcileDeferredMarker()
        #expect(reconciliation == .cleared)
        #expect(tracker.pending == nil)
        #expect(herdr.calls.last?.0 == "client.window_title.clear")
    }

    @Test func deferredMarkerIsDiscardedWhenOriginalWindowTitleChanged() {
        let tracker = DeferredWindowMarkerTracker()
        tracker.deferMarker(.init(identity: source, marker: marker))
        let herdr = ProofHerdrStub([])
        let result = ForegroundClientProof(
            herdr: herdr,
            windowReader: ProofWindowStub([
                .success(.init(identity: source, title: "new title")),
            ]),
            tracker: tracker,
            marker: { marker }
        ).reconcileDeferredMarker()
        #expect(result == .discarded)
        #expect(tracker.pending == nil)
        #expect(herdr.calls.isEmpty)
    }

    @Test func unresolvedDeferredMarkerBlocksAnotherProof() {
        let tracker = DeferredWindowMarkerTracker()
        tracker.deferMarker(.init(identity: source, marker: marker))
        let herdr = ProofHerdrStub([])
        #expect(throws: OverlayError.self) {
            try ForegroundClientProof(
                herdr: herdr,
                windowReader: ProofWindowStub([]),
                tracker: tracker,
                marker: { "trxg-abcdef012345" }
            ).prove()
        }
        #expect(herdr.calls.isEmpty)
    }

    @Test func definiteSetFailureDoesNotClearUnmarkedWindow() {
        let tracker = DeferredWindowMarkerTracker()
        let herdr = ProofHerdrStub([
            .failure(OverlayError.transportBeforeSend("set failed")),
        ])
        #expect(throws: OverlayError.self) {
            try ForegroundClientProof(
                herdr: herdr,
                windowReader: ProofWindowStub([
                    .success(.init(identity: source, title: "original")),
                    .success(.init(identity: source, title: "original")),
                ]),
                tracker: tracker,
                marker: { marker }
            ).prove()
        }
        #expect(herdr.calls.map(\.0) == ["client.window_title.set"])
        #expect(tracker.pending == nil)
    }

    @Test func postSendResponseLossPollsForDelayedMarkerThenClearsSafely() {
        let tracker = DeferredWindowMarkerTracker()
        let herdr = ProofHerdrStub([
            .failure(OverlayError.transportAfterSend("response lost")),
            .success(["type": "client_window_title", "changed": true, "reason": "cleared"]),
        ])
        var times = [
            Date(timeIntervalSince1970: 0),
            Date(timeIntervalSince1970: 0.1),
        ]
        #expect(throws: OverlayError.self) {
            try ForegroundClientProof(
                herdr: herdr,
                windowReader: ProofWindowStub([
                    .success(.init(identity: source, title: "original")),
                    .success(.init(identity: source, title: "original")),
                    .success(.init(identity: source, title: marker)),
                    .success(.init(identity: source, title: marker)),
                ]),
                tracker: tracker,
                now: { times.removeFirst() },
                sleep: { _ in },
                marker: { marker },
                renderTimeout: 0.3
            ).prove()
        }
        #expect(herdr.calls.map(\.0) == [
            "client.window_title.set",
            "client.window_title.clear",
        ])
        #expect(tracker.pending == nil)
    }

    @Test func actionKeyDownAndMatchingKeyUpAreTheOnlySuppressedPair() {
        var policy = PanelInputPolicy()
        #expect(policy.decide(
            event: .down,
            keyCode: 0,
            unmodified: true,
            phase: .actions
        ) == .suppress(.add))
        #expect(policy.decide(
            event: .down,
            keyCode: 0,
            unmodified: true,
            phase: .loading
        ) == .suppress(nil))
        #expect(policy.decide(
            event: .up,
            keyCode: 0,
            unmodified: true,
            phase: .loading
        ) == .suppress(nil))
        #expect(policy.decide(
            event: .up,
            keyCode: 0,
            unmodified: true,
            phase: .loading
        ) == .passThrough)
    }

    @Test func unrelatedInputPassesOrDismissesButIsNeverSwallowed() {
        var policy = PanelInputPolicy()
        #expect(policy.decide(
            event: .down,
            keyCode: 11,
            unmodified: true,
            phase: .actions
        ) == .dismissAndPassThrough)
        #expect(policy.decide(
            event: .down,
            keyCode: 0,
            unmodified: false,
            phase: .actions
        ) == .dismissAndPassThrough)
        #expect(policy.decide(
            event: .down,
            keyCode: 0,
            unmodified: true,
            phase: .loading
        ) == .passThrough)
        #expect(policy.decide(
            event: .down,
            keyCode: 11,
            unmodified: true,
            phase: .status
        ) == .passThrough)
    }

    @Test func escapeKeyUpIsSuppressedAfterDismissal() {
        var policy = PanelInputPolicy()
        #expect(policy.decide(
            event: .down,
            keyCode: 53,
            unmodified: true,
            phase: .actions
        ) == .suppress(.dismiss))
        #expect(policy.decide(
            event: .up,
            keyCode: 53,
            unmodified: true,
            phase: .hidden
        ) == .suppress(nil))
    }

    @Test func sourceFocusRequiresTheSameFrontmostKittyWindow() {
        let expected = SourceWindowIdentity(processId: 12, windowNumber: 34)
        #expect(PanelSourceFocus.isValid(
            expected: expected,
            current: expected,
            kittyIsFrontmost: true
        ))
        #expect(!PanelSourceFocus.isValid(
            expected: expected,
            current: SourceWindowIdentity(processId: 12, windowNumber: 35),
            kittyIsFrontmost: true
        ))
        #expect(!PanelSourceFocus.isValid(
            expected: expected,
            current: expected,
            kittyIsFrontmost: false
        ))
        #expect(CaptureWindowIdentityProof.matches(
            mouseUp: expected,
            proven: expected
        ))
        #expect(!CaptureWindowIdentityProof.matches(
            mouseUp: expected,
            proven: SourceWindowIdentity(processId: 12, windowNumber: 35)
        ))
    }
}
